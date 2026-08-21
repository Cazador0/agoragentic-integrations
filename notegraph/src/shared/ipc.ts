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
  /** invoke: renderer → main. Reads one vault-relative note as UTF-8 text. */
  readNote: 'notegraph:read-note',
  /** invoke: renderer → main. Writes UTF-8 text to a vault-relative note. */
  writeNote: 'notegraph:write-note',
  /** invoke: renderer → main. Creates a new empty note, returning its path. */
  createNote: 'notegraph:create-note',
} as const;

export interface NotegraphBridge {
  openVaultDialog(): Promise<string | null>;
  openVault(vaultPath: string): Promise<VaultStats>;
  getGraph(filter?: GraphFilter): Promise<GraphData>;
  getStats(): Promise<VaultStats | null>;
  /** Subscribe to vault events; returns an unsubscribe function. */
  onVaultEvent(listener: (event: VaultEvent) => void): () => void;

  // --- Editing -------------------------------------------------------------
  // All paths are vault-relative with '/' separators. The main process must
  // reject any path that escapes the open vault, and rejects entirely when no
  // vault is open.

  /** Reads a markdown note's UTF-8 contents. */
  readNote(path: string): Promise<string>;
  /** Overwrites a markdown note with `content`. */
  writeNote(path: string, content: string): Promise<void>;
  /** Creates a new empty markdown note. `path` is a requested vault-relative
   * path (with or without a .md extension); the resolved path actually
   * created is returned, which may differ if the requested name was taken. */
  createNote(path: string): Promise<string>;
}

declare global {
  interface Window {
    notegraph: NotegraphBridge;
  }
}
