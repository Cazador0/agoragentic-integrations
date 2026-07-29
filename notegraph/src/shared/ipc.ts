/**
 * IPC channel contract between the Electron main process and the renderer.
 *
 * The preload script exposes `window.notegraph` (NotegraphBridge) via
 * contextBridge; the renderer must never touch Node/Electron APIs directly.
 */

import type { GraphData, GraphFilter, VaultEvent, VaultStats } from './types';

export const IPC_CHANNELS = {
  /** invoke: renderer → main. Opens a directory picker; resolves with the
   * chosen vault path or null when cancelled. */
  openVaultDialog: 'notegraph:open-vault-dialog',
  /** invoke: renderer → main. Load a vault at an explicit path. */
  openVault: 'notegraph:open-vault',
  /** invoke: renderer → main. Returns the current full graph snapshot. */
  getGraph: 'notegraph:get-graph',
  /** invoke: renderer → main. Returns VaultStats or null when no vault. */
  getStats: 'notegraph:get-stats',
  /** send: main → renderer. Streams VaultEvent updates. */
  vaultEvent: 'notegraph:vault-event',
} as const;

export interface NotegraphBridge {
  openVaultDialog(): Promise<string | null>;
  openVault(vaultPath: string): Promise<VaultStats>;
  getGraph(filter?: GraphFilter): Promise<GraphData>;
  getStats(): Promise<VaultStats | null>;
  /** Subscribe to vault events; returns an unsubscribe function. */
  onVaultEvent(listener: (event: VaultEvent) => void): () => void;
}

declare global {
  interface Window {
    notegraph: NotegraphBridge;
  }
}
