// Cine Local — app de desktop (Electron).
// O servidor (server.js) roda dentro do próprio app numa porta local aleatória e a janela o exibe.

const { app, BrowserWindow, dialog, shell, ipcMain, Menu, screen } = require('electron');
const path = require('path');
const fs = require('fs');

if (!app.requestSingleInstanceLock()) app.quit();

// Instalado: dados em %APPDATA%\Cine Local. Em desenvolvimento: na pasta do projeto.
const DATA_DIR = app.isPackaged ? app.getPath('userData') : __dirname;
process.env.CINE_DATA_DIR = DATA_DIR;
process.env.CINE_DEFAULT_MOVIES = app.isPackaged ? path.join(app.getPath('videos'), 'Cine Local') : path.join(__dirname, 'filmes');

const BOUNDS_FILE = path.join(DATA_DIR, 'window.json');
const MINI_FILE = path.join(DATA_DIR, 'mini.json');
const ICON = path.join(__dirname, 'build', 'icon.png');
let win = null;
let miniWin = null;
let server = null;
let origin = '';
let forceQuit = false;

// O mini player abre e toca sozinho, sem clique do usuário na janela nova
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

function loadBounds() {
  try { return JSON.parse(fs.readFileSync(BOUNDS_FILE, 'utf8')); } catch { return { width: 1280, height: 820 }; }
}
function saveBounds() {
  if (!win || win.isDestroyed()) return;
  const b = win.getNormalBounds();
  try { fs.writeFileSync(BOUNDS_FILE, JSON.stringify({ ...b, maximized: win.isMaximized() })); } catch {}
}

async function createWindow() {
  let port;
  try {
    server = require('./server');
    port = await server.start(0);
  } catch (e) {
    dialog.showErrorBox('Cine Local', 'Não foi possível iniciar o app:\n\n' + e.message);
    app.exit(1);
    return;
  }
  origin = `http://localhost:${port}`;
  const { maximized, ...bounds } = loadBounds();

  win = new BrowserWindow({
    ...bounds,
    minWidth: 720,
    minHeight: 480,
    title: 'Cine Local',
    icon: ICON,
    backgroundColor: '#0e0f13',
    autoHideMenuBar: true,
    show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true },
  });
  if (maximized) win.maximize();
  win.once('ready-to-show', () => win.show());
  win.loadURL(origin + '/');

  guardNavigation(win);

  // Atalhos sem barra de menu: F11 tela cheia, Ctrl+R recarregar, Ctrl+Shift+I ferramentas (só em desenvolvimento)
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F11') { win.setFullScreen(!win.isFullScreen()); e.preventDefault(); }
    else if (input.control && input.key.toLowerCase() === 'r') { win.reload(); e.preventDefault(); }
    else if (!app.isPackaged && input.control && input.shift && input.key.toLowerCase() === 'i') win.webContents.toggleDevTools();
  });

  win.on('close', (e) => {
    saveBounds();
    if (forceQuit) return;
    const w = server.activeWork();
    if (!w.compress && !w.downloads) return;
    const what = [
      w.downloads && `${w.downloads} download(s) do Telegram (continuam de onde pararam na próxima vez)`,
      w.compress && `${w.compress} compressão(ões) de vídeo (recomeçam do zero)`,
    ].filter(Boolean).join('\n• ');
    const choice = dialog.showMessageBoxSync(win, {
      type: 'question',
      buttons: ['Fechar mesmo assim', 'Continuar aberto'],
      defaultId: 1,
      cancelId: 1,
      title: 'Cine Local',
      message: 'Ainda há trabalho em andamento',
      detail: '• ' + what,
    });
    if (choice === 1) e.preventDefault();
  });
  win.on('closed', () => { win = null; });
}

// Links externos (ex.: my.telegram.org) abrem no navegador padrão; a janela só navega dentro do app
function guardNavigation(w) {
  w.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  w.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(origin)) { e.preventDefault(); if (/^https?:\/\//.test(url)) shell.openExternal(url); }
  });
}

// ---------- Mini player (janela flutuante sempre visível) ----------
let miniState = null;   // último estado informado pelo mini player: { id, t, playing }
let miniAction = 'pause'; // o que a janela principal faz quando o mini fecha

function miniBounds() {
  try {
    const b = JSON.parse(fs.readFileSync(MINI_FILE, 'utf8'));
    // só reaproveita a posição se ela ainda estiver dentro de alguma tela
    if (screen.getAllDisplays().some((d) => b.x >= d.workArea.x - 50 && b.y >= d.workArea.y - 50 &&
      b.x + 100 <= d.workArea.x + d.workArea.width && b.y + 60 <= d.workArea.y + d.workArea.height)) return b;
  } catch {}
  const { workArea: a } = screen.getPrimaryDisplay();
  return { width: 480, height: 270, x: a.x + a.width - 480 - 24, y: a.y + a.height - 270 - 24 };
}

ipcMain.handle('mini-open', (_e, state) => {
  if (miniWin) { miniWin.focus(); return; }
  miniState = state;
  miniAction = 'pause';
  miniWin = new BrowserWindow({
    ...miniBounds(),
    minWidth: 280,
    minHeight: 158,
    frame: false,
    alwaysOnTop: true,
    fullscreenable: false,
    maximizable: false,
    backgroundColor: '#000000',
    title: 'Cine Local — mini player',
    icon: ICON,
    show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true },
  });
  miniWin.setAlwaysOnTop(true, 'floating');
  guardNavigation(miniWin);
  const q = new URLSearchParams({ mini: state.id, t: String(state.t || 0), playing: state.playing ? '1' : '0' });
  miniWin.loadURL(`${origin}/?${q}`);
  miniWin.once('ready-to-show', () => miniWin.show());
  miniWin.on('close', () => {
    try { fs.writeFileSync(MINI_FILE, JSON.stringify(miniWin.getBounds())); } catch {}
  });
  miniWin.on('closed', () => {
    miniWin = null;
    if (!win) return;
    win.show();
    win.webContents.send('mini-closed', { ...miniState, action: miniAction });
  });
  win?.hide();
});

ipcMain.on('mini-state', (_e, state) => { miniState = state; });
ipcMain.handle('mini-close', (_e, action) => {
  miniAction = action === 'resume' || action === 'stop' ? action : 'pause';
  miniWin?.close();
});
ipcMain.handle('mini-aspect', (_e, ratio) => {
  if (!miniWin || !(ratio > 0.3 && ratio < 4)) return;
  miniWin.setAspectRatio(ratio);
  const [w] = miniWin.getSize();
  miniWin.setSize(w, Math.round(w / ratio));
});

ipcMain.handle('pick-folder', async (_e, current) => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Escolha a pasta dos seus filmes',
    defaultPath: current || app.getPath('videos'),
    properties: ['openDirectory', 'createDirectory'],
  });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('show-in-folder', (_e, target) => {
  if (typeof target !== 'string' || !fs.existsSync(target)) return;
  if (fs.statSync(target).isDirectory()) shell.openPath(target);
  else shell.showItemInFolder(target);
});

app.on('second-instance', () => {
  if (miniWin) return miniWin.focus();
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
});

app.setAppUserModelId('com.natz.cinelocal');
Menu.setApplicationMenu(null);
app.whenReady().then(createWindow);

app.on('before-quit', () => { forceQuit = true; });
app.on('window-all-closed', () => {
  try { server?.stopAll(); } catch {}
  app.quit();
});
