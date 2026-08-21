import { describe, expect, test } from 'vitest';
import { buildGraph, computeStats } from '../src/core/graph_builder';
import { MetadataCache, makeFileMetadata } from '../src/core/metadata_cache';
import type { GraphData, GraphEdge, GraphFilter, GraphNode } from '../src/shared/types';

function buildCache(files: Record<string, string | null>): MetadataCache {
  const cache = new MetadataCache();
  for (const [filePath, source] of Object.entries(files)) {
    cache.setFile(
      makeFileMetadata(filePath, source, {
        mtimeMs: 1000,
        size: source === null ? 0 : source.length,
      }),
    );
  }
  return cache;
}

function nodeById(graph: GraphData, id: string): GraphNode {
  const node = graph.nodes.find((candidate) => candidate.id === id);
  if (node === undefined) {
    throw new Error(`expected node ${id} in graph`);
  }
  return node;
}

function edgeBetween(graph: GraphData, source: string, target: string): GraphEdge {
  const edge = graph.edges.find(
    (candidate) => candidate.source === source && candidate.target === target,
  );
  if (edge === undefined) {
    throw new Error(`expected edge ${source} -> ${target} in graph`);
  }
  return edge;
}

function nodeIds(graph: GraphData): string[] {
  return graph.nodes.map((node) => node.id);
}

function filterWith(overrides: Partial<GraphFilter>): GraphFilter {
  return {
    showAttachments: true,
    showUnresolved: true,
    showTags: true,
    showOrphans: true,
    query: '',
    ...overrides,
  };
}

const VAULT: Record<string, string | null> = {
  'Alpha.md': [
    '#Topic',
    '[[Beta]] and [[Beta]] again',
    '![[image.png]]',
    '[[Ghost Note]]',
    '[[#local]]',
    '[[Alpha]]',
    '',
  ].join('\n'),
  'Beta.md': ['#topic', '[[Alpha]]', '![[Alpha]]', '[[ghost note]]', ''].join('\n'),
  'Delta.md': ['![[image.png]]', '![[image.png]]', ''].join('\n'),
  'Epsilon.md': '#topic only\n',
  'Gamma.md': 'Nothing links here.\n',
  'image.png': null,
};

describe('buildGraph nodes', () => {
  test('every file becomes a note or attachment node with basename label and file fields', () => {
    const graph = buildGraph(buildCache(VAULT));

    const alpha = nodeById(graph, 'Alpha.md');
    expect(alpha.kind).toBe('note');
    expect(alpha.label).toBe('Alpha');
    expect(alpha.path).toBe('Alpha.md');
    expect(alpha.mtimeMs).toBe(1000);
    expect(alpha.tags).toEqual(['Topic']);

    const image = nodeById(graph, 'image.png');
    expect(image.kind).toBe('attachment');
    expect(image.label).toBe('image');
    expect(image.path).toBe('image.png');
    expect(image.tags).toEqual([]);
  });

  test('one unresolved node per distinct lowercase text, labeled by first encounter in path order', () => {
    const graph = buildGraph(buildCache(VAULT));

    const unresolvedNodes = graph.nodes.filter((node) => node.kind === 'unresolved');
    expect(unresolvedNodes).toHaveLength(1);
    const ghost = nodeById(graph, 'unresolved:ghost note');
    // Alpha.md sorts before Beta.md, so Alpha's casing wins.
    expect(ghost.label).toBe('Ghost Note');
    expect(ghost.path).toBeUndefined();
  });

  test('one tag node per distinct lowercase tag, labeled # + first-seen casing in path order', () => {
    const graph = buildGraph(buildCache(VAULT));

    const tagNodes = graph.nodes.filter((node) => node.kind === 'tag');
    expect(tagNodes).toHaveLength(1);
    const topic = nodeById(graph, 'tag:topic');
    expect(topic.label).toBe('#Topic');
    expect(topic.path).toBeUndefined();
  });

  test('omitted filter includes everything: attachments, unresolved, tag hubs, orphans', () => {
    const graph = buildGraph(buildCache(VAULT));
    expect(nodeIds(graph)).toEqual([
      'Alpha.md',
      'Beta.md',
      'Delta.md',
      'Epsilon.md',
      'Gamma.md',
      'image.png',
      'tag:topic',
      'unresolved:ghost note',
    ]);
  });
});

