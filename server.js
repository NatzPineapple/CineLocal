// Cine Local — servidor sem dependências externas além do ffmpeg.
// Uso: node server.js [pasta-de-filmes]   — ou dentro do app Electron (main.js), que chama start().

const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const PORT = Number(process.env.PORT) || 8765;
const ROOT = __dirname;
// No app instalado a pasta do programa é somente leitura; config, cache e sessão ficam em CINE_DATA_DIR.
const DATA_DIR = process.env.CINE_DATA_DIR || ROOT;
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const CACHE_DIR = path.join(DATA_DIR, '.cache');
const VIDEO_EXT = new Set(['.mp4', '.mkv', '.webm', '.mov', '.avi', '.m4v', '.wmv', '.ts', '.flv']);
const MIME = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mkv': 'video/x-matroska', '.webm': 'video/webm',
  '.mov': 'video/quicktime', '.avi': 'video/x-msvideo', '.wmv': 'video/x-ms-wmv',
  '.ts': 'video/mp2t', '.flv': 'video/x-flv',
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.jpg': 'image/jpeg',
};

// ---------- ffmpeg ----------
function findBin(name, fallback) {
  try {
    execFileSync(name, ['-version'], { stdio: 'ignore' });
    return name; // já está no PATH
  } catch {
    // dentro do pacote Electron os executáveis ficam fora do app.asar
    try { return fallback().replace('app.asar', 'app.asar.unpacked'); } catch { return null; }
  }
}
const FFMPEG = findBin('ffmpeg', () => require('ffmpeg-static'));
const FFPROBE = findBin('ffprobe', () => require('ffprobe-static').path);
if (!FFMPEG || !FFPROBE) throw new Error('ffmpeg/ffprobe não encontrados. Rode "npm install" ou instale o ffmpeg no PATH.');

// ---------- configuração ----------
let config = { moviesDir: process.env.CINE_DEFAULT_MOVIES || path.join(ROOT, 'filmes') };
try { Object.assign(config, JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))); } catch {}
if (require.main === module && process.argv[2]) config.moviesDir = path.resolve(process.argv[2]);
const saveConfig = () => fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
fs.mkdirSync(CACHE_DIR, { recursive: true });
fs.mkdirSync(config.moviesDir, { recursive: true });

// ---------- utilidades ----------
const toId = (rel) => Buffer.from(rel, 'utf8').toString('base64url');
function fromId(id) {
  const rel = Buffer.from(id, 'base64url').toString('utf8');
  const abs = path.resolve(config.moviesDir, rel);
  const base = path.resolve(config.moviesDir) + path.sep;
  if (!abs.startsWith(base)) throw new Error('caminho inválido');
  return abs;
}
const cacheKey = (abs, st) =>
  Buffer.from(`${abs}|${st.size}|${st.mtimeMs}`).toString('base64url').slice(-60);

function run(bin, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { windowsHide: true });
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(err.slice(-800)))));
    p.on('error', reject);
  });
}

async function walk(dir, list = []) {
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return list; }
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name === '_originais') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await walk(full, list);
    else if (VIDEO_EXT.has(path.extname(e.name).toLowerCase()) && !e.name.endsWith('.part.mkv')) list.push(full);
  }
  return list;
}

