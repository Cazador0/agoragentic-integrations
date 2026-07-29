import { mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { VaultService } from '../src/main/vault_service';
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
