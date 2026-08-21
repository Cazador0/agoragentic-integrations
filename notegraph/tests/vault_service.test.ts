import { mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { VaultService, resolveVaultNotePath } from '../src/main/vault_service';
import { DEFAULT_GRAPH_FILTER } from '../src/shared/types';
import type { GraphData, VaultEvent } from '../src/shared/types';

type GraphEvent = Extract<VaultEvent, { type: 'graph' }>;
type ReadyEvent = Extract<VaultEvent, { type: 'ready' }>;

let service: VaultService | null = null;
let vaultDir: string | null = null;

afterEach(async () => {
  if (service !== null) {
    await service.close();
    service = null;
  }
  if (vaultDir !== null) {
    await rm(vaultDir, { recursive: true, force: true });
    vaultDir = null;
  }
});

async function createVault(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'notegraph-vault-'));
  vaultDir = dir;
  for (const [relPath, content] of Object.entries(files)) {
    const absPath = path.join(dir, relPath);
    await mkdir(path.dirname(absPath), { recursive: true });
    await writeFile(absPath, content, 'utf8');
  }
  return dir;
}

function waitForEvent(
  vaultService: VaultService,
  predicate: (event: VaultEvent) => boolean,
  timeoutMs = 10000,
): Promise<VaultEvent> {
  return new Promise<VaultEvent>((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`timed out after ${timeoutMs}ms waiting for a matching vault event`));
    }, timeoutMs);
    const unsubscribe = vaultService.on((event) => {
      if (predicate(event)) {
        clearTimeout(timer);
        unsubscribe();
        resolve(event);
      }
    });
  });
}

async function waitForGraph(
  vaultService: VaultService,
  predicate: (graph: GraphData) => boolean,
  timeoutMs = 10000,
): Promise<GraphData> {
  const event = await waitForEvent(
    vaultService,
    (candidate) => candidate.type === 'graph' && predicate(candidate.graph),
    timeoutMs,
  );
  return (event as GraphEvent).graph;
}

function hasNode(graph: GraphData, id: string): boolean {
  return graph.nodes.some((node) => node.id === id);
}

function hasEdge(graph: GraphData, source: string, target: string): boolean {
  return graph.edges.some((edge) => edge.source === source && edge.target === target);
}