describe('buildGraph edges', () => {
  test('occurrences merge per (source, target) with count', () => {
    const graph = buildGraph(buildCache(VAULT));
    const alphaToBeta = edgeBetween(graph, 'Alpha.md', 'Beta.md');
    expect(alphaToBeta.count).toBe(2);
    expect(alphaToBeta.kind).toBe('link');
  });

  test('kind is embed only when all merged occurrences are embeds', () => {
    const graph = buildGraph(buildCache(VAULT));

    expect(edgeBetween(graph, 'Alpha.md', 'image.png')).toEqual({
      source: 'Alpha.md',
      target: 'image.png',
      kind: 'embed',
      count: 1,
    });
    expect(edgeBetween(graph, 'Delta.md', 'image.png')).toEqual({
      source: 'Delta.md',
      target: 'image.png',
      kind: 'embed',
      count: 2,
    });
    // Beta has [[Alpha]] and ![[Alpha]]: mixed occurrences demote to link.
    expect(edgeBetween(graph, 'Beta.md', 'Alpha.md')).toEqual({
      source: 'Beta.md',
      target: 'Alpha.md',
      kind: 'link',
      count: 2,
    });
  });

  test('self-loops are dropped, including [[#subpath]] self-references', () => {
    const graph = buildGraph(buildCache(VAULT));
    expect(graph.edges.some((edge) => edge.source === edge.target)).toBe(false);
    // Alpha contains [[Alpha]] and [[#local]]; neither may survive.
    expect(
      graph.edges.filter((edge) => edge.source === 'Alpha.md' && edge.target === 'Alpha.md'),
    ).toEqual([]);
  });

  test('unresolved references produce edges to the unresolved node', () => {
    const graph = buildGraph(buildCache(VAULT));
    expect(edgeBetween(graph, 'Alpha.md', 'unresolved:ghost note')).toEqual({
      source: 'Alpha.md',
      target: 'unresolved:ghost note',
      kind: 'link',
      count: 1,
    });
    expect(edgeBetween(graph, 'Beta.md', 'unresolved:ghost note').count).toBe(1);
  });

  test('tag edges are file -> tag node with kind tag and count 1', () => {
    const graph = buildGraph(buildCache(VAULT));
    const tagEdges = graph.edges.filter((edge) => edge.kind === 'tag');
    expect(tagEdges).toEqual([
      { source: 'Alpha.md', target: 'tag:topic', kind: 'tag', count: 1 },
      { source: 'Beta.md', target: 'tag:topic', kind: 'tag', count: 1 },
      { source: 'Epsilon.md', target: 'tag:topic', kind: 'tag', count: 1 },
    ]);
  });

  test('full edge list matches expectation', () => {
    const graph = buildGraph(buildCache(VAULT));
    expect(graph.edges).toEqual([
      { source: 'Alpha.md', target: 'Beta.md', kind: 'link', count: 2 },
      { source: 'Alpha.md', target: 'image.png', kind: 'embed', count: 1 },
      { source: 'Alpha.md', target: 'tag:topic', kind: 'tag', count: 1 },
      { source: 'Alpha.md', target: 'unresolved:ghost note', kind: 'link', count: 1 },
      { source: 'Beta.md', target: 'Alpha.md', kind: 'link', count: 2 },
      { source: 'Beta.md', target: 'tag:topic', kind: 'tag', count: 1 },
      { source: 'Beta.md', target: 'unresolved:ghost note', kind: 'link', count: 1 },
      { source: 'Delta.md', target: 'image.png', kind: 'embed', count: 2 },
      { source: 'Epsilon.md', target: 'tag:topic', kind: 'tag', count: 1 },
    ]);
  });
});

