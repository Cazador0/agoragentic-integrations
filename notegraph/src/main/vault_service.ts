import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
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

/** Resolves a vault-relative note path to an absolute path INSIDE vaultRoot,
 * or throws. Rejects absolute paths, drive prefixes, any path that escapes
 * vaultRoot via '..' (checked after normalization so mixed separators and
 * encoded traversal cannot slip through), empty paths, and anything that
 * does not name a .md file — read/write/create only ever touch notes. */
export function resolveVaultNotePath(vaultRoot: string, relPath: string): string {
  if (typeof relPath !== 'string' || relPath === '') {
    throw new Error('note path must be a non-empty string');
  }
  if (relPath.startsWith('/') || relPath.startsWith('\\') || /^[a-zA-Z]:/.test(relPath)) {
    throw new Error(`note path must be vault-relative: ${relPath}`);
  }
  const normalized = path.normalize(relPath).split(path.sep).join('/');
  if (normalized === '.' || normalized === '' || normalized.split('/').includes('..')) {
    throw new Error(`note path escapes the vault: ${relPath}`);
  }
  if (!normalized.toLowerCase().endsWith('.md')) {
    throw new Error(`note path must end in .md: ${relPath}`);
  }
  const resolvedRoot = path.resolve(vaultRoot);
  const absolutePath = path.resolve(resolvedRoot, normalized);
  const relativeToRoot = path.relative(resolvedRoot, absolutePath);
  if (relativeToRoot === '' || relativeToRoot.startsWith('..') || path.isAbsolute(relativeToRoot)) {
    throw new Error(`note path escapes the vault: ${relPath}`);
  }
  return absolutePath;
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
  // Serializes open()/close() so a later call always sees — and closes — the
  // earlier call's session; overlapping opens would otherwise orphan a live
  // chokidar watcher for the process lifetime.
  private lifecycle: Promise<unknown> = Promise.resolve();
  private readonly listeners = new Set<(event: VaultEvent) => void>();

  async open(vaultPath: string): Promise<VaultStats> {
    const run = this.lifecycle.catch(() => {}).then(() => this.openInternal(vaultPath));
    this.lifecycle = run;
    return run;
  }

  async close(): Promise<void> {
    const run = this.lifecycle.catch(() => {}).then(() => this.closeInternal());
    this.lifecycle = run;
    return run;
  }

  private async openInternal(vaultPath: string): Promise<VaultStats> {
    await this.closeInternal();
    const resolvedVaultPath = path.resolve(vaultPath);
    const vaultStat = await stat(resolvedVaultPath).catch(() => null);
    if (vaultStat === null || !vaultStat.isDirectory()) {
      // Without this check a bad --vault flag or file path "succeeds" with an
      // empty graph and the user gets no signal that the path was wrong.
      throw new Error(`vault path is not a directory: ${resolvedVaultPath}`);
    }
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

  async readNote(relPath: string): Promise<string> {
    const session = this.requireSession();
    const absolutePath = resolveVaultNotePath(session.vaultPath, relPath);
    return readFile(absolutePath, 'utf8');
  }

  async writeNote(relPath: string, content: string): Promise<void> {
    const session = this.requireSession();
    const absolutePath = resolveVaultNotePath(session.vaultPath, relPath);
    // The watcher picks up this write and emits its own debounced graph event;
    // no need to touch the cache here.
    await writeFile(absolutePath, content, 'utf8');
  }

  async createNote(requestedRelPath: string): Promise<string> {
    const session = this.requireSession();
    const withExtension = requestedRelPath.toLowerCase().endsWith('.md')
      ? requestedRelPath
      : `${requestedRelPath}.md`;
    const absoluteRoot = resolveVaultNotePath(session.vaultPath, withExtension);
    const extension = '.md';
    const withoutExtension = absoluteRoot.slice(0, -extension.length);
    await mkdir(path.dirname(absoluteRoot), { recursive: true });
    let candidate = absoluteRoot;
    let suffix = 2;
    // 'wx' makes the write itself the atomic existence check, so a file
    // created between our probe and the write (e.g. by an external editor)
    // still cannot be overwritten — we just retry the next suffix.
    for (;;) {
      try {
        await writeFile(candidate, '', { encoding: 'utf8', flag: 'wx' });
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw error;
        }
        candidate = `${withoutExtension} ${suffix}${extension}`;
        suffix += 1;
      }
    }
    return path.relative(session.vaultPath, candidate).split(path.sep).join('/');
  }

  private requireSession(): VaultSession {
    if (this.session === null) {
      throw new Error('no vault is open');
    }
    return this.session;
  }

  private async closeInternal(): Promise<void> {
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
