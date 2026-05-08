import path from 'node:path';
import fs from 'node:fs';

import { app, BrowserWindow, ipcMain, nativeImage, powerMonitor, Tray } from 'electron';
import { Agent } from 'undici';

import { normalizeLocale } from '../shared/localization.js';
import type { AppSettings } from '../shared/types.js';
import { TrackerService } from './core/tracker-service.js';

const isDev = !app.isPackaged;
const devServerUrl = process.env.VITE_DEV_SERVER_URL;
let tracker: TrackerService | null = null;
let mainWindow: BrowserWindow | null = null;
let miniWindow: BrowserWindow | null = null;
let tray: Tray | null = null;

const ollamaDispatcher = new Agent({
  headersTimeout: 600_000,
  bodyTimeout: 600_000,
  connect: { timeout: 30_000 },
  keepAliveTimeout: 60_000,
  keepAliveMaxTimeout: 600_000,
});

function broadcastSettingsChanged(settings: AppSettings): void {
  for (const win of [mainWindow, miniWindow]) {
    if (win && !win.isDestroyed()) {
      win.webContents.send('settings:changed', settings);
    }
  }
}

function getTrayIconPath(): string {
  const resourceDir = isDev
    ? path.join(__dirname, '../../resources')
    : path.join(process.resourcesPath, 'resources');
  const iconPath = path.join(resourceDir, 'trayIconTemplate.png');
  if (!fs.existsSync(iconPath)) {
    fs.mkdirSync(resourceDir, { recursive: true });
    const size = 22;
    const buf = Buffer.alloc(size * size * 4, 0);
    const cx = size / 2;
    const cy = size / 2;
    const r = 4;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const dist = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
        if (dist <= r) {
          const idx = (y * size + x) * 4;
          buf[idx] = 0;
          buf[idx + 1] = 0;
          buf[idx + 2] = 0;
          buf[idx + 3] = 255;
        }
      }
    }
    const img = nativeImage.createFromBuffer(buf, { width: size, height: size });
    fs.writeFileSync(iconPath, img.toPNG());
  }
  return iconPath;
}

function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 680,
    minHeight: 500,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#f4f5f7',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (isDev) {
    void win.loadURL(devServerUrl ?? 'http://127.0.0.1:5173');
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    void win.loadFile(path.join(__dirname, '../../dist/index.html'));
  }

  win.on('closed', () => { mainWindow = null; });
  return win;
}

function createMiniWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 300,
    height: 200,
    show: false,
    frame: false,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    backgroundColor: '#ffffff',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (isDev) {
    void win.loadURL(`${devServerUrl ?? 'http://127.0.0.1:5173'}/mini.html`);
  } else {
    void win.loadFile(path.join(__dirname, '../../dist/mini.html'));
  }

  win.on('blur', () => { win.hide(); });
  win.on('closed', () => { miniWindow = null; });
  return win;
}

function createTray(): void {
  const iconPath = getTrayIconPath();
  const icon = nativeImage.createFromPath(iconPath);
  icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setToolTip('My Loggy');

  tray.on('click', (_event, bounds) => {
    if (!miniWindow) {
      miniWindow = createMiniWindow();
    }
    if (miniWindow.isVisible()) {
      miniWindow.hide();
      return;
    }
    const { x, y } = bounds;
    const { width } = miniWindow.getBounds();
    miniWindow.setPosition(Math.round(x - width / 2), y);
    miniWindow.show();
  });
}

function showAndFocusMainWindow(): void {
  if (!mainWindow) {
    mainWindow = createMainWindow();
    return;
  }
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.show();
  mainWindow.focus();
}

if (!app.isPackaged) {
  // Unpackaged Electron shares default userData with other Electron apps; single-instance lock would not
  // exclude a second myloggy dev instance. Pin userData to the historical dev DB folder.
  app.setName('myloggy');
  const userDataDir = path.join(app.getPath('appData'), 'Electron', 'myloggy-data');
  app.setPath('userData', userDataDir);
}

const primaryInstanceLock = app.requestSingleInstanceLock();
if (!primaryInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    showAndFocusMainWindow();
  });

  app.whenReady().then(() => {
    const trackerBaseDir = app.isPackaged
      ? path.join(app.getPath('userData'), 'myloggy-data')
      : app.getPath('userData');
    tracker = new TrackerService(trackerBaseDir, normalizeLocale(app.getLocale()));
    powerMonitor.on('suspend', () => {
      tracker?.onSuspend();
    });
    powerMonitor.on('resume', () => {
      tracker?.onResume();
    });
    tracker.start();
    createTray();
    mainWindow = createMainWindow();

    app.on('activate', () => {
      if (!mainWindow) {
        mainWindow = createMainWindow();
      } else {
        mainWindow.show();
      }
    });
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  tracker?.dispose();
});

function requireTracker(): TrackerService {
  if (!tracker) {
    throw new Error('Tracker is not initialized');
  }
  return tracker;
}

ipcMain.handle('bootstrap', (_event, date: string) => requireTracker().getBootstrap(date));
ipcMain.handle('dashboard:get', (_event, date: string) => requireTracker().getDashboard(date));
ipcMain.handle('timeline:day', (_event, date: string) => requireTracker().getDayTimeline(date));
ipcMain.handle('timeline:week', (_event, date: string) => requireTracker().getWeekTimeline(date));
ipcMain.handle('timeline:month', (_event, date: string) => requireTracker().getMonthTimeline(date));
ipcMain.handle('settings:get', () => requireTracker().getSettings());
ipcMain.handle('settings:update', (_event, patch) => {
  const settings = requireTracker().updateSettings(patch);
  broadcastSettingsChanged(settings);
  return settings;
});
ipcMain.handle('tracking:toggle', (_event, enabled: boolean) => requireTracker().setTracking(enabled));
ipcMain.handle('tracking:capture-now', () => requireTracker().captureNow());
ipcMain.handle('tracking:analyze-now', () => requireTracker().analyzeNow());
ipcMain.handle('tracking:clear-pending', () => requireTracker().clearPendingSnapshots());
ipcMain.handle('tracking:clear-errors', () => requireTracker().clearErrors());
ipcMain.handle('work-unit:update', (_event, patch) => requireTracker().updateWorkUnit(patch));
ipcMain.handle('open-dashboard', () => {
  showAndFocusMainWindow();
});
ipcMain.handle('debug:data', () => requireTracker().getDebugData());
ipcMain.handle('ollama:check', async () => {
  const settings = requireTracker().getSettings();
  try {
    const res = await fetch(`${settings.ollamaHost}/api/tags`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return { running: false, models: [] };
    const data = (await res.json()) as { models?: { name: string }[] };
    const models = (data.models ?? []).map((m) => m.name);
    return { running: true, models };
  } catch {
    return { running: false, models: [] };
  }
});
ipcMain.handle('ollama:test-model', async (_event, params: { model: string; ollamaHost: string }) => {
  try {
    const res = await fetch(`${params.ollamaHost}/api/generate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(30000),
      body: JSON.stringify({
        model: params.model,
        prompt: 'Reply with OK.',
        stream: false,
        keep_alive: '30m',
        options: {
          temperature: 0,
          num_predict: 8,
        },
      }),
      dispatcher: ollamaDispatcher,
    } as Parameters<typeof fetch>[1] & { dispatcher: Agent });

    const data = await res.json().catch(() => ({})) as { error?: string };
    if (!res.ok) {
      return {
        ok: false,
        message: data.error ? String(data.error) : `HTTP ${res.status}`,
      };
    }

    return {
      ok: true,
      message: 'Model responded successfully.',
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : 'Model check failed.',
    };
  }
});