describe('degrees', () => {
  test('degrees count distinct merged link/embed edges and exclude tag edges', () => {
    const graph = buildGraph(buildCache(VAULT));

    expect(nodeById(graph, 'Alpha.md')).toMatchObject({ inDegree: 1, outDegree: 3 });
    expect(nodeById(graph, 'Beta.md')).toMatchObject({ inDegree: 1, outDegree: 2 });
    expect(nodeById(graph, 'Delta.md')).toMatchObject({ inDegree: 0, outDegree: 1 });
    expect(nodeById(graph, 'image.png')).toMatchObject({ inDegree: 2, outDegree: 0 });
    expect(nodeById(graph, 'unresolved:ghost note')).toMatchObject({ inDegree: 2, outDegree: 0 });
    // Epsilon only carries a tag; tag edges never contribute to file degrees.
    expect(nodeById(graph, 'Epsilon.md')).toMatchObject({ inDegree: 0, outDegree: 0 });
    // The tag hub itself scales with usage: one inbound per tagged file.
    expect(nodeById(graph, 'tag:topic')).toMatchObject({ inDegree: 3, outDegree: 0 });
    expect(nodeById(graph, 'Gamma.md')).toMatchObject({ inDegree: 0, outDegree: 0 });
  });

  test('degrees are computed on the full graph and survive filtering', () => {
    const cache = buildCache(VAULT);
    const graph = buildGraph(cache, filterWith({ showAttachments: false, showUnresolved: false }));

    // Alpha's edges to image.png and the unresolved node are hidden, but its
    // full-graph degrees remain.
    expect(nodeById(graph, 'Alpha.md')).toMatchObject({ inDegree: 1, outDegree: 3 });
    expect(nodeById(graph, 'Delta.md')).toMatchObject({ inDegree: 0, outDegree: 1 });
    expect(
      graph.edges.filter((edge) => edge.source === 'Alpha.md' && edge.kind !== 'tag'),
    ).toEqual([{ source: 'Alpha.md', target: 'Beta.md', kind: 'link', count: 2 }]);
  });
});

