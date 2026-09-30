// Gera build/icon.png (512×512) a partir do SVG abaixo.  Uso: npm run icon
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#262a35"/><stop offset="1" stop-color="#0e0f13"/>
    </linearGradient>
    <linearGradient id="play" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#ffd27a"/><stop offset="1" stop-color="#f0a21f"/>
    </linearGradient>
  </defs>
  <rect x="16" y="16" width="480" height="480" rx="108" fill="url(#bg)"/>
  <rect x="16.5" y="16.5" width="479" height="479" rx="107.5" fill="none" stroke="#ffffff" stroke-opacity=".08" stroke-width="3"/>
  <g fill="#f5b83d" fill-opacity=".22">
    ${[0, 1, 2, 3, 4].map((i) => `<rect x="${92 + i * 72}" y="70" width="40" height="28" rx="7"/><rect x="${92 + i * 72}" y="414" width="40" height="28" rx="7"/>`).join('')}
  </g>
  <path d="M206 168 L352 256 L206 344 Z" fill="url(#play)" stroke="url(#play)" stroke-width="28" stroke-linejoin="round"/>
</svg>`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 512, height: 512, show: false, frame: false, transparent: true,
    webPreferences: { offscreen: true } });
  await win.loadURL('data:text/html,' + encodeURIComponent(
    `<html><body style="margin:0;background:transparent">${SVG}</body></html>`));
  await new Promise((r) => setTimeout(r, 300));
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: 512, height: 512 });
  const out = path.join(__dirname, '..', 'build', 'icon.png');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, img.resize({ width: 512, height: 512 }).toPNG());
  console.log('ícone salvo em', out);
  app.quit();
});
