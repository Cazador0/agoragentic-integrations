import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import * as path from 'node:path';
import { IPC_CHANNELS } from '../shared/ipc';
import { DEFAULT_GRAPH_FILTER } from '../shared/types';
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
      sandbox: true,
    },
  });
  // The window must never leave the packaged renderer: Electron's default
  // would navigate to any file dropped onto the window, replacing the app UI
  // and running that document with the preload bridge exposed.
  window.webContents.on('will-navigate', (event) => {
    event.preventDefault();
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.loadFile(path.join(__dirname, '../renderer/index.html')).catch((error) => {
    console.error('notegraph: failed to load renderer', error);
  });
  return window;
}

// IPC payloads are renderer-supplied and may be partial or mistyped; clamp to
// a well-formed GraphFilter instead of letting buildGraph throw.
function sanitizeGraphFilter(candidate: unknown): GraphFilter {
  const filter = { ...DEFAULT_GRAPH_FILTER };
  if (candidate === null || typeof candidate !== 'object') {
    return filter;
  }
  const record = candidate as Record<string, unknown>;
  for (const flag of [
    'showAttachments',
    'showUnresolved',
    'showTags',
    'showMentions',
    'showOrphans',
  ] as const) {
    if (typeof record[flag] === 'boolean') {
      filter[flag] = record[flag];
    }
  }
  if (typeof record['query'] === 'string') {
    filter.query = record['query'];
  }
  return filter;
}

ipcMain.handle(IPC_CHANNELS.openVaultDialog, async (): Promise<string | null> => {
  const result = await dialog.showOpenDialog({ properties: ['openDirectory'] });
  if (result.canceled) {
    return null;
  }
  return result.filePaths[0] ?? null;
});

ipcMain.handle(IPC_CHANNELS.openVault, (_event, vaultPath: unknown) => {
  if (typeof vaultPath !== 'string' || vaultPath === '') {
    throw new Error('vault path must be a non-empty string');
  }
  return vaultService.open(path.resolve(vaultPath));
});

ipcMain.handle(IPC_CHANNELS.getGraph, (_event, filter?: unknown) =>
  vaultService.getGraph(filter === undefined ? undefined : sanitizeGraphFilter(filter)),
);

ipcMain.handle(IPC_CHANNELS.getStats, () => vaultService.getStats());

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

ipcMain.handle(IPC_CHANNELS.readNote, (_event, notePath: unknown) =>
  vaultService.readNote(requireNonEmptyString(notePath, 'note path')),
);

ipcMain.handle(IPC_CHANNELS.writeNote, (_event, notePath: unknown, content: unknown) => {
  const path_ = requireNonEmptyString(notePath, 'note path');
  if (typeof content !== 'string') {
    throw new Error('note content must be a string');
  }
  return vaultService.writeNote(path_, content);
});

ipcMain.handle(IPC_CHANNELS.createNote, (_event, notePath: unknown) =>
  vaultService.createNote(requireNonEmptyString(notePath, 'note path')),
);

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
