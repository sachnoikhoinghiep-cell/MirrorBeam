const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const { spawn, execFile } = require('child_process');

let mainWindow;
let uxplayProcess = null;
let isRunning = false;
let lastMirrorBounds = null;
let embeddedMirrorHwnd = null;

const UXPLAY_PATH = app.isPackaged
  ? path.join(process.resourcesPath, 'uxplay.exe')
  : path.join(__dirname, '..', 'uxplay-src', 'build', 'uxplay.exe');

const MSYS2_UCRT64_BIN = 'C:\\tools\\msys64\\ucrt64\\bin';
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

function sendMirrorWindowStatus(message, extra = {}) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('mirror-embed-status', {
    message,
    embedded: false,
    externalWindow: true,
    ...extra
  });
}

function stopMirrorEmbedding() {
  // Legacy no-op: v1 tried to re-parent the native GStreamer window into Electron.
  // On Windows this often freezes rendering. The stable mode keeps UxPlay's
  // native mirror window as its own top-level window and lets Electron act as
  // a controller/log panel only.
  embeddedMirrorHwnd = null;
}

function startMirrorEmbedding() {
  sendMirrorWindowStatus('AirPlay sẽ mở ở cửa sổ mirror riêng để tránh kẹt render.', {
    hint: 'Nếu cửa sổ mirror nằm sau app, bấm Alt+Tab hoặc thu nhỏ cửa sổ điều khiển.'
  });
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
  embeddedMirrorHwnd = null;
  startMirrorEmbedding();

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
    stopMirrorEmbedding();
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
  stopMirrorEmbedding();
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

ipcMain.handle('mirror-host-resized', async (event, bounds) => {
  // Kept for preload/UI compatibility. Stable mode no longer embeds or resizes
  // the native mirror window inside Electron.
  lastMirrorBounds = bounds;
  return { ok: true };
});

ipcMain.handle('open-airplay-guide', () => {
  shell.openExternal('https://support.apple.com/en-us/HT204289');
  return { ok: true };
});