describe('VaultService', () => {
  test('open() scans the vault, ignores dot entries and userIgnoreFilters, and reports ready + initial graph', async () => {
    const dir = await createVault({
      'Alpha.md': '# Alpha\n\nLinks to [[Beta]].\n',
      'Beta.md': '# Beta\n\nNo outgoing links.\n',
      'diagram.png': 'not-a-real-png',
      '.obsidian/app.json': '{"userIgnoreFilters": ["ignored-folder/"]}',
      '.hidden.md': 'dotfiles must be ignored\n',
      'ignored-folder/Skipped.md': 'excluded by userIgnoreFilters\n',
    });
    service = new VaultService();
    const events: VaultEvent[] = [];
    service.on((event) => {
      events.push(event);
    });

    const stats = await service.open(dir);

    expect(stats.fileCount).toBe(3);
    expect(stats.noteCount).toBe(2);
    expect(stats.attachmentCount).toBe(1);

    const readyEvent = events.find((event): event is ReadyEvent => event.type === 'ready');
    expect(readyEvent).toBeDefined();
    expect(readyEvent?.fileCount).toBe(3);

    const graphEvent = events.find((event): event is GraphEvent => event.type === 'graph');
    expect(graphEvent).toBeDefined();
    const graph = (graphEvent as GraphEvent).graph;
    expect(hasNode(graph, 'Alpha.md')).toBe(true);
    expect(hasNode(graph, 'Beta.md')).toBe(true);
    expect(hasNode(graph, 'diagram.png')).toBe(true);
    expect(hasNode(graph, '.hidden.md')).toBe(false);
    expect(hasNode(graph, 'ignored-folder/Skipped.md')).toBe(false);
    expect(hasEdge(graph, 'Alpha.md', 'Beta.md')).toBe(true);
  });

  test('live edits produce graph events: add link, remove link, delete target', async () => {
    const dir = await createVault({
      'Alpha.md': 'Links to [[Beta]].\n',
      'Beta.md': 'Nothing here.\n',
    });
    service = new VaultService();
    await service.open(dir);

    const gammaAddedPromise = waitForGraph(
      service,
      (graph) => hasNode(graph, 'Gamma.md') && hasEdge(graph, 'Gamma.md', 'Alpha.md'),
    );
    await writeFile(path.join(dir, 'Gamma.md'), 'See [[Alpha]] for details.\n', 'utf8');
    const graphWithGamma = await gammaAddedPromise;
    expect(hasNode(graphWithGamma, 'Gamma.md')).toBe(true);
    expect(hasEdge(graphWithGamma, 'Gamma.md', 'Alpha.md')).toBe(true);

    const linkRemovedPromise = waitForGraph(
      service,
      (graph) => hasNode(graph, 'Gamma.md') && !hasEdge(graph, 'Gamma.md', 'Alpha.md'),
    );
    await writeFile(path.join(dir, 'Gamma.md'), 'No more links here.\n', 'utf8');
    const graphWithoutLink = await linkRemovedPromise;
    expect(hasNode(graphWithoutLink, 'Gamma.md')).toBe(true);
    expect(hasEdge(graphWithoutLink, 'Gamma.md', 'Alpha.md')).toBe(false);

    const targetDeletedPromise = waitForGraph(
      service,
      (graph) => !hasNode(graph, 'Beta.md') && hasNode(graph, 'unresolved:beta'),
    );
    await unlink(path.join(dir, 'Beta.md'));
    const graphAfterDelete = await targetDeletedPromise;
    expect(hasNode(graphAfterDelete, 'Beta.md')).toBe(false);
    expect(hasNode(graphAfterDelete, 'unresolved:beta')).toBe(true);
    expect(hasEdge(graphAfterDelete, 'Alpha.md', 'unresolved:beta')).toBe(true);
  });

  test('live edits also emit per-file events before the debounced graph', async () => {
    const dir = await createVault({
      'Solo.md': 'Just one note.\n',
    });
    service = new VaultService();
    await service.open(dir);

    const fileChangedPromise = waitForEvent(
      service,
      (event) => event.type === 'file-changed' && event.path === 'Another.md',
    );
    await writeFile(path.join(dir, 'Another.md'), 'A second note.\n', 'utf8');
    await fileChangedPromise;

    const fileRemovedPromise = waitForEvent(
      service,
      (event) => event.type === 'file-removed' && event.path === 'Another.md',
    );
    await waitForGraph(service, (graph) => hasNode(graph, 'Another.md'));
    await unlink(path.join(dir, 'Another.md'));
    await fileRemovedPromise;
  });

  test('getStats() is null and getGraph() is empty before a vault is opened', () => {
    service = new VaultService();
    expect(service.getStats()).toBeNull();
    expect(service.getGraph()).toEqual({ nodes: [], edges: [] });
  });

  test('getGraph() respects a filter such as showUnresolved: false', async () => {
    const dir = await createVault({
      'Alpha.md': 'Points at [[Missing]].\n',
    });
    service = new VaultService();
    await service.open(dir);

    const unfilteredGraph = service.getGraph();
    expect(hasNode(unfilteredGraph, 'unresolved:missing')).toBe(true);
    expect(hasEdge(unfilteredGraph, 'Alpha.md', 'unresolved:missing')).toBe(true);

    const filteredGraph = service.getGraph({ ...DEFAULT_GRAPH_FILTER, showUnresolved: false });
    expect(filteredGraph.nodes.some((node) => node.kind === 'unresolved')).toBe(false);
    expect(hasNode(filteredGraph, 'Alpha.md')).toBe(true);
    expect(hasEdge(filteredGraph, 'Alpha.md', 'unresolved:missing')).toBe(false);
  });
});

describe('lifecycle races', () => {
  test('close() issued right after open() lets open settle instead of hanging', async () => {
    const files: Record<string, string> = {};
    for (let index = 0; index < 60; index++) {
      files[`note-${index}.md`] = `# Note ${index}\n[[note-${(index + 1) % 60}]]\n`;
    }
    const dir = await createVault(files);
    service = new VaultService();

    const opening = service.open(dir);
    const closing = service.close();
    await expect(Promise.all([opening, closing])).resolves.toBeDefined();
    expect(service.getStats()).toBeNull();
  }, 20000);

  test('back-to-back open() calls leave only the second vault active', async () => {
    const firstDir = await createVault({ 'first.md': '# First\n' });
    const secondDir = await mkdtemp(path.join(tmpdir(), 'notegraph-vault2-'));
    await writeFile(path.join(secondDir, 'second.md'), '# Second\n', 'utf8');
    try {
      service = new VaultService();
      const firstOpen = service.open(firstDir);
      const secondOpen = service.open(secondDir);
      await Promise.all([firstOpen, secondOpen]);

      const stats = service.getStats();
      expect(stats?.vaultPath).toBe(path.resolve(secondDir));
      expect(stats?.noteCount).toBe(1);
      const graph = service.getGraph(DEFAULT_GRAPH_FILTER);
      expect(graph.nodes.map((node) => node.id)).toEqual(['second.md']);

      // The first vault's watcher must be closed: changes there produce no events.
      let sawFirstVaultEvent = false;
      const unsubscribe = service.on((event) => {
        if (event.type === 'file-changed' && event.path === 'first.md') {
          sawFirstVaultEvent = true;
        }
      });
      await writeFile(path.join(firstDir, 'first.md'), '# First edited\n', 'utf8');
      await new Promise((resolve) => setTimeout(resolve, 700));
      unsubscribe();
      expect(sawFirstVaultEvent).toBe(false);
    } finally {
      await rm(secondDir, { recursive: true, force: true });
    }
  }, 20000);
});