// "The.Matrix.1999.1080p.BluRay.x264" -> { title: "The Matrix", year: 1999 }
function parseName(file) {
  let name = path.basename(file, path.extname(file)).replace(/\.compacto$/i, '');
  name = name.replace(/[._]+/g, ' ');
  const year = (name.match(/\b(19[2-9]\d|20[0-4]\d)\b/) || [])[1];
  if (year) name = name.slice(0, name.indexOf(year));
  name = name.replace(/\b(2160p|1080p|720p|480p|4k|bluray|brrip|web-?dl|webrip|hdrip|dvdrip|x264|x265|h264|h265|hevc|aac|dual|dublado|legendado)\b.*$/i, '');
  name = name.replace(/[\[\(\-\s]+$/, '').trim();
  return { title: name || path.basename(file), year: year ? Number(year) : null };
}

// ---------- metadados (ffprobe) com cache ----------
const metaCache = new Map();
async function probe(abs) {
  const st = await fsp.stat(abs);
  const key = cacheKey(abs, st);
  if (metaCache.has(key)) return metaCache.get(key);
  const file = path.join(CACHE_DIR, key + '.json');
  try {
    const m = JSON.parse(await fsp.readFile(file, 'utf8'));
    metaCache.set(key, m);
    return m;
  } catch {}
  let m = { duration: 0, width: 0, height: 0, vcodec: '?', acodec: '?', bitrate: 0 };
  try {
    const j = JSON.parse(await run(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', abs]));
    const v = j.streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
    const a = j.streams.find((s) => s.codec_type === 'audio');
    m = {
      duration: Number(j.format.duration) || 0,
      bitrate: Number(j.format.bit_rate) || 0,
      width: v?.width || 0, height: v?.height || 0,
      vcodec: v?.codec_name || '?', acodec: a?.codec_name || '?',
      audioTracks: j.streams.filter((s) => s.codec_type === 'audio').length,
    };
  } catch {}
  metaCache.set(key, m);
  await fsp.writeFile(file, JSON.stringify(m));
  return m;
}

async function thumbnail(abs) {
  const st = await fsp.stat(abs);
  const out = path.join(CACHE_DIR, cacheKey(abs, st) + '.jpg');
  if (fs.existsSync(out)) return out;
  const { duration } = await probe(abs);
  const at = duration ? Math.min(duration * 0.15, 600) : 5;
  await run(FFMPEG, ['-y', '-ss', String(at), '-i', abs, '-frames:v', '1', '-vf', 'scale=480:-2', '-q:v', '4', out])
    .catch(() => run(FFMPEG, ['-y', '-i', abs, '-frames:v', '1', '-vf', 'scale=480:-2', '-q:v', '4', out]));
  return out;
}

// ---------- compressão ----------
// Perfis pensados para "visualmente idêntico": H.265 guarda a mesma imagem em bem menos bytes que H.264/MPEG-4.
const PROFILES = {
  qualidade: { label: 'Visualmente idêntico (CPU, lento)', v: ['-c:v', 'libx265', '-preset', 'slow', '-crf', '20', '-pix_fmt', 'yuv420p10le', '-x265-params', 'log-level=error'] },
  equilibrado: { label: 'Equilibrado (CPU)', v: ['-c:v', 'libx265', '-preset', 'medium', '-crf', '23', '-pix_fmt', 'yuv420p10le', '-x265-params', 'log-level=error'] },
  nvidia: { label: 'GPU NVIDIA (rápido)', v: ['-c:v', 'hevc_nvenc', '-preset', 'p6', '-rc', 'vbr', '-cq', '22', '-b:v', '0'] },
  amd: { label: 'GPU AMD (rápido)', v: ['-c:v', 'hevc_amf', '-quality', 'quality', '-rc', 'cqp', '-qp_i', '20', '-qp_p', '22'] },
  intel: { label: 'GPU Intel (rápido)', v: ['-c:v', 'hevc_qsv', '-global_quality', '22'] },
};
const jobs = new Map(); // id -> { status, progress, ... }
const queue = [];
let running = null;

function enqueue(id, profile) {
  if (jobs.get(id)?.status === 'running' || jobs.get(id)?.status === 'queued') return;
  jobs.set(id, { status: 'queued', progress: 0, profile });
  queue.push(id);
  pump();
}

async function pump() {
  if (running || !queue.length) return;
  const id = queue.shift();
  const job = jobs.get(id);
  if (!job || job.status !== 'queued') return pump();
  running = id;
  try { await compress(id, job); } catch (e) { Object.assign(job, { status: 'error', error: e.message }); }
  running = null;
  pump();
}

async function compress(id, job) {
  const src = fromId(id);
  const meta = await probe(src);
  const dir = path.dirname(src);
  const base = path.basename(src, path.extname(src));
  const tmp = path.join(dir, base + '.compacto.part.mkv');
  const dst = path.join(dir, base + '.compacto.mkv');
  const before = (await fsp.stat(src)).size;
  job.status = 'running';
  job.started = Date.now();

  // Todas as faixas (áudios, legendas) são copiadas sem recodificar; só o vídeo é recomprimido.
  const args = ['-y', '-hide_banner', '-nostats', '-progress', 'pipe:1', '-i', src,
    '-map', '0', '-map', '-0:d?', '-map', '-0:t?',
    ...PROFILES[job.profile].v,
    '-c:a', 'copy', '-c:s', 'copy', '-map_metadata', '0', '-f', 'matroska', tmp];

  await new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, args, { windowsHide: true });
    job.proc = p;
    let err = '';
    p.stdout.on('data', (d) => {
      const m = String(d).match(/out_time_us=(\d+)/g);
      if (m && meta.duration) {
        const us = Number(m[m.length - 1].split('=')[1]);
        job.progress = Math.min(99.9, (us / 1e6 / meta.duration) * 100);
        const el = (Date.now() - job.started) / 1000;
        job.eta = job.progress > 0.5 ? Math.round((el / job.progress) * (100 - job.progress)) : null;
      }
    });
    p.stderr.on('data', (d) => (err = (err + d).slice(-1500)));
    p.on('error', reject);
    p.on('close', (code) => {
      delete job.proc;
      if (job.status === 'canceled') return reject(new Error('cancelado'));
      code === 0 ? resolve() : reject(new Error(err.trim().split('\n').slice(-3).join(' ') || 'ffmpeg falhou'));
    });
  }).catch(async (e) => {
    await fsp.rm(tmp, { force: true });
    if (job.status === 'canceled') return;
    throw e;
  });
  if (job.status === 'canceled') return;

  const after = (await fsp.stat(tmp)).size;
  if (after >= before * 0.97) {
    await fsp.rm(tmp, { force: true });
    Object.assign(job, { status: 'skipped', progress: 100, before, after,
      error: 'O arquivo já estava bem comprimido — a versão nova não ficou menor, então foi descartada.' });
    return;
  }
  await fsp.rename(tmp, dst);
  Object.assign(job, { status: 'done', progress: 100, before, after,
    output: toId(path.relative(config.moviesDir, dst)) });
}

// Move o original para "_originais" (nada é apagado) e deixa só a versão compacta no catálogo.
async function replaceOriginal(id) {
  const src = fromId(id);
  const dir = path.dirname(src);
  const base = path.basename(src, path.extname(src));
  const compact = path.join(dir, base + '.compacto.mkv');
  if (!fs.existsSync(compact)) throw new Error('versão compacta não encontrada');
  const backupDir = path.join(config.moviesDir, '_originais');
  await fsp.mkdir(backupDir, { recursive: true });
  await fsp.rename(src, path.join(backupDir, path.basename(src)));
  const final = path.join(dir, base + '.mkv');
  await fsp.rename(compact, final);
  return toId(path.relative(config.moviesDir, final));
}

// ---------- legendas externas (.srt -> WebVTT) ----------
function findSubtitle(abs) {
  const dir = path.dirname(abs);
  const base = path.basename(abs, path.extname(abs)).replace(/\.compacto$/i, '');
  try {
    const files = fs.readdirSync(dir).filter((f) => /\.(srt|vtt)$/i.test(f) && f.startsWith(base));
    files.sort((a, b) => (/\.pt|por|br/i.test(b) ? 1 : 0) - (/\.pt|por|br/i.test(a) ? 1 : 0));
    return files[0] ? path.join(dir, files[0]) : null;
  } catch { return null; }
}
function srtToVtt(buf) {
  let text = buf.toString('utf8');
  if (text.includes('�')) text = buf.toString('latin1'); // legendas antigas em Windows-1252
  return 'WEBVTT\n\n' + text.replace(/^﻿/, '').replace(/\r/g, '')
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
}

// ---------- HTTP ----------
function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
const readBody = (req) => new Promise((r) => { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => { try { r(JSON.parse(b || '{}')); } catch { r({}); } }); });

