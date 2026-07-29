import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import * as path from 'node:path';
import { IPC_CHANNELS } from '../shared/ipc';
import type { GraphFilter } from '../shared/types';
import { VaultService } from './vault_service';

const vaultService = new VaultService();
let mainWindow: BrowserWindow | null = null;

function resolveStartupVaultPath(): string | null {
  const flagIndex = process.argv.indexOf('--vault');
  if (flagIndex !== -1) {
    const flagValue = process.argv[flagIndex + 1];
    if (flagValue !== undefined && flagValue !== '') {
      return flagValue;
    }
  }
  const environmentValue = process.env['NOTEGRAPH_VAULT'];
  if (environmentValue !== undefined && environmentValue !== '') {
    return environmentValue;
  }
  return null;
}

function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1400,
    height: 900,
    backgroundColor: '#101014',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  window.loadFile(path.join(__dirname, '../renderer/index.html')).catch((error) => {
    console.error('notegraph: failed to load renderer', error);
  });
  return window;
}

ipcMain.handle(IPC_CHANNELS.openVaultDialog, async (): Promise<string | null> => {
  const result = await dialog.showOpenDialog({ properties: ['openDirectory'] });
  if (result.canceled) {
    return null;
  }
  return result.filePaths[0] ?? null;
});

ipcMain.handle(IPC_CHANNELS.openVault, (_event, vaultPath: string) =>
  vaultService.open(path.resolve(vaultPath)),
);

ipcMain.handle(IPC_CHANNELS.getGraph, (_event, filter?: GraphFilter) =>
  vaultService.getGraph(filter),
);

ipcMain.handle(IPC_CHANNELS.getStats, () => vaultService.getStats());

vaultService.on((event) => {
  const window = mainWindow;
  if (window !== null && !window.isDestroyed()) {
    window.webContents.send(IPC_CHANNELS.vaultEvent, event);
  }
});

app
  .whenReady()
  .then(() => {
    mainWindow = createMainWindow();
    const startupVaultPath = resolveStartupVaultPath();
    if (startupVaultPath !== null) {
      // Wait for the renderer before indexing so it cannot miss the initial
      // ready/graph events pushed over IPC.
      mainWindow.webContents.once('did-finish-load', () => {
        vaultService.open(path.resolve(startupVaultPath)).catch((error) => {
          console.error(`notegraph: failed to open startup vault ${startupVaultPath}`, error);
        });
      });
    }
  })
  .catch((error) => {
    console.error('notegraph: failed to initialize application', error);
  });

// Single-window utility app: a lingering hidden process (the macOS default)
// would leave no way to reopen the window, so quit on every platform.
app.on('window-all-closed', () => {
  app.quit();
});

app.on('before-quit', () => {
  vaultService.close().catch((error) => {
    console.error('notegraph: failed to close vault service', error);
  });
});