describe('vault path validation and symlinks', () => {
  test('open() rejects a nonexistent path and a regular file', async () => {
    const dir = await createVault({ 'note.md': '# Note\n' });
    service = new VaultService();
    await expect(service.open(path.join(dir, 'missing-subdir'))).rejects.toThrow(
      /not a directory/,
    );
    await expect(service.open(path.join(dir, 'note.md'))).rejects.toThrow(/not a directory/);
    expect(service.getStats()).toBeNull();
  });

  test('a symlink cycle inside the vault does not duplicate files', async () => {
    const dir = await createVault({
      'a.md': '# A\n[[b]]\n',
      'b.md': '# B\n',
    });
    await mkdir(path.join(dir, 'sub'), { recursive: true });
    const { symlink } = await import('node:fs/promises');
    await symlink('..', path.join(dir, 'sub', 'loop'), 'dir');

    service = new VaultService();
    const stats = await service.open(dir);
    expect(stats.fileCount).toBe(2);
    expect(stats.noteCount).toBe(2);
    const graph = service.getGraph();
    expect(graph.nodes.map((node) => node.id).sort()).toEqual(['a.md', 'b.md']);
  }, 20000);
});

describe('resolveVaultNotePath', () => {
  const root = '/vault';

  test('accepts a normal nested note path', () => {
    expect(resolveVaultNotePath(root, 'projects/Roadmap.md')).toBe(
      path.join(root, 'projects', 'Roadmap.md'),
    );
  });

  test('rejects traversal, absolute paths, and non-markdown targets', () => {
    expect(() => resolveVaultNotePath(root, '../outside.md')).toThrow(/escapes the vault/);
    expect(() => resolveVaultNotePath(root, '/etc/passwd')).toThrow(/vault-relative/);
    expect(() => resolveVaultNotePath(root, 'sub/../../x.md')).toThrow(/escapes the vault/);
    expect(() => resolveVaultNotePath(root, '')).toThrow(/non-empty string/);
    expect(() => resolveVaultNotePath(root, 'note.txt')).toThrow(/must end in \.md/);
    expect(() => resolveVaultNotePath(root, 'C:/x.md')).toThrow(/vault-relative/);
  });
});

describe('note read/write/create', () => {
  test('readNote and writeNote round-trip content and the watcher re-indexes it', async () => {
    const dir = await createVault({ 'a.md': '# A\n' });
    service = new VaultService();
    await service.open(dir);

    expect(await service.readNote('a.md')).toBe('# A\n');
    await service.writeNote('a.md', '# A\n[[b]]\n');
    await waitForGraph(service, (graph) =>
      graph.nodes.some((node) => node.id === 'unresolved:b'),
    );
    expect(await service.readNote('a.md')).toBe('# A\n[[b]]\n');
  }, 20000);

  test('readNote rejects a missing file', async () => {
    const dir = await createVault({ 'a.md': '# A\n' });
    service = new VaultService();
    await service.open(dir);
    await expect(service.readNote('missing.md')).rejects.toThrow();
  });

  test('createNote creates an empty file and de-duplicates a taken name', async () => {
    const dir = await createVault({ 'a.md': '# A\n' });
    service = new VaultService();
    await service.open(dir);

    const firstPath = await service.createNote('Untitled');
    expect(firstPath).toBe('Untitled.md');
    expect(await service.readNote('Untitled.md')).toBe('');

    const secondPath = await service.createNote('Untitled.md');
    expect(secondPath).toBe('Untitled 2.md');

    const nestedPath = await service.createNote('sub/deep/Note');
    expect(nestedPath).toBe('sub/deep/Note.md');
  }, 20000);

  test('readNote, writeNote, and createNote reject when no vault is open', async () => {
    service = new VaultService();
    await expect(service.readNote('a.md')).rejects.toThrow(/no vault is open/);
    await expect(service.writeNote('a.md', 'x')).rejects.toThrow(/no vault is open/);
    await expect(service.createNote('a')).rejects.toThrow(/no vault is open/);
  });
});