async function streamFile(req, res, abs, type) {
  const { size } = await fsp.stat(abs);
  const range = req.headers.range;
  if (!range) {
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': size, 'Accept-Ranges': 'bytes' });
    return fs.createReadStream(abs).pipe(res);
  }
  const [s, e] = range.replace('bytes=', '').split('-');
  const start = Number(s) || 0;
  const end = e ? Math.min(Number(e), size - 1) : size - 1;
  if (start >= size) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); return res.end(); }
  res.writeHead(206, {
    'Content-Type': type, 'Accept-Ranges': 'bytes',
    'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1,
  });
  fs.createReadStream(abs, { start, end }).pipe(res);
}

async function listMovies() {
  const files = await walk(config.moviesDir);
  const out = [];
  for (const abs of files) {
    const st = await fsp.stat(abs);
    const rel = path.relative(config.moviesDir, abs);
    const id = toId(rel);
    const meta = await probe(abs);
    const isCompact = /\.compacto\.mkv$/i.test(abs);
    out.push({
      id, rel, ...parseName(abs), ...meta, size: st.size, added: st.mtimeMs, isCompact,
      hasSubtitle: !!findSubtitle(abs),
      job: jobs.get(id) ? publicJob(jobs.get(id)) : null,
    });
  }
  // marca pares original/compacto
  const byBase = new Map(out.map((m) => [m.rel.replace(/\.[^.\\/]+$/, ''), m]));
  for (const m of out) if (m.isCompact) {
    const orig = byBase.get(m.rel.replace(/\.compacto\.mkv$/i, ''));
    if (orig) { orig.compactId = m.id; orig.compactSize = m.size; m.originalId = orig.id; }
  }
  return out.sort((a, b) => a.title.localeCompare(b.title, 'pt-BR'));
}
const publicJob = ({ proc, ...j }) => j;

