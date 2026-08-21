import * as path from 'node:path';
import { watch, type FSWatcher } from 'chokidar';
import { ATTACHMENT_EXTENSIONS } from '../shared/types';

export interface VaultWatcherCallbacks {
  onAdd(relPath: string, absPath: string): void;
  onChange(relPath: string, absPath: string): void;
  onRemove(relPath: string, absPath: string): void;
  onReady(): void;
}

function toPosixPath(candidate: string): string {
  return candidate.split(path.sep).join('/');
}

function hasWatchedExtension(relPath: string): boolean {
  const lastSlashIndex = relPath.lastIndexOf('/');
  const fileName = lastSlashIndex === -1 ? relPath : relPath.slice(lastSlashIndex + 1);
  const lastDotIndex = fileName.lastIndexOf('.');
  if (lastDotIndex <= 0) {
    return false;
  }
  const extension = fileName.slice(lastDotIndex + 1).toLowerCase();
  return extension === 'md' || ATTACHMENT_EXTENSIONS.has(extension);
}

export class VaultWatcher {
  private readonly callbacks: VaultWatcherCallbacks;
  private watcher: FSWatcher | undefined;
  private vaultRoot = '';
  private pendingReady: (() => void) | null = null;

  constructor(callbacks: VaultWatcherCallbacks) {
    this.callbacks = callbacks;
  }

  async start(vaultPath: string): Promise<void> {
    await this.close();
    this.vaultRoot = path.resolve(vaultPath);

    const watcher = watch(this.vaultRoot, {
      ignored: (candidatePath: string) => this.hasDotSegment(candidatePath),
      ignoreInitial: false,
      // A symlink cycle inside the vault would otherwise recurse until ELOOP,
      // indexing every note dozens of times under distinct relative paths.
      followSymlinks: false,
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
    });
    this.watcher = watcher;

    watcher.on('add', (eventPath: string) => {
      this.emitFileEvent(this.callbacks.onAdd, eventPath);
    });
    watcher.on('change', (eventPath: string) => {
      this.emitFileEvent(this.callbacks.onChange, eventPath);
    });
    watcher.on('unlink', (eventPath: string) => {
      this.emitFileEvent(this.callbacks.onRemove, eventPath);
    });
    watcher.on('error', (error) => {
      console.error('notegraph: vault watcher error', error);
    });

    await new Promise<void>((resolve) => {
      this.pendingReady = resolve;
      watcher.once('ready', () => {
        this.pendingReady = null;
        this.callbacks.onReady();
        resolve();
      });
    });
  }

  async close(): Promise<void> {
    const watcher = this.watcher;
    if (!watcher) {
      return;
    }
    this.watcher = undefined;
    await watcher.close();
    // chokidar's close() removes all listeners, so a 'ready' that never fired
    // would leave start() pending forever; settle it here instead.
    const pending = this.pendingReady;
    this.pendingReady = null;
    pending?.();
  }

  // chokidar's `ignored` matcher may run without stats, so directories can
  // only be excluded by dotted name segments here; filtering by extension
  // would drop directories like "notes.old" and unwatch their subtrees.
  private hasDotSegment(candidatePath: string): boolean {
    const relative = path.relative(this.vaultRoot, path.resolve(candidatePath));
    if (relative === '') {
      return false;
    }
    return toPosixPath(relative)
      .split('/')
      .some((segment) => segment.startsWith('.'));
  }

  private emitFileEvent(
    callback: (relPath: string, absPath: string) => void,
    eventPath: string,
  ): void {
    const absPath = path.resolve(this.vaultRoot, eventPath);
    const relative = path.relative(this.vaultRoot, absPath);
    if (relative === '' || relative.startsWith('..')) {
      return;
    }
    const relPath = toPosixPath(relative);
    if (relPath.split('/').some((segment) => segment.startsWith('.'))) {
      return;
    }
    if (!hasWatchedExtension(relPath)) {
      return;
    }
    callback(relPath, absPath);
  }
}
