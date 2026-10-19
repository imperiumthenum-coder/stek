import { app, BrowserWindow, dialog, shell } from 'electron';
import path from 'path';
import { startServer } from '../../backend/src/server';

// Stek desktop: runs the backend inside the app on localhost and shows the UI in a window.
// A fixed port keeps the page origin stable, so browser-side prefs (watchlist,
// indicators) survive restarts; if it's taken we fall back to any free port.
const PREFERRED_PORT = 47321;

let server: Awaited<ReturnType<typeof startServer>> | null = null;
let win: BrowserWindow | null = null;

async function start() {
  const dataDir = app.getPath('userData'); // per-user app data folder on every OS
  // Packaged: the built frontend ships as an extra resource. Unpackaged: use the repo build.
  const staticDir = app.isPackaged
    ? path.join(process.resourcesPath, 'web')
    : path.join(__dirname, '../../frontend/dist');

  const opts = { dataDir, staticDir, host: '127.0.0.1', archiveDir: process.env.ARCHIVE_DIR };
  try {
    server = await startServer({ ...opts, port: PREFERRED_PORT });
  } catch {
    server = await startServer({ ...opts, port: 0 });
  }

  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#131722',
    title: 'Stek',
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });

  // Links to other sites open in the user's browser, not inside the app
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(`http://127.0.0.1:${server!.port}`)) {
      e.preventDefault();
      shell.openExternal(url);
    }
  });

  await win.loadURL(`http://127.0.0.1:${server.port}`);
}

// One window, one backend: a second launch just focuses the running app
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(() =>
    start().catch((e) => {
      dialog.showErrorBox('Stek could not start', String(e?.stack || e));
      app.quit();
    })
  );

  // Quit when the window closes, on macOS too: the backend lives with the window
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => server?.close());
}
