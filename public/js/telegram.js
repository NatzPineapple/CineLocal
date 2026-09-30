// Integração com o Telegram: login, navegação por conversas e download paralelo de vídeos.
// O download padrão da biblioteca pede um pedaço por vez; aqui vários pedaços de 1 MB
// são pedidos ao mesmo tempo, o que costuma multiplicar a velocidade.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { errors } = require('telegram');
const { Logger, LogLevel } = require('telegram/extensions/Logger');
const bigInt = require('big-integer');

const CHUNK = 1024 * 1024; // máximo aceito pelo upload.getFile
const VIDEO_EXT = /\.(mp4|mkv|avi|mov|m4v|webm|wmv|ts|flv)$/i;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = function createTelegram({ root, getConfig, saveConfig, onDownloaded }) {
  const SESSION_FILE = path.join(root, 'telegram.session');
  let client = null;
  let me = null;
  let dialogsLoaded = false;
  const login = { step: 'idle', error: null, waiters: {} };
  const downloads = new Map(); // key -> job
  const thumbCache = new Map();

  // ---------- conexão / login ----------
  function creds() {
    const c = getConfig().telegram || {};
    return c.apiId && c.apiHash ? { apiId: Number(c.apiId), apiHash: String(c.apiHash) } : null;
  }

  async function connect() {
    if (client) return client;
    const c = creds();
    if (!c) throw new Error('Configure o api_id e o api_hash primeiro.');
    let saved = '';
    try { saved = (await fsp.readFile(SESSION_FILE, 'utf8')).trim(); } catch {}
    client = new TelegramClient(new StringSession(saved), c.apiId, c.apiHash, {
      connectionRetries: 5,
      baseLogger: new Logger(LogLevel.ERROR),
    });
    client.floodSleepThreshold = 120;
    await client.connect();
    if (await client.checkAuthorization()) me = await client.getMe();
    return client;
  }

  async function status() {
    if (!creds()) return { configured: false };
    try {
      await connect();
    } catch (e) {
      return { configured: true, loggedIn: false, step: login.step, error: e.message };
    }
    return {
      configured: true,
      loggedIn: !!me,
      user: me ? [me.firstName, me.lastName].filter(Boolean).join(' ') || me.username : null,
      step: login.step,
      hint: login.hint,
      error: login.error,
      threads: getConfig().telegram.threads || 8,
      autoCompress: !!getConfig().telegram.autoCompress,
    };
  }

  // O fluxo do GramJS pede telefone, código e senha via callbacks; aqui cada callback
  // espera a próxima chamada HTTP correspondente.
  const waitFor = (step) => new Promise((resolve, reject) => {
    login.step = step;
    login.waiters = { resolve, reject };
  });
  function answer(step, value) {
    if (login.step !== step || !login.waiters.resolve) throw new Error('Etapa de login inesperada');
    login.error = null;
    login.step = 'waiting';
    login.waiters.resolve(value);
  }

  async function startLogin(phone) {
    await connect();
    login.error = null;
    login.step = 'waiting';
    client.start({
      phoneNumber: async () => phone,
      phoneCode: async () => waitFor('code'),
      password: async (hint) => { login.hint = hint || ''; return waitFor('password'); },
      onError: async (e) => {
        login.error = /PHONE_CODE_INVALID/.test(e.message) ? 'Código incorreto, tente de novo.'
          : /PASSWORD_HASH_INVALID/.test(e.message) ? 'Senha incorreta, tente de novo.'
          : /PHONE_NUMBER_INVALID/.test(e.message) ? 'Número inválido. Use o formato +55 11 91234-5678.'
          : e.message;
        if (/PHONE_NUMBER_INVALID|API_ID_INVALID/.test(e.message)) { login.step = 'idle'; return true; }
        return false; // deixa o GramJS pedir de novo
      },
    }).then(async () => {
      me = await client.getMe();
      await fsp.writeFile(SESSION_FILE, client.session.save());
      login.step = 'done';
    }).catch((e) => { login.step = 'idle'; login.error = login.error || e.message; });
    // espera até o Telegram pedir o código (ou dar erro)
    for (let i = 0; i < 60 && login.step === 'waiting'; i++) await sleep(250);
  }

  async function logout() {
    for (const j of downloads.values()) j.cancel?.();
    try { if (client && me) await client.invoke(new Api.auth.LogOut()); } catch {}
    try { await client?.disconnect(); } catch {}
    client = null; me = null; dialogsLoaded = false;
    login.step = 'idle';
    await fsp.rm(SESSION_FILE, { force: true });
  }

  async function reset() {
    try { await client?.disconnect(); } catch {}
    client = null; me = null; dialogsLoaded = false;
  }

  function requireLogin() {
    if (!client || !me) throw new Error('Faça login no Telegram primeiro.');
  }

  // Os IDs numéricos (-100…) só são resolvidos depois que as conversas estão em cache.
  async function ensureDialogs() {
    if (dialogsLoaded) return;
    await client.getDialogs({ limit: 300 });
    dialogsLoaded = true;
  }

  async function resolvePeer(peer) {
    if (/^-?\d+$/.test(String(peer))) { await ensureDialogs(); return client.getInputEntity(BigInt(peer).toString()); }
    return client.getInputEntity(peer);
  }

  // ---------- navegação ----------
  async function chats(q = '') {
    requireLogin();
    const list = await client.getDialogs({ limit: 300 });
    dialogsLoaded = true;
    q = q.toLowerCase();
    return list
      .filter((d) => d.id != null && (!q || (d.title || '').toLowerCase().includes(q)))
      .slice(0, 150)
      .map((d) => ({
        id: d.id.toString(),
        title: d.id.toString() === me.id.toString() ? 'Mensagens salvas' : d.title || '(sem nome)',
        type: d.isChannel && !d.isGroup ? 'canal' : d.isGroup ? 'grupo' : 'pessoa',
      }));
  }

  function videoInfo(msg) {
    const doc = msg?.media?.document;
    if (!(doc instanceof Api.Document)) return null;
    const fileAttr = doc.attributes.find((a) => a instanceof Api.DocumentAttributeFilename);
    const vidAttr = doc.attributes.find((a) => a instanceof Api.DocumentAttributeVideo);
    const isVideo = /^video\//.test(doc.mimeType) || vidAttr || VIDEO_EXT.test(fileAttr?.fileName || '');
    if (!isVideo || vidAttr?.roundMessage) return null;
    const ext = fileAttr?.fileName?.match(/\.\w+$/)?.[0] || (doc.mimeType === 'video/x-matroska' ? '.mkv' : '.mp4');
    const caption = (msg.message || '').split('\n')[0].trim();
    const name = fileAttr?.fileName || (caption ? caption.slice(0, 120) + ext : `telegram_${msg.id}${ext}`);
    return {
      id: msg.id, name, size: Number(doc.size), duration: vidAttr?.duration || 0,
      width: vidAttr?.w || 0, height: vidAttr?.h || 0,
      caption: (msg.message || '').slice(0, 300), date: msg.date, hasThumb: !!doc.thumbs?.length,
    };
  }

  async function videos(peer, { q = '', offsetId = 0 } = {}) {
    requireLogin();
    const entity = await resolvePeer(peer);
    const opts = { limit: 40, offsetId: Number(offsetId) || 0, search: q || undefined };
    // vídeos "de verdade" e arquivos (mkv enviados como documento) vêm de filtros diferentes
    const [a, b] = await Promise.all([
      client.getMessages(entity, { ...opts, filter: new Api.InputMessagesFilterVideo() }),
      client.getMessages(entity, { ...opts, filter: new Api.InputMessagesFilterDocument() }),
    ]);
    const seen = new Set();
    const items = [...a, ...b]
      .filter((m) => m && !seen.has(m.id) && seen.add(m.id))
      .map(videoInfo).filter(Boolean)
      .sort((x, y) => y.id - x.id);
    const lows = [a, b].filter((l) => l.length === 40).map((l) => l[l.length - 1].id);
    return { items, nextOffset: lows.length ? Math.max(...lows) : null };
  }

  async function thumb(peer, msgId) {
    requireLogin();
    const key = `${peer}_${msgId}`;
    if (thumbCache.has(key)) return thumbCache.get(key);
    const [msg] = await client.getMessages(await resolvePeer(peer), { ids: Number(msgId) });
    const thumbs = msg?.media?.document?.thumbs || [];
    const best = thumbs.filter((t) => t instanceof Api.PhotoSize || t instanceof Api.PhotoSizeProgressive).pop() || thumbs[thumbs.length - 1];
    const buf = best ? await client.downloadMedia(msg, { thumb: best }) : null;
    if (thumbCache.size > 300) thumbCache.clear();
    thumbCache.set(key, buf);
    return buf;
  }

  // https://t.me/canal/123, https://t.me/c/1234567890/123, …/canal/topico/123, ?single etc.
  function parseLink(link) {
    const u = new URL(link.trim().replace(/^(?!https?:\/\/)/, 'https://'));
    if (!/^(t|telegram)\.me$/i.test(u.hostname.replace(/^www\./, ''))) throw new Error('Não é um link do Telegram: ' + link);
    const parts = u.pathname.split('/').filter(Boolean);
    const msgId = Number(parts[parts.length - 1]);
    if (!msgId) throw new Error('O link não aponta para uma mensagem: ' + link);
    if (parts[0] === 'c') return { peer: '-100' + parts[1], msgId };
    if (parts[0] === 's') parts.shift();
    return { peer: parts[0], msgId };
  }

  // ---------- download paralelo ----------
  const safeName = (s) => s.replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').replace(/\s+(\.\w+)$/, '$1').trim().replace(/[. ]+$/, '') || 'video';
  const publicJob = ({ cancel, ...j }) => j;

  async function enqueue(peer, msgId) {
    requireLogin();
    const key = `${peer}_${msgId}`;
    const existing = downloads.get(key);
    if (existing && ['queued', 'running'].includes(existing.status)) return key;
    const entity = await resolvePeer(peer);
    const [msg] = await client.getMessages(entity, { ids: Number(msgId) });
    const info = videoInfo(msg);
    if (!info) throw new Error(`A mensagem ${msgId} não tem um vídeo.`);
    downloads.set(key, { key, peer: String(peer), msgId: Number(msgId), name: info.name, size: info.size,
      done: 0, speed: 0, status: 'queued', added: Date.now() });
    pump();
    return key;
  }

  let active = 0;
  function pump() {
    // um filme por vez: todas as conexões ficam para ele
    if (active) return;
    const next = [...downloads.values()].find((j) => j.status === 'queued');
    if (!next) return;
    active++;
    run(next).catch((e) => { next.status = 'error'; next.error = friendly(e); })
      .finally(() => { active--; pump(); });
  }

  function friendly(e) {
    const m = e?.errorMessage || e?.message || String(e);
    if (/FILE_REFERENCE/.test(m)) return 'O link do arquivo expirou; tente de novo.';
    if (/CHANNEL_PRIVATE|CHAT_ADMIN_REQUIRED/.test(m)) return 'Você não tem acesso a esse canal.';
    return m;
  }

  async function run(job) {
    const dir = getConfig().moviesDir;
    const final = uniquePath(path.join(dir, safeName(job.name)));
    const part = path.join(dir, safeName(job.name) + '.part');
    const meta = part + '.json';
    job.status = 'running';
    job.started = Date.now();
    let canceled = false;
    job.cancel = () => { canceled = true; };

    const entity = await resolvePeer(job.peer);
    let location, dcId, migratedDc = null;
    async function refresh() {
      const [msg] = await client.getMessages(entity, { ids: job.msgId });
      const doc = msg?.media?.document;
      if (!doc) throw new Error('A mensagem foi apagada.');
      location = new Api.InputDocumentFileLocation({ id: doc.id, accessHash: doc.accessHash, fileReference: doc.fileReference, thumbSize: '' });
      dcId = migratedDc || doc.dcId;
    }
    await refresh();

    // Retoma de onde parou, se houver um download anterior incompleto
    let start = 0;
    try {
      const m = JSON.parse(await fsp.readFile(meta, 'utf8'));
      if (m.size === job.size && fs.existsSync(part)) start = m.contiguous;
    } catch {}
    const fh = await fsp.open(part, start ? 'r+' : 'w');
    job.done = start;

    const threads = Math.max(1, Math.min(16, Number(getConfig().telegram.threads) || 8));
    let nextOffset = start;
    const finished = new Set();
    let contiguous = start;
    let refreshing = null;
    const samples = [];

    async function getChunk(offset) {
      for (let attempt = 0; ; attempt++) {
        if (canceled) throw new Error('cancelado');
        if (attempt > 25) throw new Error('O Telegram não entregou parte do arquivo; tente de novo.');
        try {
          const sender = await client.getSender(dcId);
          const res = await client.invokeWithSender(new Api.upload.GetFile({ location, offset: bigInt(offset), limit: CHUNK, precise: false }), sender);
          // um pedaço menor que o esperado no meio do arquivo corromperia o vídeo: pede de novo
          if (res.bytes.length < CHUNK && offset + res.bytes.length < job.size) throw new Error('pedaço incompleto');
          return res.bytes;
        } catch (e) {
          const msg = e?.errorMessage || '';
          if (e instanceof errors.FileMigrateError && e.newDc) { dcId = migratedDc = e.newDc; continue; }
          if (e instanceof errors.FloodWaitError) { job.note = `Telegram pediu pausa de ${e.seconds}s`; await sleep((e.seconds + 1) * 1000); job.note = null; continue; }
          if (/FILE_REFERENCE_(EXPIRED|INVALID)/.test(msg)) { refreshing ||= refresh().finally(() => (refreshing = null)); await refreshing; continue; }
          if (attempt >= 6) throw e;
          await sleep(Math.min(8000, 500 * 2 ** attempt));
        }
      }
    }

    async function worker() {
      while (!canceled) {
        const offset = nextOffset;
        if (offset >= job.size) return;
        nextOffset += CHUNK;
        const bytes = await getChunk(offset);
        await fh.write(bytes, 0, bytes.length, offset);
        job.done += bytes.length;
        finished.add(offset);
        while (finished.has(contiguous)) { finished.delete(contiguous); contiguous += CHUNK; }
      }
    }

    const ticker = setInterval(() => {
      samples.push([Date.now(), job.done]);
      while (samples.length > 8) samples.shift();
      if (samples.length > 1) {
        const [t0, b0] = samples[0], [t1, b1] = samples[samples.length - 1];
        job.speed = ((b1 - b0) / (t1 - t0)) * 1000;
        job.eta = job.speed > 0 ? Math.round((job.size - job.done) / job.speed) : null;
      }
      fsp.writeFile(meta, JSON.stringify({ size: job.size, contiguous: Math.min(contiguous, job.size) })).catch(() => {});
    }, 1000);

    try {
      await Promise.all(Array.from({ length: threads }, worker));
    } finally {
      clearInterval(ticker);
      await fh.close();
    }

    if (canceled) {
      job.status = 'canceled';
      job.speed = 0;
      await fsp.writeFile(meta, JSON.stringify({ size: job.size, contiguous: Math.min(contiguous, job.size) })).catch(() => {});
      return;
    }
    const { size } = await fsp.stat(part);
    if (size < job.size) throw new Error('Download incompleto; tente de novo para continuar de onde parou.');
    await fsp.truncate(part, job.size);
    await fsp.rename(part, final);
    await fsp.rm(meta, { force: true });
    Object.assign(job, { status: 'done', done: job.size, speed: 0, eta: 0, file: final,
      avgSpeed: (job.size - start) / ((Date.now() - job.started) / 1000) });
    onDownloaded?.(final);
  }

  function uniquePath(p) {
    if (!fs.existsSync(p)) return p;
    const ext = path.extname(p), base = p.slice(0, -ext.length);
    for (let i = 2; ; i++) if (!fs.existsSync(`${base} (${i})${ext}`)) return `${base} (${i})${ext}`;
  }

  function cancel(key) {
    const j = downloads.get(key);
    if (!j) return;
    if (j.status === 'queued') j.status = 'canceled';
    j.cancel?.();
  }
  function retry(key) {
    const j = downloads.get(key);
    if (j && ['error', 'canceled'].includes(j.status)) { Object.assign(j, { status: 'queued', error: null }); pump(); }
  }
  function clearFinished() {
    for (const [k, j] of downloads) if (['done', 'error', 'canceled'].includes(j.status)) downloads.delete(k);
  }
  const list = () => [...downloads.values()].map(publicJob).sort((a, b) => a.added - b.added);

  return {
    status, startLogin, logout, reset, answer, chats, videos, thumb, parseLink, enqueue, cancel, retry, clearFinished, list,
    setCreds({ apiId, apiHash }) {
      const cfg = getConfig();
      cfg.telegram = { ...(cfg.telegram || {}), apiId: String(apiId).trim(), apiHash: String(apiHash).trim() };
      saveConfig();
      return reset();
    },
    setOptions({ threads, autoCompress }) {
      const cfg = getConfig();
      cfg.telegram = { ...(cfg.telegram || {}) };
      if (threads != null) cfg.telegram.threads = Math.max(1, Math.min(16, Number(threads) || 8));
      if (autoCompress != null) cfg.telegram.autoCompress = !!autoCompress;
      saveConfig();
    },
  };
};
