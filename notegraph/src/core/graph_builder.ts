import type { MetadataCache } from './metadata_cache';
import type {
  GraphData,
  GraphEdge,
  GraphFilter,
  GraphNode,
  NodeKind,
  VaultStats,
} from '../shared/types';

/** Omitted filter means "include everything" — the renderer filters
 * client-side, so the full graph (tag hubs included) is the default. */
const INCLUDE_EVERYTHING: GraphFilter = {
  showAttachments: true,
  showUnresolved: true,
  showTags: true,
  showOrphans: true,
  query: '',
};

function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

interface EdgeAccumulator {
  count: number;
  embedOnly: boolean;
}

export function buildGraph(cache: MetadataCache, filter?: GraphFilter): GraphData {
  const effectiveFilter = filter ?? INCLUDE_EVERYTHING;
  const files = cache.files().sort((a, b) => compareStrings(a.path, b.path));

  const nodesById = new Map<string, GraphNode>();
  for (const meta of files) {
    nodesById.set(meta.path, {
      id: meta.path,
      kind: meta.isMarkdown ? 'note' : 'attachment',
      label: meta.basename,
      path: meta.path,
      mtimeMs: meta.mtimeMs,
      tags: [...meta.tags],
      inDegree: 0,
      outDegree: 0,
    });
  }

  const accumulatorsBySource = new Map<string, Map<string, EdgeAccumulator>>();
  for (const meta of files) {
    for (const ref of cache.getRefs(meta.path)) {
      let targetId: string;
      if (ref.resolvedPath !== null) {
        targetId = ref.resolvedPath;
      } else {
        targetId = 'unresolved:' + ref.text.toLowerCase();
        if (!nodesById.has(targetId)) {
          nodesById.set(targetId, {
            id: targetId,
            kind: 'unresolved',
            label: ref.text,
            inDegree: 0,
            outDegree: 0,
          });
        }
      }
      if (targetId === meta.path) {
        continue;
      }
      let accumulatorsByTarget = accumulatorsBySource.get(meta.path);
      if (accumulatorsByTarget === undefined) {
        accumulatorsByTarget = new Map();
        accumulatorsBySource.set(meta.path, accumulatorsByTarget);
      }
      const accumulator = accumulatorsByTarget.get(targetId);
      if (accumulator === undefined) {
        accumulatorsByTarget.set(targetId, { count: 1, embedOnly: ref.embed });
      } else {
        accumulator.count += 1;
        accumulator.embedOnly &&= ref.embed;
      }
    }
  }

  const edges: GraphEdge[] = [];
  for (const [source, accumulatorsByTarget] of accumulatorsBySource) {
    for (const [target, accumulator] of accumulatorsByTarget) {
      edges.push({
        source,
        target,
        kind: accumulator.embedOnly ? 'embed' : 'link',
        count: accumulator.count,
      });
    }
  }

  // Degrees are defined over the merged link/embed edges of the FULL graph,
  // before any filtering, so filtered views still show true connectivity.
  for (const edge of edges) {
    const sourceNode = nodesById.get(edge.source);
    if (sourceNode !== undefined) {
      sourceNode.outDegree += 1;
    }
    const targetNode = nodesById.get(edge.target);
    if (targetNode !== undefined) {
      targetNode.inDegree += 1;
    }
  }

  for (const meta of files) {
    for (const tag of meta.tags) {
      const tagId = 'tag:' + tag.toLowerCase();
      let tagNode = nodesById.get(tagId);
      if (tagNode === undefined) {
        tagNode = {
          id: tagId,
          kind: 'tag',
          label: '#' + tag,
          inDegree: 0,
          outDegree: 0,
        };
        nodesById.set(tagId, tagNode);
      }
      edges.push({ source: meta.path, target: tagId, kind: 'tag', count: 1 });
      // Tag edges stay out of file-node degrees, but the hub itself must scale
      // with usage (as unresolved hubs do), so it takes the inbound count.
      tagNode.inDegree += 1;
    }
  }

  const filtered = applyFilter([...nodesById.values()], edges, effectiveFilter);
  filtered.nodes.sort((a, b) => compareStrings(a.id, b.id));
  filtered.edges.sort(
    (a, b) =>
      compareStrings(a.source, b.source) ||
      compareStrings(a.target, b.target) ||
      compareStrings(a.kind, b.kind),
  );
  return filtered;
}

function applyFilter(nodes: GraphNode[], edges: GraphEdge[], filter: GraphFilter): GraphData {
  let keptNodes = nodes;
  let keptEdges = edges;

  const hiddenKinds = new Set<NodeKind>();
  if (!filter.showAttachments) {
    hiddenKinds.add('attachment');
  }
  if (!filter.showUnresolved) {
    hiddenKinds.add('unresolved');
  }
  if (!filter.showTags) {
    hiddenKinds.add('tag');
  }
  if (hiddenKinds.size > 0) {
    keptNodes = keptNodes.filter((node) => !hiddenKinds.has(node.kind));
    keptEdges = restrictEdgesToNodes(keptEdges, keptNodes);
  }

  if (filter.query !== '') {
    const lowerQuery = filter.query.toLowerCase();
    keptNodes = keptNodes.filter((node) => node.label.toLowerCase().includes(lowerQuery));
    keptEdges = restrictEdgesToNodes(keptEdges, keptNodes);
  }

  if (!filter.showOrphans) {
    const connectedIds = new Set<string>();
    for (const edge of keptEdges) {
      connectedIds.add(edge.source);
      connectedIds.add(edge.target);
    }
    keptNodes = keptNodes.filter((node) => connectedIds.has(node.id));
  }

  return { nodes: keptNodes, edges: keptEdges };
}

function restrictEdgesToNodes(edges: GraphEdge[], nodes: GraphNode[]): GraphEdge[] {
  const nodeIds = new Set(nodes.map((node) => node.id));
  return edges.filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target));
}

export function computeStats(cache: MetadataCache, vaultPath: string): VaultStats {
  let noteCount = 0;
  let attachmentCount = 0;
  for (const meta of cache.files()) {
    if (meta.isMarkdown) {
      noteCount += 1;
    } else {
      attachmentCount += 1;
    }
  }
  const unresolvedLowerTexts = new Set<string>();
  for (const countsByText of cache.unresolvedLinks.values()) {
    for (const text of countsByText.keys()) {
      unresolvedLowerTexts.add(text.toLowerCase());
    }
  }
  return {
    vaultPath,
    fileCount: cache.size,
    noteCount,
    attachmentCount,
    unresolvedCount: unresolvedLowerTexts.size,
  };
}
