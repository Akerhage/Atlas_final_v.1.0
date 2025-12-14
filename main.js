//main.js - version 2.0

const { app, BrowserWindow, ipcMain, globalShortcut, clipboard } = require('electron');
const path = require('path');
const { spawn, exec } = require('child_process');
const fs = require('fs');
const dotenv = require('dotenv');

// === KRITISK HACK FÖR ATT IDENTIFIERA SERVERPROCESS ===
const isServerProcess = process.argv.includes(path.join(__dirname, 'server.js'));

if (!isServerProcess) {
  // === SINGLE INSTANCE LOCK ===
  const gotTheLock = app.requestSingleInstanceLock();

  if (!gotTheLock) {
    console.log('[SINGLE INSTANCE] En instans körs redan, avslutar...');
    app.quit();
  } else {
    app.on('second-instance', (event, commandLine, workingDirectory) => {
      console.log('[SINGLE INSTANCE] Försök att starta andra instans blockerad');
      if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.focus();
      }
    });
  }
} // <--- SLUT PÅ IS_SERVER_PROCESS KONTROLL

let loaderWindow = null;
let mainWindow = null;
let serverProcess = null;
let config = {};
let serverVersion = 'Väntar...';

function getRendererPath(filename) {
  if (!app.isPackaged) {
    return path.join(__dirname, 'Renderer', filename);
  }
  return path.join(process.resourcesPath, 'Renderer', filename);
}

function getResourcePath(filename) {
  if (!app.isPackaged) {
    return path.join(__dirname, filename);
  }
  return path.join(process.resourcesPath, filename);
}

process.env.LANG = 'sv_SE.UTF-8';
process.env.LC_ALL = 'sv_SE.UTF-8';
process.env.NODE_NO_WARNINGS = '1';

function killPort3001() {
  return new Promise(resolve => {
    exec('netstat -ano | findstr :3001', (err, stdout) => {
      if (stdout) {
        const pid = stdout.match(/LISTENING\s+(\d+)/)?.[1];
        if (pid) exec(`taskkill /F /PID ${pid}`, () => setTimeout(resolve, 500));
        else resolve();
      } else resolve();
    });
  });
}

const configPath = getResourcePath('config.json');
if (!fs.existsSync(configPath)) { 
  console.error('FATAL: config.json saknas'); 
  app.quit(); 
}
config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

const envPath = getResourcePath('.env');
if (fs.existsSync(envPath)) dotenv.config({ path: envPath });

function createLoaderWindow() {
  loaderWindow = new BrowserWindow({
    width: 300, 
    height: 500, 
    frame: false, 
    transparent: true,
    alwaysOnTop: true, 
    resizable: false, 
    backgroundColor: '#00000000',
    icon: getRendererPath('assets/icons/app/icon.ico'),
    webPreferences: { 
      preload: path.join(__dirname, 'preload-loader.js'), 
      contextIsolation: true, 
      nodeIntegration: false 
    }
  });
  loaderWindow.loadURL(`file://${getRendererPath('loader.html')}`);
}

function createMainWindow() {
  if (mainWindow) return;
  mainWindow = new BrowserWindow({
    width: 1400, 
    height: 1000, 
    show: false,
    icon: getRendererPath('assets/icons/app/icon.ico'),
    autoHideMenuBar: true,
    webPreferences: { 
      preload: path.join(__dirname, 'preload.js'), 
      contextIsolation: true, 
      nodeIntegration: false 
    }
  });
  mainWindow.loadURL(`file://${getRendererPath('index.html')}`);
  mainWindow.once('ready-to-show', () => {
    if (loaderWindow) { 
      loaderWindow.close(); 
      loaderWindow = null; 
    }
    mainWindow.show();
    mainWindow.focus();
  });
}

app.whenReady().then(async () => {
  console.log('=== ATLAS STARTAR ===');
  
  if (isServerProcess) {
    // Servern är redan spawnad och körs som en Node-process i server.js
    // Vi ska inte starta fönster eller server igen.
    // Låt servern (server.js) ta över exekveringen.
    return;
  }
  
  // KLIENTPROCESSENS KOD
  createLoaderWindow();
  await killPort3001();
  const serverPath = path.join(__dirname, 'server.js');

  const serverEnv = {
    ...process.env,
    NODE_ENV: 'production',
    IS_PACKAGED: app.isPackaged ? 'true' : 'false',
    PORT: '3001',
    ELECTRON_RUN_AS_NODE: '1'
  };

  // CRITICAL: Set correct resource path for both modes
  if (app.isPackaged) {
    serverEnv.ATLAS_ROOT_PATH = process.resourcesPath;
    console.log('[SERVER SPAWN] Packaged mode - Resources:', process.resourcesPath);
  } else {
    serverEnv.ATLAS_ROOT_PATH = __dirname;
    console.log('[SERVER SPAWN] Dev mode - Root:', __dirname);
  }

  serverProcess = spawn(
    process.execPath,
    [serverPath],
    {
      cwd: app.isPackaged ? process.resourcesPath : __dirname,
      env: serverEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false
    }
  );

  // Enhanced error logging
  serverProcess.on('error', (err) => {
    console.error('[SERVER SPAWN ERROR]', err);
  });

  serverProcess.on('exit', (code, signal) => {
    console.log(`[SERVER EXIT] Code: ${code}, Signal: ${signal}`);
    // Lägg till en timeout här om du vill att huvudfönstret ska stängas
    // app.quit(); 
  });

  serverProcess.stdout.on('data', d => {
    const out = d.toString().trim();
    console.log(`[Server]: ${out}`);
    const m = out.match(/Version: (\d+\.\d+\.\d+)/);
    if (m) serverVersion = m[1];
  });

  serverProcess.stderr.on('data', d => console.error(`[Server Error]: ${d.toString().trim()}`));

  globalShortcut.register('Control+P', () => {
    if (mainWindow) mainWindow.webContents.send('process-clipboard-text', clipboard.readText().trim(), true);
  });
  
  globalShortcut.register('Control+Alt+P', () => {
    if (mainWindow) mainWindow.webContents.send('process-clipboard-text', clipboard.readText().trim(), false);
  });
});

app.on('will-quit', () => {
  if (serverProcess) serverProcess.kill();
  globalShortcut.unregisterAll();
});

const TEMPLATES_FILE_PATH = getResourcePath('templates.json');

ipcMain.on('loader:done', () => {
  console.log('[LOADER] Loader klar, startar huvudfönster.');
  if (loaderWindow) {
    loaderWindow.close();
    loaderWindow = null;
  }
  createMainWindow();
});

ipcMain.handle('get-app-info', () => ({
  CLIENT_API_KEY: config.CLIENT_API_KEY,
  APP_NAME: config.APP_NAME,
  ATLAS_VERSION: config.VERSION || '1.4.2',
  SERVER_VERSION: serverVersion
}));

ipcMain.handle('load-templates', async () => {
  try { 
    return JSON.parse(await fs.promises.readFile(TEMPLATES_FILE_PATH, 'utf8')); 
  } catch (e) { 
    if (e.code === 'ENOENT') await fs.promises.writeFile(TEMPLATES_FILE_PATH, '[]'); 
    return []; 
  }
});

ipcMain.handle('save-templates', async (_, t) => {
  try { 
    await fs.promises.writeFile(TEMPLATES_FILE_PATH, JSON.stringify(t, null, 4)); 
    return { success: true }; 
  } catch { 
    return { success: false }; 
  }
});