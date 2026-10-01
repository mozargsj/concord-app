import { BrowserWindow, ipcMain, screen } from 'electron';
import path from 'node:path';

// Persistent "remote control active" indicator for the CONTROLLED PC (spec 17, 37): a small
// always-on-top window of its own, because the person being controlled is usually inside another
// app or game with Concord minimized — an in-app banner alone could be completely out of sight.
// It never takes focus (showInactive / focusable:false) and its button is the guaranteed way to
// stop the session even on a keyboard without a Pause key.
let indicator: BrowserWindow | null = null;
let onStop: (() => void) | null = null;

ipcMain.on('rc-indicator:stop', () => onStop?.());

const HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;height:100%;background:#1e1f22;color:#f2f3f5;font:13px 'Segoe UI',sans-serif;overflow:hidden;user-select:none}
  body{display:flex;align-items:center;gap:10px;padding:0 12px;box-sizing:border-box;border:1px solid #2b8a3e;border-radius:8px}
  .dot{width:10px;height:10px;border-radius:50%;background:#3ba55d;flex:none;animation:pulse 1.6s infinite}
  @keyframes pulse{50%{opacity:.35}}
  .text{flex:1;min-width:0;line-height:1.25}
  .text b{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .text small{color:#b5bac1}
  button{flex:none;background:#da373c;color:#fff;border:0;border-radius:6px;padding:7px 12px;font:inherit;font-weight:600;cursor:pointer}
  button:hover{background:#a12828}
</style></head><body>
  <div class="dot"></div>
  <div class="text"><b id="who">Controle remoto ativo</b><small>Ctrl+Shift+Pause para parar</small></div>
  <button id="stop">Parar controle</button>
  <script>document.getElementById('stop').addEventListener('click',()=>window.concordIndicator.stop());</script>
</body></html>`;

export function showControlIndicator(peerName: string, stop: () => void): void {
  hideControlIndicator();
  onStop = stop;
  const { workArea } = screen.getPrimaryDisplay();
  const width = 400;
  indicator = new BrowserWindow({
    width,
    height: 52,
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y: workArea.y + 8,
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false,
    show: false,
    alwaysOnTop: true,
    backgroundColor: '#1e1f22',
    webPreferences: {
      preload: path.join(__dirname, '../preload/indicator.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });
  indicator.setAlwaysOnTop(true, 'screen-saver');
  indicator.setMenuBarVisibility(false);
  indicator.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  indicator.webContents.on('will-navigate', (event) => event.preventDefault());
  const window = indicator;
  void window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(HTML)}`).then(() => {
    // JSON.stringify yields a safe JS string literal — the name never touches the markup.
    void window.webContents.executeJavaScript(
      `document.getElementById('who').textContent = ${JSON.stringify(`Controle remoto ativo — ${peerName}`)}`
    );
    if (!window.isDestroyed()) window.showInactive();
  });
  window.on('closed', () => {
    if (indicator === window) indicator = null;
  });
}

export function hideControlIndicator(): void {
  onStop = null;
  if (indicator && !indicator.isDestroyed()) indicator.destroy();
  indicator = null;
}
