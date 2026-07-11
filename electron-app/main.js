const { app, BrowserWindow, ipcMain, shell, dialog, screen, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, execFile } = require('child_process');
const { networkInterfaces } = require('os');

let mainWindow;
let frameWindow = null;
let uxplayProcess = null;
let isRunning = false;
let mirrorStyleTimer = null;
let styledMirrorHwnd = null;
// placement mode the styling loop must respect (frame / custom / projector / preset)
let currentPlacement = null;

const UXPLAY_PATH = app.isPackaged
  ? path.join(process.resourcesPath, 'uxplay.exe')
  : path.join(__dirname, '..', 'uxplay-src', 'build', 'uxplay.exe');

// GStreamer runtime: bundled in resources when packaged, MSYS2 in dev
const GST_BIN = app.isPackaged
  ? path.join(process.resourcesPath, 'gstreamer', 'bin')
  : 'C:\\tools\\msys64\\ucrt64\\bin';
const GST_PLUGINS = app.isPackaged
  ? path.join(process.resourcesPath, 'gstreamer', 'plugins')
  : 'C:\\tools\\msys64\\ucrt64\\lib\\gstreamer-1.0';

const BONJOUR_MSI = app.isPackaged
  ? path.join(process.resourcesPath, 'redist', 'Bonjour64.msi')
  : path.join(__dirname, 'redist', 'Bonjour64.msi');

const WINDOW_STYLER = app.isPackaged
  ? path.join(process.resourcesPath, 'window-styler.ps1')
  : path.join(__dirname, 'window-styler.ps1');

function hasBonjour() {
  return fs.existsSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'dnssd.dll'));
}

async function ensureBonjour() {
  if (hasBonjour()) return true;

  // Store (MSIX) build: not allowed to install other software; point user to Apple's official download
  if (process.windowsStore) {
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'Cần cài Bonjour',
      message: 'MirrorBeam cần dịch vụ Apple Bonjour để iPhone tìm thấy máy tính này qua AirPlay.',
      detail: 'Bấm "Mở trang tải" để tải Bonjour Print Services từ Apple (miễn phí, ~5MB). Cài xong quay lại bấm Khởi động AirPlay.',
      buttons: ['Mở trang tải', 'Để sau'],
      defaultId: 0,
      cancelId: 1
    });
    if (response === 0) shell.openExternal('https://support.apple.com/kb/DL999');
    return false;
  }

  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: 'Cần cài Bonjour',
    message: 'MirrorBeam cần dịch vụ Apple Bonjour để iPhone tìm thấy máy tính này qua AirPlay.',
    detail: 'Bấm "Cài đặt" để cài Bonjour (đi kèm sẵn, ~3MB). Windows sẽ hỏi quyền Administrator.',
    buttons: ['Cài đặt', 'Để sau'],
    defaultId: 0,
    cancelId: 1
  });
  if (response !== 0) return false;
  return new Promise((resolve) => {
    execFile('msiexec.exe', ['/i', BONJOUR_MSI, '/qb'], { windowsHide: false }, () => {
      resolve(hasBonjour());
    });
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: 'MirrorBeam - Screen Mirroring for iPhone',
    backgroundColor: '#1a1a2e',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    },
    icon: path.join(__dirname, 'icon.png')
  });

  mainWindow.loadFile('index.html');
  mainWindow.setMenuBarVisibility(false);

  mainWindow.on('closed', () => {
    stopUxplay();
    mainWindow = null;
  });
}