describe('filters', () => {
  test('showAttachments false removes attachment nodes and incident edges', () => {
    const graph = buildGraph(buildCache(VAULT), filterWith({ showAttachments: false }));
    expect(nodeIds(graph)).not.toContain('image.png');
    expect(graph.edges.some((edge) => edge.target === 'image.png')).toBe(false);
    expect(graph.edges).toHaveLength(7);
  });

  test('showUnresolved false removes unresolved nodes and incident edges', () => {
    const graph = buildGraph(buildCache(VAULT), filterWith({ showUnresolved: false }));
    expect(graph.nodes.some((node) => node.kind === 'unresolved')).toBe(false);
    expect(graph.edges.some((edge) => edge.target === 'unresolved:ghost note')).toBe(false);
    expect(graph.edges).toHaveLength(7);
  });

  test('showTags false removes tag nodes and tag edges', () => {
    const graph = buildGraph(buildCache(VAULT), filterWith({ showTags: false }));
    expect(graph.nodes.some((node) => node.kind === 'tag')).toBe(false);
    expect(graph.edges.some((edge) => edge.kind === 'tag')).toBe(false);
    expect(graph.edges).toHaveLength(6);
  });

  test('query keeps only label matches (case-insensitive) plus edges between kept nodes', () => {
    const graph = buildGraph(buildCache(VAULT), filterWith({ query: 'A' }));
    // Labels containing "a": Alpha, Beta, Delta, Gamma, image.
    expect(nodeIds(graph)).toEqual(['Alpha.md', 'Beta.md', 'Delta.md', 'Gamma.md', 'image.png']);
    expect(graph.edges).toEqual([
      { source: 'Alpha.md', target: 'Beta.md', kind: 'link', count: 2 },
      { source: 'Alpha.md', target: 'image.png', kind: 'embed', count: 1 },
      { source: 'Beta.md', target: 'Alpha.md', kind: 'link', count: 2 },
      { source: 'Delta.md', target: 'image.png', kind: 'embed', count: 2 },
    ]);
  });

  test('query matching a single node keeps it as an orphan when showOrphans is true', () => {
    const graph = buildGraph(buildCache(VAULT), filterWith({ query: 'GAMMA' }));
    expect(nodeIds(graph)).toEqual(['Gamma.md']);
    expect(graph.edges).toEqual([]);
  });

  test('showOrphans false removes nodes with no remaining edges; tag edges keep a node visible', () => {
    const graph = buildGraph(buildCache(VAULT), filterWith({ showOrphans: false }));
    expect(nodeIds(graph)).not.toContain('Gamma.md');
    // Epsilon's only edge is its tag edge, which still counts as visible.
    expect(nodeIds(graph)).toContain('Epsilon.md');
  });

  test('kind toggles apply before orphan removal', () => {
    const graph = buildGraph(
      buildCache(VAULT),
      filterWith({ showAttachments: false, showOrphans: false }),
    );
    // Delta only pointed at the hidden attachment, so it became an orphan.
    expect(nodeIds(graph)).toEqual([
      'Alpha.md',
      'Beta.md',
      'Epsilon.md',
      'tag:topic',
      'unresolved:ghost note',
    ]);
  });

  test('hiding tags before orphan removal drops tag-only notes', () => {
    const graph = buildGraph(
      buildCache(VAULT),
      filterWith({ showTags: false, showOrphans: false }),
    );
    expect(nodeIds(graph)).not.toContain('Epsilon.md');
    expect(nodeIds(graph)).toContain('Alpha.md');
  });

  test('query applies before orphan removal', () => {
    const graph = buildGraph(
      buildCache(VAULT),
      filterWith({ query: 'alp', showOrphans: false }),
    );
    // Alpha matches the query but all of its edges left with the other nodes.
    expect(graph.nodes).toEqual([]);
    expect(graph.edges).toEqual([]);
  });

  test('empty query filters nothing', () => {
    const unfiltered = buildGraph(buildCache(VAULT));
    const emptyQuery = buildGraph(buildCache(VAULT), filterWith({ query: '' }));
    expect(emptyQuery).toEqual(unfiltered);
  });
});

describe('determinism', () => {
  test('two builds of the same cache are deep-equal and sorted', () => {
    const cache = buildCache(VAULT);
    const first = buildGraph(cache);
    const second = buildGraph(cache);
    expect(second).toEqual(first);

    const ids = nodeIds(first);
    expect(ids).toEqual([...ids].sort());
    const edgeKeys = first.edges.map((edge) => `${edge.source} ${edge.target} ${edge.kind}`);
    expect(edgeKeys).toEqual([...edgeKeys].sort());
  });

  test('insertion order into the cache does not change the output', () => {
    const forward = buildGraph(buildCache(VAULT));
    const reversedEntries = Object.fromEntries(Object.entries(VAULT).reverse());
    const backward = buildGraph(buildCache(reversedEntries));
    expect(backward).toEqual(forward);
  });
});

describe('computeStats', () => {
  test('counts files, notes, attachments and distinct lowercase unresolved texts', () => {
    const stats = computeStats(buildCache(VAULT), '/vaults/demo');
    expect(stats).toEqual({
      vaultPath: '/vaults/demo',
      fileCount: 6,
      noteCount: 5,
      attachmentCount: 1,
      unresolvedCount: 1,
    });
  });

  test('unresolvedCount dedupes case-insensitively across files', () => {
    const cache = buildCache({
      'one.md': '[[Missing Thing]] [[Other Gap]]\n',
      'two.md': '[[missing thing]]\n',
    });
    expect(computeStats(cache, 'v').unresolvedCount).toBe(2);
  });

  test('empty cache produces zeroed stats', () => {
    expect(computeStats(new MetadataCache(), 'v')).toEqual({
      vaultPath: 'v',
      fileCount: 0,
      noteCount: 0,
      attachmentCount: 0,
      unresolvedCount: 0,
    });
  });
});