// ---------- Telegram ----------
const telegram = require('./telegram')({
  root: DATA_DIR,
  getConfig: () => config,
  saveConfig,
  onDownloaded(file) {
    // "Comprimir automaticamente": entra na fila de compressão assim que o download termina
    if (config.telegram?.autoCompress) enqueue(toId(path.relative(config.moviesDir, file)), config.lastProfile || 'qualidade');
  },
});

async function telegramRoute(p, req, res, url) {
  const tg = telegram;
  let m;
  if (p === '/api/tg/status') return send(res, 200, await tg.status());
  if (p === '/api/tg/downloads') return send(res, 200, tg.list());
  if (p === '/api/tg/chats') return send(res, 200, await tg.chats(url.searchParams.get('q') || ''));
  if ((m = p.match(/^\/api\/tg\/videos\/(-?\w+)$/)))
    return send(res, 200, await tg.videos(m[1], { q: url.searchParams.get('q') || '', offsetId: url.searchParams.get('offset') }));
  if ((m = p.match(/^\/api\/tg\/thumb\/(-?\w+)\/(\d+)$/))) {
    const buf = await tg.thumb(m[1], m[2]);
    if (!buf) return send(res, 404, 'sem miniatura', 'text/plain');
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'max-age=86400' });
    return res.end(buf);
  }
  if (req.method !== 'POST') return false;
  const body = await readBody(req);
  if (p === '/api/tg/creds') {
    if (!/^\d+$/.test(String(body.apiId || '').trim()) || !/^[0-9a-f]{32}$/i.test(String(body.apiHash || '').trim()))
      return send(res, 400, { error: 'api_id deve ser um número e api_hash tem 32 caracteres (0-9, a-f).' });
    await tg.setCreds(body);
    return send(res, 200, { ok: true });
  }
  if (p === '/api/tg/options') { tg.setOptions(body); return send(res, 200, { ok: true }); }
  if (p === '/api/tg/login/phone') { await tg.startLogin(String(body.phone || '').replace(/[^\d+]/g, '')); return send(res, 200, await tg.status()); }
  if (p === '/api/tg/login/code') { tg.answer('code', String(body.code || '').replace(/\D/g, '')); return send(res, 200, { ok: true }); }
  if (p === '/api/tg/login/password') { tg.answer('password', String(body.password || '')); return send(res, 200, { ok: true }); }
  if (p === '/api/tg/logout') { await tg.logout(); return send(res, 200, { ok: true }); }
  if (p === '/api/tg/download') {
    const items = [];
    for (const link of String(body.links || '').split(/\s+/).filter(Boolean)) items.push(tg.parseLink(link));
    if (body.peer && body.msgId) items.push({ peer: body.peer, msgId: body.msgId });
    if (!items.length) return send(res, 400, { error: 'Nenhum link válido.' });
    const errors = [];
    for (const it of items) await tg.enqueue(it.peer, it.msgId).catch((e) => errors.push(e.message));
    return send(res, errors.length === items.length ? 400 : 200, { ok: errors.length < items.length, errors, error: errors.join(' ') });
  }
  if ((m = p.match(/^\/api\/tg\/(cancel|retry)$/))) { tg[m[1]](body.key); return send(res, 200, { ok: true }); }
  if (p === '/api/tg/clear') { tg.clearFinished(); return send(res, 200, { ok: true }); }
  return false;
}

