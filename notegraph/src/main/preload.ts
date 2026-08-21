import { contextBridge, ipcRenderer } from 'electron';
import type { IpcRendererEvent } from 'electron';
import { IPC_CHANNELS } from '../shared/ipc';
import type { NotegraphBridge } from '../shared/ipc';
import type { GraphFilter, VaultEvent } from '../shared/types';

const bridge: NotegraphBridge = {
  openVaultDialog: () => ipcRenderer.invoke(IPC_CHANNELS.openVaultDialog),
  openVault: (vaultPath: string) => ipcRenderer.invoke(IPC_CHANNELS.openVault, vaultPath),
  getGraph: (filter?: GraphFilter) => ipcRenderer.invoke(IPC_CHANNELS.getGraph, filter),
  getStats: () => ipcRenderer.invoke(IPC_CHANNELS.getStats),
  readNote: (path: string) => ipcRenderer.invoke(IPC_CHANNELS.readNote, path),
  writeNote: (path: string, content: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.writeNote, path, content),
  createNote: (path: string) => ipcRenderer.invoke(IPC_CHANNELS.createNote, path),
  onVaultEvent: (listener: (event: VaultEvent) => void) => {
    const wrapper = (_ipcEvent: IpcRendererEvent, payload: VaultEvent): void => {
      listener(payload);
    };
    ipcRenderer.on(IPC_CHANNELS.vaultEvent, wrapper);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.vaultEvent, wrapper);
    };
  },
};

contextBridge.exposeInMainWorld('notegraph', bridge);
