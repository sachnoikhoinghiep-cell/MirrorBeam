const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const { spawn, execFile } = require('child_process');

let mainWindow;
let frameWindow = null;
let uxplayProcess = null;
let isRunning = false;
let mirrorStyleTimer = null;
let styledMirrorHwnd = null;

const UXPLAY_PATH = app.isPackaged
  ? path.join(process.resourcesPath, 'uxplay.exe')
  : path.join(__dirname, '..', 'uxplay-src', 'build', 'uxplay.exe');

const MSYS2_UCRT64_BIN = 'C:\\tools\\msys64\\ucrt64\\bin';
const WINDOW_STYLER = app.isPackaged
  ? path.join(process.resourcesPath, 'window-styler.ps1')
  : path.join(__dirname, 'window-styler.ps1');
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: 'iPhone Mirror - AirPlay Receiver',
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
    title: 'iPhone Mirror Frame',
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
  frameWindow.on('move', () => styleMirrorWindowOnce({ mirrorSize: 'frame' }));
  frameWindow.on('resize', () => styleMirrorWindowOnce({ mirrorSize: 'frame' }));
  frameWindow.on('closed', () => { frameWindow = null; });
}

function getFrameVideoBounds() {
  if (!frameWindow || frameWindow.isDestroyed()) return null;
  const b = frameWindow.getBounds();
  // Match the transparent iPhone shell: video lives inside the black frame,
  // leaving room for notch/home indicator.
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

function sendMirrorWindowStatus(message, extra = {}) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('mirror-embed-status', {
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

function computeMirrorPlacement(options = {}) {
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

  execFile('powershell.exe', args, { windowsHide: true, timeout: 8000 }, (err, stdout, stderr) => {
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
        sendMirrorWindowStatus('Đã tự đặt cửa sổ mirror thành kiểu màn hình iPhone', { styled: true, ...result });
        if (frameWindow && !frameWindow.isDestroyed()) frameWindow.moveTop();
        if (firstStyle && mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('uxplay-log', { type: 'stdout', text: `Đã đặt cửa sổ mirror vào khung iPhone kéo được: ${result.title || 'unknown'} / ${result.class || 'unknown'} (${result.width}x${result.height}).`, timestamp: Date.now() });
        }
      }
    } catch (_) {
      // Ignore non-json helper output.
    }
  });
}

function startMirrorStyling(options = {}) {
  stopMirrorStyling();
  sendMirrorWindowStatus('Khi iPhone kết nối, app sẽ tự biến cửa sổ mirror thành kiểu màn hình iPhone.', { styled: false });
  mirrorStyleTimer = setInterval(() => styleMirrorWindowOnce(options), 1200);
  styleMirrorWindowOnce(options);
}

function killStaleUxplayProcesses() {
  return new Promise((resolve) => {
    execFile('taskkill.exe', ['/IM', 'uxplay.exe', '/F', '/T'], { windowsHide: true, timeout: 5000 }, () => resolve());
  });
}

function getPrimaryNetwork() {
  const interfaces = require('os').networkInterfaces();
  const badNames = /vEthernet|Virtual|Loopback|Host-Only|VMware|VirtualBox|Npcap|Tailscale|ZeroTier/i;
  const candidates = [];

  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
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
    mainWindow.webContents.send('uxplay-status', { running: true, message: 'Already running' });
    return;
  }

  await killStaleUxplayProcesses();

  const network = getPrimaryNetwork();
  const localIP = network.address;
  const serverName = options.name || 'iPhone Mirror';

  const args = [];
  if (options.name) args.push('-n', options.name);
  args.push('-nh');
  if (network.mac && network.mac !== '00:00:00:00:00:00') args.push('-m', network.mac);
  // Stable mode: keep the GStreamer/UxPlay renderer as a normal native window.
  // Re-parenting this window into Electron caused frozen/black renders on Windows.
  args.push('-vs', 'd3d11videosink');
  if (options.fullscreen) args.push('-fs');
  if (options.noAudio) {
    args.push('-as', '0');
  } else {
    // WASAPI uses the Windows default output device. If there is no sound, set
    // the desired speaker/headphone as Default Device in Windows Sound settings.
    args.push('-as', 'wasapisink');
  }

  const env = { ...process.env };
  env.PATH = MSYS2_UCRT64_BIN + ';' + (env.PATH || '');
  env.GST_PLUGIN_PATH = 'C:\\tools\\msys64\\ucrt64\\lib\\gstreamer-1.0';

  console.log('Network selected:', network);
  console.log('Starting uxplay:', UXPLAY_PATH, args.join(' '));

  uxplayProcess = spawn(UXPLAY_PATH, args, {
    env,
    cwd: path.dirname(UXPLAY_PATH),
    windowsHide: false
  });

  isRunning = true;
  styledMirrorHwnd = null;
  if (options.autoStyleMirror !== false) createMirrorFrameWindow();
  startMirrorStyling({ ...options, mirrorSize: options.autoStyleMirror === false ? 'iphone' : 'frame' });
  mainWindow.webContents.send('uxplay-log', {
    type: 'stdout',
    text: options.noAudio
      ? 'Audio: đang tắt để tối ưu hình.'
      : 'Audio: đang bật qua Windows default output (wasapisink). Nếu không nghe tiếng, kiểm tra Default Output/Mixer của Windows.',
    timestamp: Date.now()
  });

  uxplayProcess.stdout.on('data', (data) => {
    const text = data.toString().trim();
    console.log('uxplay:', text);
    mainWindow.webContents.send('uxplay-log', { type: 'stdout', text, timestamp: Date.now() });

    if (text.includes('Listening') || text.includes('started')) {
      mainWindow.webContents.send('uxplay-status', {
        running: true,
        ip: localIP,
        message: `AirPlay ready at ${localIP} (${network.name})`
      });
    }
  });

  uxplayProcess.stderr.on('data', (data) => {
    const text = data.toString().trim();
    console.error('uxplay err:', text);
    mainWindow.webContents.send('uxplay-log', { type: 'stderr', text, timestamp: Date.now() });
  });

  uxplayProcess.on('close', (code) => {
    console.log('uxplay exited with code', code);
    isRunning = false;
    stopMirrorStyling();
    uxplayProcess = null;
    mainWindow.webContents.send('uxplay-status', { running: false, message: 'Stopped' });
  });

  mainWindow.webContents.send('uxplay-status', {
    running: true,
    ip: localIP,
    name: serverName,
    message: `Starting AirPlay server (mirror opens in its own window) "${serverName}" at ${localIP} (${network.name})...`
  });
}

function stopUxplay() {
  if (uxplayProcess) {
    uxplayProcess.kill('SIGTERM');
    setTimeout(() => {
      if (uxplayProcess) {
        uxplayProcess.kill('SIGKILL');
      }
    }, 3000);
    isRunning = false;
  }
  stopMirrorStyling();
  }

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  stopUxplay();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  stopUxplay();
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
  // Kept for preload/UI compatibility.
  return { ok: true };
});

ipcMain.handle('open-frame-overlay', () => {
  createFrameWindow();
  return { ok: true };
});

ipcMain.handle('close-frame-overlay', () => {
    return { ok: true };
});

ipcMain.handle('open-airplay-guide', () => {
  shell.openExternal('https://support.apple.com/en-us/HT204289');
  return { ok: true };
});