let port = PORT;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = decodeURIComponent(url.pathname);
  // Proteção: só atende o próprio navegador local. Outros sites não conseguem acionar a API
  // (o cabeçalho personalizado exige permissão CORS, que nunca é concedida).
  if (req.headers.host !== `localhost:${port}` && req.headers.host !== `127.0.0.1:${port}`) return send(res, 403, 'host não permitido', 'text/plain');
  if (req.method === 'POST' && req.headers['x-cine-local'] !== '1') return send(res, 403, { error: 'requisição recusada' });
  try {
    if (p.startsWith('/api/tg/')) {
      if ((await telegramRoute(p, req, res, url)) !== false) return;
    }
    if (p === '/' || p === '/index.html')
      return send(res, 200, await fsp.readFile(path.join(ROOT, 'public', 'index.html')), MIME['.html']);

    if (p === '/api/movies' && req.method === 'GET')
      return send(res, 200, { moviesDir: config.moviesDir, profiles: Object.fromEntries(Object.entries(PROFILES).map(([k, v]) => [k, v.label])), movies: await listMovies() });

    if (p === '/api/config' && req.method === 'POST') {
      const { moviesDir } = await readBody(req);
      if (!moviesDir || !fs.existsSync(moviesDir) || !fs.statSync(moviesDir).isDirectory())
        return send(res, 400, { error: 'Pasta não encontrada' });
      config.moviesDir = path.resolve(moviesDir);
      saveConfig();
      return send(res, 200, { ok: true });
    }

    if (p === '/api/jobs') {
      return send(res, 200, Object.fromEntries([...jobs].map(([k, v]) => [k, publicJob(v)])));
    }

    let m;
    if ((m = p.match(/^\/api\/compress\/([\w-]+)$/)) && req.method === 'POST') {
      const { profile = 'qualidade' } = await readBody(req);
      if (!PROFILES[profile]) return send(res, 400, { error: 'perfil inválido' });
      config.lastProfile = profile;
      saveConfig();
      fromId(m[1]);
      enqueue(m[1], profile);
      return send(res, 200, { ok: true });
    }
    if ((m = p.match(/^\/api\/cancel\/([\w-]+)$/)) && req.method === 'POST') {
      const job = jobs.get(m[1]);
      if (job) { job.status = 'canceled'; job.proc?.kill(); }
      return send(res, 200, { ok: true });
    }
    if ((m = p.match(/^\/api\/replace\/([\w-]+)$/)) && req.method === 'POST') {
      const newId = await replaceOriginal(m[1]);
      jobs.delete(m[1]);
      return send(res, 200, { ok: true, id: newId });
    }
    if ((m = p.match(/^\/thumb\/([\w-]+)$/))) {
      const f = await thumbnail(fromId(m[1]));
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'max-age=86400' });
      return fs.createReadStream(f).pipe(res);
    }
    if ((m = p.match(/^\/video\/([\w-]+)$/))) {
      const abs = fromId(m[1]);
      return streamFile(req, res, abs, MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream');
    }
    if ((m = p.match(/^\/subs\/([\w-]+)$/))) {
      const sub = findSubtitle(fromId(m[1]));
      if (!sub) return send(res, 404, 'sem legenda', 'text/plain');
      const buf = await fsp.readFile(sub);
      return send(res, 200, /\.vtt$/i.test(sub) ? buf : srtToVtt(buf), 'text/vtt; charset=utf-8');
    }
    send(res, 404, { error: 'não encontrado' });
  } catch (e) {
    if (!res.headersSent) send(res, 500, { error: e.message });
  }
});

// Porta 0 = o sistema escolhe uma livre (usado pelo app Electron)
function start(wanted = PORT) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(wanted, '127.0.0.1', () => resolve((port = server.address().port)));
  });
}

// Trabalho em andamento — o app pergunta antes de fechar se houver algo.
function activeWork() {
  const busy = (st) => st === 'running' || st === 'queued';
  return {
    compress: [...jobs.values()].filter((j) => busy(j.status)).length,
    downloads: telegram.list().filter((d) => busy(d.status)).length,
  };
}

function stopAll() {
  for (const j of jobs.values()) if (j.status === 'running' || j.status === 'queued') { j.status = 'canceled'; j.proc?.kill(); }
  for (const d of telegram.list()) telegram.cancel(d.key);
  server.close();
}

module.exports = { start, activeWork, stopAll };

if (require.main === module) {
  start().then(() => {
    console.log(`\n  Cine Local rodando em  http://localhost:${port}`);
    console.log(`  Pasta de filmes: ${config.moviesDir}\n`);
  });
}