function createMirrorFrameWindow() {
  if (frameWindow && !frameWindow.isDestroyed()) {
    frameWindow.focus();
    styleMirrorWindowOnce({ mirrorSize: 'frame' });
    return;
  }
  frameWindow = new BrowserWindow({
    width: 470,
    height: 920,
    minWidth: 360,
    minHeight: 700,
    title: 'MirrorBeam Frame',
    frame: false,
    transparent: true,
    resizable: true,
    alwaysOnTop: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: { contextIsolation: true, nodeIntegration: false }
  });
  frameWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<!doctype html>
<html><head><meta charset="utf-8"><style>
html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent;font-family:Arial,sans-serif;}
.shell{position:absolute;inset:6px;border:14px solid #030406;border-radius:56px;box-shadow:0 18px 55px rgba(0,0,0,.34),0 0 0 1px rgba(255,255,255,.10),inset 0 0 0 1px rgba(255,255,255,.08);background:transparent;pointer-events:none;}
.drag{position:absolute;left:70px;right:70px;top:6px;height:62px;-webkit-app-region:drag;z-index:8;pointer-events:auto;}
.corner{position:absolute;width:34px;height:34px;border:1px solid rgba(255,255,255,.16);opacity:.18;z-index:9;pointer-events:none;}
.corner.tl{left:14px;top:14px;border-right:0;border-bottom:0;border-radius:26px 0 0 0}.corner.tr{right:14px;top:14px;border-left:0;border-bottom:0;border-radius:0 26px 0 0}.corner.bl{left:14px;bottom:14px;border-right:0;border-top:0;border-radius:0 0 0 26px}.corner.br{right:14px;bottom:14px;border-left:0;border-top:0;border-radius:0 0 26px 0}
.notch{position:absolute;top:15px;left:50%;transform:translateX(-50%);width:118px;height:30px;border-radius:0 0 19px 19px;background:#030406;box-shadow:0 1px 0 rgba(255,255,255,.08);z-index:7;pointer-events:none;}
.home{position:absolute;left:50%;bottom:31px;transform:translateX(-50%);width:112px;height:4px;border-radius:999px;background:rgba(255,255,255,.48);z-index:7;pointer-events:none;}
.resize-dot{position:absolute;right:14px;bottom:14px;width:24px;height:24px;border-right:3px solid rgba(255,255,255,.30);border-bottom:3px solid rgba(255,255,255,.30);border-radius:0 0 18px 0;z-index:8;pointer-events:none;}
</style></head><body><div class="shell"></div><div class="drag"></div><div class="notch"></div><div class="home"></div><div class="resize-dot"></div><div class="corner tl"></div><div class="corner tr"></div><div class="corner bl"></div><div class="corner br"></div></body></html>`));
  frameWindow.on('closed', () => { frameWindow = null; });
}

function getFrameVideoBounds() {
  if (!frameWindow || frameWindow.isDestroyed()) return null;
  const b = frameWindow.getBounds();
  return {
    x: b.x + 26,
    y: b.y + 62,
    width: Math.max(220, b.width - 52),
    height: Math.max(360, b.height - 124)
  };
}

function closeMirrorFrameWindow() {
  if (frameWindow && !frameWindow.isDestroyed()) frameWindow.close();
  frameWindow = null;
}

let brightnessWindow = null;
let brightnessBoundsKey = '';

function getBrightnessTargetBounds() {
  // dim the display the projector is on; otherwise the primary one
  if (projectorActive && currentPlacement && currentPlacement.displayId != null) {
    return getDisplayById(currentPlacement.displayId).bounds;
  }
  return screen.getPrimaryDisplay().bounds;
}

function ensureBrightnessWindow() {
  const d = getBrightnessTargetBounds();
  const key = `${d.x},${d.y},${d.width},${d.height}`;
  if (brightnessWindow && !brightnessWindow.isDestroyed()) {
    if (key === brightnessBoundsKey) return brightnessWindow;
    brightnessWindow.close();
    brightnessWindow = null;
  }
  brightnessBoundsKey = key;
  brightnessWindow = new BrowserWindow({
    x: d.x, y: d.y, width: d.width, height: d.height,
    frame: false, transparent: true, resizable: false,
    alwaysOnTop: true, skipTaskbar: true, focusable: false,
    hasShadow: false, backgroundColor: '#00000000',
    webPreferences: { contextIsolation: true, nodeIntegration: false }
  });
  brightnessWindow.setIgnoreMouseEvents(true);
  brightnessWindow.setAlwaysOnTop(true, 'screen-saver');
  brightnessWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
    '<!doctype html><html><body style="margin:0"><div id="ov" style="position:fixed;inset:0;background:#000;opacity:0;"></div></body></html>'));
  brightnessWindow.on('closed', () => { brightnessWindow = null; });
  return brightnessWindow;
}

function closeBrightnessWindow() {
  if (brightnessWindow && !brightnessWindow.isDestroyed()) brightnessWindow.close();
  brightnessWindow = null;
}

function setBrightness(percent) {
  const v = Math.max(20, Math.min(130, Number(percent) || 100));
  if (v === 100) {
    closeBrightnessWindow();
    return;
  }
  const w = ensureBrightnessWindow();
  const color = v < 100 ? '#000' : '#fff';
  const opacity = v < 100 ? ((100 - v) / 100) * 0.85 : ((v - 100) / 30) * 0.25;
  const js = "(function(){var o=document.getElementById('ov');o.style.background='" + color + "';o.style.opacity='" + opacity.toFixed(3) + "';})()";
  const run = () => w.webContents.executeJavaScript(js).catch(() => {});
  if (w.webContents.isLoading()) w.webContents.once('did-finish-load', run);
  else run();
}

function safeSend(channel, data) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send(channel, data);
}

function sendMirrorWindowStatus(message, extra = {}) {
  safeSend('mirror-embed-status', {
    message,
    styled: !!extra.styled,
    childHwnd: styledMirrorHwnd,
    ...extra
  });
}

function stopMirrorStyling() {
  if (mirrorStyleTimer) {
    clearInterval(mirrorStyleTimer);
    mirrorStyleTimer = null;
  }
  styledMirrorHwnd = null;
}

function getDisplayById(displayId) {
  if (displayId != null) {
    const found = screen.getAllDisplays().find(d => d.id === Number(displayId));
    if (found) return found;
  }
  return screen.getPrimaryDisplay();
}

function computeMirrorPlacement(options = {}) {
  if (options.mirrorSize === 'projector') {
    const d = getDisplayById(options.displayId).bounds;
    return { x: d.x, y: d.y, width: d.width, height: d.height };
  }
  if (options.mirrorSize === 'custom' && options.width && options.height) {
    return { x: -1, y: -1, width: Math.round(options.width), height: Math.round(options.height) };
  }
  if (options.mirrorSize === 'frame') {
    const frameBounds = getFrameVideoBounds();
    if (frameBounds) return frameBounds;
  }
  const size = options.mirrorSize || 'iphone';
  const presets = {
    iphone: { width: 430, height: 860 },
    small: { width: 390, height: 780 },
    ipad: { width: 760, height: 1024 }
  };
  const picked = presets[size] || presets.iphone;
  return { ...picked, x: -1, y: -1 };
}

function styleMirrorWindowOnce(options = {}) {
  if (!uxplayProcess) return;
  const placement = computeMirrorPlacement(options);
  const args = [
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', WINDOW_STYLER,
    '-ProcessId', String(uxplayProcess.pid),
    '-X', String(placement.x),
    '-Y', String(placement.y),
    '-Width', String(placement.width),
    '-Height', String(placement.height),
    '-TopMost',
    '-Borderless'
  ];
  if (styledMirrorHwnd) args.push('-ChildHwnd', String(styledMirrorHwnd));

  execFile('powershell.exe', args, { windowsHide: true, timeout: 8000 }, (err, stdout) => {
    const out = (stdout || '').trim();
    if (err) {
      sendMirrorWindowStatus('Đang chờ cửa sổ mirror của iPhone để tự đặt kiểu màn hình...', { styled: false });
      return;
    }
    if (!out) return;
    try {
      const result = JSON.parse(out);
      if (result.ok && result.childHwnd) {
        const firstStyle = styledMirrorHwnd !== result.childHwnd;
        styledMirrorHwnd = result.childHwnd;
        // keep the brightness overlay above the (topmost) mirror window
        if (brightnessWindow && !brightnessWindow.isDestroyed()) brightnessWindow.moveTop();
        sendMirrorWindowStatus('Đã tự đặt cửa sổ mirror thành kiểu màn hình iPhone', { styled: true, ...result });
        if (firstStyle) {
          safeSend('uxplay-log', { type: 'stdout', text: `Đã đặt cửa sổ mirror vào khung iPhone kéo được: ${result.title || 'unknown'} / ${result.class || 'unknown'} (${result.width}x${result.height}).`, timestamp: Date.now() });
        }
      }
    } catch (_) {}
  });
}

function startMirrorStyling(options = {}) {
  stopMirrorStyling();
  sendMirrorWindowStatus('Khi iPhone kết nối, app sẽ thử đặt video vào khung iPhone. Nếu lệch, bấm nút đặt lại.', { styled: false });
  let attempts = 0;
  const maxAttempts = 8;
  const run = () => {
    attempts += 1;
    styleMirrorWindowOnce(options);
    if (attempts >= maxAttempts && mirrorStyleTimer) {
      clearInterval(mirrorStyleTimer);
      mirrorStyleTimer = null;
    }
  };
  mirrorStyleTimer = setInterval(run, 1500);
  setTimeout(run, 500);
}

function killStaleUxplayProcesses() {
  return new Promise((resolve) => {
    execFile('taskkill.exe', ['/IM', 'uxplay.exe', '/F', '/T'], { windowsHide: true, timeout: 5000 }, () => resolve());
  });
}

function getPrimaryNetwork() {
  const ifaces = networkInterfaces();
  const badNames = /vEthernet|Virtual|Loopback|Host-Only|VMware|VirtualBox|Npcap|Tailscale|ZeroTier/i;
  const candidates = [];

  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family !== 'IPv4' || iface.internal) continue;
      if (iface.address.startsWith('169.254.')) continue;
      candidates.push({
        name,
        address: iface.address,
        mac: (iface.mac || '').replace(/-/g, ':').toUpperCase(),
        virtual: badNames.test(name)
      });
    }
  }

  const preferred = candidates.find(c => !c.virtual && c.address.startsWith('192.168.'))
    || candidates.find(c => !c.virtual)
    || candidates[0];

  return preferred || { name: 'loopback', address: '127.0.0.1', mac: '' };
}

function getLocalIP() {
  return getPrimaryNetwork().address;
}

async function startUxplay(options = {}) {
  if (isRunning) {
    safeSend('uxplay-status', { running: true, message: 'Already running' });
    return;
  }

  const bonjourOk = await ensureBonjour();
  if (!bonjourOk) {
    safeSend('uxplay-status', { running: false, message: 'Thiếu Bonjour - iPhone sẽ không tìm thấy máy này. Khởi động lại app để cài.' });
    safeSend('uxplay-log', { type: 'stderr', text: 'Bonjour chưa được cài. AirPlay cần Bonjour để iPhone phát hiện máy tính.', timestamp: Date.now() });
    return;
  }

  await killStaleUxplayProcesses();

  const network = getPrimaryNetwork();
  const localIP = network.address;
  const serverName = options.name || 'MirrorBeam';

  const args = [];
  if (options.name) args.push('-n', options.name);
  args.push('-nh');
  if (network.mac && network.mac !== '00:00:00:00:00:00') args.push('-m', network.mac);
  args.push('-vs', 'd3d11videosink');
  if (options.fullscreen) args.push('-fs');

  // rotation / mirror flip (projector setups). -r takes the rotate slot, -f the flip slot;
  // 180deg uses the flip slot (I), so 180 + mirror-H collapses to a single V flip.
  const rotate = options.rotate || 'auto';
  const flipH = !!options.flipH;
  if (rotate === 'R' || rotate === 'L') {
    args.push('-r', rotate);
    if (flipH) args.push('-f', 'H');
  } else if (rotate === '180') {
    args.push('-f', flipH ? 'V' : 'I');
  } else if (flipH) {
    args.push('-f', 'H');
  }
  if (options.noAudio) {
    args.push('-as', '0');
  } else {
    args.push('-as', 'wasapisink');
  }

  const env = { ...process.env };
  env.PATH = GST_BIN + ';' + (env.PATH || '');
  env.GST_PLUGIN_PATH = GST_PLUGINS;
  // registry cache must live somewhere writable on user machines
  env.GST_REGISTRY = path.join(app.getPath('userData'), 'gst-registry.bin');

  console.log('Network selected:', network);
  console.log('Starting uxplay:', UXPLAY_PATH, args.join(' '));

  const proc = spawn(UXPLAY_PATH, args, {
    env,
    cwd: path.dirname(UXPLAY_PATH),
    windowsHide: false
  });

  uxplayProcess = proc;
  isRunning = true;
  styledMirrorHwnd = null;
  const mirrorStyleOptions = { ...options, mirrorSize: options.autoStyleMirror === false ? 'iphone' : 'frame' };
  currentPlacement = mirrorStyleOptions;
  if (options.autoStyleMirror !== false) createMirrorFrameWindow();
  startMirrorStyling(mirrorStyleOptions);
  safeSend('uxplay-log', {
    type: 'stdout',
    text: options.noAudio
      ? 'Audio: đang tắt để tối ưu hình.'
      : 'Audio: đang bật qua Windows default output (wasapisink). Nếu không nghe tiếng, kiểm tra Default Output/Mixer của Windows.',
    timestamp: Date.now()
  });

  proc.stdout.on('data', (data) => {
    const text = data.toString().trim();
    console.log('uxplay:', text);
    safeSend('uxplay-log', { type: 'stdout', text, timestamp: Date.now() });
    if (text.includes('Listening') || text.includes('started')) {
      safeSend('uxplay-status', {
        running: true,
        ip: localIP,
        message: `AirPlay ready at ${localIP} (${network.name})`
      });
    }
    // the D3D11 mirror window only exists once streaming begins, which can be long
    // after the initial styling attempts gave up — re-arm styling when a client connects
    if (/starting mirroring|Begin streaming to GStreamer/i.test(text)) {
      styledMirrorHwnd = null;
      startMirrorStyling(currentPlacement || mirrorStyleOptions);
    }
  });

  proc.stderr.on('data', (data) => {
    const text = data.toString().trim();
    console.error('uxplay err:', text);
    safeSend('uxplay-log', { type: 'stderr', text, timestamp: Date.now() });
  });

  proc.on('close', (code) => {
    console.log('uxplay exited with code', code);
    if (uxplayProcess === proc) {
      isRunning = false;
      stopMirrorStyling();
      uxplayProcess = null;
    }
    safeSend('uxplay-status', { running: false, message: 'Stopped' });
  });

  safeSend('uxplay-status', {
    running: true,
    ip: localIP,
    name: serverName,
    message: `Starting AirPlay server (mirror opens in its own window) "${serverName}" at ${localIP} (${network.name})...`
  });
}

function stopUxplay() {
  const proc = uxplayProcess;
  if (proc) {
    proc.kill('SIGTERM');
    setTimeout(() => {
      if (uxplayProcess === proc) proc.kill('SIGKILL');
    }, 3000);
    isRunning = false;
    uxplayProcess = null;
  }
  stopMirrorStyling();
  closeBrightnessWindow();
  if (projectorActive) {
    projectorActive = false;
    globalShortcut.unregister('Escape');
  }
}

function setupAutoUpdater() {
  // Store builds update through Microsoft Store; dev builds have nothing to update
  if (!app.isPackaged || process.windowsStore) return;
  let autoUpdater;
  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch (_) {
    return;
  }
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-available', (info) => {
    safeSend('uxplay-log', { type: 'stdout', text: `Có phiên bản mới ${info.version} — đang tải về nền...`, timestamp: Date.now() });
  });
  autoUpdater.on('download-progress', (p) => {
    if (Math.round(p.percent) % 25 === 0) {
      safeSend('uxplay-log', { type: 'stdout', text: `Đang tải bản cập nhật: ${Math.round(p.percent)}%`, timestamp: Date.now() });
    }
  });
  autoUpdater.on('update-downloaded', async (info) => {
    safeSend('uxplay-log', { type: 'stdout', text: `Bản cập nhật ${info.version} đã sẵn sàng.`, timestamp: Date.now() });
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'Cập nhật sẵn sàng',
      message: `Phiên bản mới ${info.version} đã tải xong.`,
      detail: 'Khởi động lại ngay để cập nhật, hay để lần sau mở app?',
      buttons: ['Khởi động lại ngay', 'Để lần sau'],
      defaultId: 0,
      cancelId: 1
    });
    if (response === 0) {
      stopUxplay();
      autoUpdater.quitAndInstall();
    }
  });
  autoUpdater.on('error', (err) => {
    // no release yet / offline — not fatal, just note it in the console
    console.log('autoUpdater:', err ? err.message : 'unknown error');
  });

  autoUpdater.checkForUpdates().catch(() => {});
  // re-check every 4 hours while the app stays open
  setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 4 * 60 * 60 * 1000);
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
  screen.on('display-added', () => safeSend('displays-changed', {}));
  screen.on('display-removed', () => safeSend('displays-changed', {}));
  setupAutoUpdater();
});

app.on('window-all-closed', () => {
  stopUxplay();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  stopUxplay();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

ipcMain.handle('start-uxplay', async (event, options) => {
  await startUxplay(options);
  return { ok: true };
});

ipcMain.handle('stop-uxplay', () => {
  stopUxplay();
  return { ok: true };
});

ipcMain.handle('get-ip', () => {
  return getLocalIP();
});

ipcMain.handle('mirror-host-resized', async () => {
  return { ok: true };
});

ipcMain.handle('open-mirror-frame', () => {
  createMirrorFrameWindow();
  return { ok: true };
});

let projectorActive = false;

function exitProjector() {
  if (!projectorActive) return;
  projectorActive = false;
  globalShortcut.unregister('Escape');
  currentPlacement = { mirrorSize: 'frame' };
  if (frameWindow && !frameWindow.isDestroyed()) frameWindow.show();
  styleMirrorWindowOnce(currentPlacement);
  safeSend('projector-exited', {});
  safeSend('uxplay-log', { type: 'stdout', text: 'Đã thoát chế độ máy chiếu (Esc).', timestamp: Date.now() });
}

ipcMain.handle('reposition-mirror-window', (event, options) => {
  const opts = options || { mirrorSize: 'frame' };
  // remember the requested placement so the periodic styling loop can't undo it
  currentPlacement = opts;
  stopMirrorStyling();
  if (opts.mirrorSize === 'projector') {
    projectorActive = true;
    globalShortcut.register('Escape', exitProjector);
    // the iPhone frame overlay would float over the fullscreen video — hide it
    if (frameWindow && !frameWindow.isDestroyed()) frameWindow.hide();
    safeSend('uxplay-log', {
      type: 'stdout',
      text: 'Chế độ máy chiếu: bấm phím Esc để thoát toàn màn hình. Nếu màn hình đen là do iPhone chưa phát hình — kết nối AirPlay trước rồi mới bật máy chiếu.',
      timestamp: Date.now()
    });
  } else if (projectorActive) {
    projectorActive = false;
    globalShortcut.unregister('Escape');
    if (frameWindow && !frameWindow.isDestroyed()) frameWindow.show();
  }
  styleMirrorWindowOnce(opts);
  return { ok: true };
});

ipcMain.handle('open-frame-overlay', () => {
  createMirrorFrameWindow();
  return { ok: true };
});

ipcMain.handle('close-frame-overlay', () => {
  closeMirrorFrameWindow();
  return { ok: true };
});

ipcMain.handle('get-displays', () => {
  const primaryId = screen.getPrimaryDisplay().id;
  return screen.getAllDisplays().map((d, i) => ({
    id: d.id,
    label: `${d.label || 'Màn hình ' + (i + 1)} (${d.bounds.width}×${d.bounds.height})${d.id === primaryId ? ' — chính' : ''}`,
    primary: d.id === primaryId
  }));
});

function rotationToDirection(rotate, flipH) {
  if (rotate === 'R') return flipH ? 'ur-ll' : '90r';
  if (rotate === 'L') return flipH ? 'ul-lr' : '90l';
  if (rotate === '180') return flipH ? 'vert' : '180';
  return flipH ? 'horiz' : 'identity';
}

// live rotation via the patched uxplay's stdin — no restart, AirPlay stays connected
ipcMain.handle('set-rotation', (event, opts) => {
  const dir = rotationToDirection((opts && opts.rotate) || 'auto', !!(opts && opts.flipH));
  if (uxplayProcess && uxplayProcess.stdin && uxplayProcess.stdin.writable) {
    uxplayProcess.stdin.write(`vd ${dir}\n`);
    return { ok: true, direction: dir };
  }
  return { ok: false };
});

ipcMain.handle('set-brightness', (event, value) => {
  setBrightness(value);
  return { ok: true };
});

let licensesWindow = null;

ipcMain.handle('open-licenses', () => {
  if (licensesWindow && !licensesWindow.isDestroyed()) {
    licensesWindow.focus();
    return { ok: true };
  }
  licensesWindow = new BrowserWindow({
    width: 720,
    height: 640,
    title: 'Giấy phép mã nguồn mở',
    backgroundColor: '#0f0f1e',
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false }
  });
  licensesWindow.loadFile('licenses.html');
  licensesWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  licensesWindow.on('closed', () => { licensesWindow = null; });
  return { ok: true };
});

ipcMain.handle('open-airplay-guide', () => {
  shell.openExternal('https://support.apple.com/en-us/HT204289');
  return { ok: true };
});
