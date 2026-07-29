import { readFile, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { MetadataCache, makeFileMetadata } from '../core/metadata_cache';
import { buildGraph, computeStats } from '../core/graph_builder';
import { VaultWatcher } from './vault_watcher';
import type { FileMetadata, GraphData, GraphFilter, VaultEvent, VaultStats } from '../shared/types';

const GRAPH_DEBOUNCE_MS = 150;

interface VaultSession {
  readonly vaultPath: string;
  readonly cache: MetadataCache;
  readonly watcher: VaultWatcher;
  readonly ignoreFilters: ReadonlyArray<string>;
  readonly inFlightReads: Set<Promise<void>>;
  ready: boolean;
  graphTimer: ReturnType<typeof setTimeout> | null;
}

function isFileMissingError(error: unknown): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT';
}

// Obsidian keeps per-vault settings in .obsidian/app.json. The file is
// optional and its schema belongs to Obsidian, so this read is best-effort:
// a missing or malformed file falls back to "no ignore filters" rather than
// failing the vault open.
async function readUserIgnoreFilters(vaultPath: string): Promise<string[]> {
  const appConfigPath = path.join(vaultPath, '.obsidian', 'app.json');
  let raw: string;
  try {
    raw = await readFile(appConfigPath, 'utf8');
  } catch (error) {
    if (!isFileMissingError(error)) {
      console.warn('notegraph: could not read .obsidian/app.json', error);
    }
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === 'object') {
      const filters = (parsed as { userIgnoreFilters?: unknown }).userIgnoreFilters;
      if (Array.isArray(filters)) {
        return filters.filter(
          (entry): entry is string => typeof entry === 'string' && entry !== '',
        );
      }
    }
  } catch (error) {
    console.warn('notegraph: ignoring malformed .obsidian/app.json', error);
  }
  return [];
}

function isIgnoredByFilters(relPath: string, filters: ReadonlyArray<string>): boolean {
  return filters.some((prefix) => relPath.startsWith(prefix));
}

export class VaultService {
  private session: VaultSession | null = null;
  private readonly listeners = new Set<(event: VaultEvent) => void>();

  async open(vaultPath: string): Promise<VaultStats> {
    await this.close();
    const resolvedVaultPath = path.resolve(vaultPath);
    const ignoreFilters = await readUserIgnoreFilters(resolvedVaultPath);
    const session: VaultSession = {
      vaultPath: resolvedVaultPath,
      cache: new MetadataCache(),
      ignoreFilters,
      inFlightReads: new Set(),
      ready: false,
      graphTimer: null,
      watcher: new VaultWatcher({
        onAdd: (relPath, absPath) => this.handleFileUpsert(session, relPath, absPath),
        onChange: (relPath, absPath) => this.handleFileUpsert(session, relPath, absPath),
        onRemove: (relPath) => this.handleFileRemoval(session, relPath),
        onReady: () => {},
      }),
    };
    this.session = session;
    await session.watcher.start(resolvedVaultPath);
    // Reads spawned by initial-scan events may still be in flight when the
    // watcher reports ready; re-check because settling reads can overlap with
    // new events registering more reads.
    while (session.inFlightReads.size > 0) {
      await Promise.allSettled([...session.inFlightReads]);
    }
    if (this.session === session) {
      session.ready = true;
      this.emit({ type: 'ready', fileCount: session.cache.size });
      this.emit({ type: 'graph', graph: buildGraph(session.cache) });
    }
    return computeStats(session.cache, session.vaultPath);
  }

  getGraph(filter?: GraphFilter): GraphData {
    if (this.session === null) {
      return { nodes: [], edges: [] };
    }
    return buildGraph(this.session.cache, filter);
  }

  getStats(): VaultStats | null {
    if (this.session === null) {
      return null;
    }
    return computeStats(this.session.cache, this.session.vaultPath);
  }

  on(listener: (event: VaultEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async close(): Promise<void> {
    const session = this.session;
    if (session === null) {
      return;
    }
    this.session = null;
    if (session.graphTimer !== null) {
      clearTimeout(session.graphTimer);
      session.graphTimer = null;
    }
    await session.watcher.close();
  }

  private handleFileUpsert(session: VaultSession, relPath: string, absPath: string): void {
    if (isIgnoredByFilters(relPath, session.ignoreFilters)) {
      return;
    }
    if (session.ready) {
      this.emit({ type: 'file-changed', path: relPath });
    }
    const tracked: Promise<void> = this.ingestFile(session, relPath, absPath).finally(() => {
      session.inFlightReads.delete(tracked);
    });
    session.inFlightReads.add(tracked);
  }

  private handleFileRemoval(session: VaultSession, relPath: string): void {
    if (isIgnoredByFilters(relPath, session.ignoreFilters)) {
      return;
    }
    session.cache.deleteFile(relPath);
    if (session.ready) {
      this.emit({ type: 'file-removed', path: relPath });
      this.scheduleGraphEmission(session);
    }
  }

  // Never rejects: every failure path is handled here so in-flight tracking
  // and the open() drain loop can rely on settled promises.
  private async ingestFile(session: VaultSession, relPath: string, absPath: string): Promise<void> {
    try {
      let metadata: FileMetadata;
      if (relPath.toLowerCase().endsWith('.md')) {
        const source = await readFile(absPath, 'utf8');
        const stats = await stat(absPath);
        metadata = makeFileMetadata(relPath, source, { mtimeMs: stats.mtimeMs, size: stats.size });
      } else {
        const stats = await stat(absPath);
        metadata = makeFileMetadata(relPath, null, { mtimeMs: stats.mtimeMs, size: stats.size });
      }
      if (this.session !== session) {
        return;
      }
      session.cache.setFile(metadata);
      if (session.ready) {
        this.scheduleGraphEmission(session);
      }
    } catch (error) {
      if (isFileMissingError(error)) {
        // The file vanished between the watcher event and our read.
        if (this.session !== session) {
          return;
        }
        session.cache.deleteFile(relPath);
        if (session.ready) {
          this.scheduleGraphEmission(session);
        }
      } else {
        console.error(`notegraph: failed to index ${relPath}`, error);
      }
    }
  }

  private scheduleGraphEmission(session: VaultSession): void {
    if (session.graphTimer !== null) {
      clearTimeout(session.graphTimer);
    }
    session.graphTimer = setTimeout(() => {
      session.graphTimer = null;
      if (this.session !== session) {
        return;
      }
      this.emit({ type: 'graph', graph: buildGraph(session.cache) });
    }, GRAPH_DEBOUNCE_MS);
  }

  private emit(event: VaultEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch (error) {
        // A throwing subscriber must not break indexing or other subscribers.
        console.error('notegraph: vault event listener failed', error);
      }
    }
  }
}
