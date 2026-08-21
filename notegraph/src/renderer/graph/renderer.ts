/**
 * Canvas 2D graph view. Owns the camera, the force simulation, the visible
 * subgraph derived from GraphData + GraphFilter, and the rAF render loop.
 * Input handling lives in controller.ts and is attached by the constructor.
 */

import type {
  Camera,
  EdgeKind,
  GraphData,
  GraphEdge,
  GraphFilter,
  GraphNode,
  GraphViewEvents,
  IGraphView,
  NodeKind,
  SimLink,
  SimNode,
  SimulationOptions,
} from '../../shared/types';
import { DEFAULT_GRAPH_FILTER } from '../../shared/types';
import { ForceSimulation, seedPosition } from './simulation';
import { MAX_SCALE, MIN_SCALE, attachController } from './controller';

const BACKGROUND_COLOR = '#101014';
const LABEL_COLOR = '#c9c9d4';
const EDGE_COLOR = '#7d7d94';
const TAG_EDGE_COLOR = '#e0af68';
const UNRESOLVED_OUTLINE_COLOR = '#9a9aa8';
const HOVER_RING_COLOR = '#e8e8f2';
const NODE_FILL_COLORS: Record<NodeKind, string> = {
  note: '#a48fff',
  attachment: '#4fd6be',
  unresolved: '#6b6b76',
  tag: '#e0af68',
};
const NODE_DRAW_ORDER: NodeKind[] = ['tag', 'unresolved', 'attachment', 'note'];
const EDGE_ALPHA = 0.35;
const TAG_EDGE_ALPHA = 0.14;
const EDGE_HOVER_ALPHA = 0.85;
const TAG_EDGE_HOVER_ALPHA = 0.5;
const UNRESOLVED_FILL_ALPHA = 0.6;
const DIM_ALPHA = 0.15;
const LABEL_FADE_START = 0.8;
const LABEL_FADE_END = 1.4;
const ZOOM_FIT_PADDING = 0.15;
const PICK_SLACK_PX = 2;
const SET_DATA_REHEAT_ALPHA = 0.5;
const SET_FILTER_REHEAT_ALPHA = 0.3;
const EMBED_DASH: number[] = [6, 4];
const UNRESOLVED_DASH: number[] = [3, 3];
const EMPTY_DASH: number[] = [];
const TWO_PI = Math.PI * 2;

type NodePaintPass = 'all' | 'dim' | 'highlight';

interface EdgeBatch {
  kind: EdgeKind;
  lineWidth: number;
  edgeIndexes: number[];
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

function hashId(id: string): number {
  // FNV-1a, 32-bit.
  let hash = 0x811c9dc5;
  for (let position = 0; position < id.length; position++) {
    hash ^= id.charCodeAt(position);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Deterministic sub-spring-length offset so a node added next to an existing
 * neighbor appears beside it instead of on top of it. */
function spawnOffset(id: string): { x: number; y: number } {
  const hash = hashId(id);
  const angle = ((hash & 0x3ff) / 0x400) * TWO_PI;
  const distance = 12 + ((hash >>> 10) & 0xf);
  return { x: Math.cos(angle) * distance, y: Math.sin(angle) * distance };
}

function sanitizeDegree(node: GraphNode): number {
  const inDegree = Number.isFinite(node.inDegree) ? Math.max(0, node.inDegree) : 0;
  const outDegree = Number.isFinite(node.outDegree) ? Math.max(0, node.outDegree) : 0;
  return inDegree + outDegree;
}

function sanitizeNodeKind(kind: NodeKind): NodeKind {
  return kind === 'attachment' || kind === 'unresolved' || kind === 'tag' ? kind : 'note';
}

function sanitizeEdgeKind(kind: EdgeKind): EdgeKind {
  return kind === 'embed' || kind === 'tag' ? kind : 'link';
}

export class GraphView implements IGraphView {
  readonly camera: Camera = { x: 0, y: 0, scale: 1 };
  events: GraphViewEvents = {};

  private readonly canvas: HTMLCanvasElement;
  private readonly context: CanvasRenderingContext2D;
  private readonly simulation: ForceSimulation;
  private readonly detachController: () => void;

  private data: GraphData = { nodes: [], edges: [] };
  private filter: GraphFilter = { ...DEFAULT_GRAPH_FILTER };

  private visibleNodes: GraphNode[] = [];
  private visibleEdges: GraphEdge[] = [];
  private nodeIndexById = new Map<string, number>();
  private edgeSourceIndexes: number[] = [];
  private edgeTargetIndexes: number[] = [];
  private edgeLineWidths: number[] = [];
  private edgeBatches: EdgeBatch[] = [];
  private nodeIndexesByKind: Record<NodeKind, number[]> = {
    note: [],
    attachment: [],
    unresolved: [],
    tag: [],
  };
  private neighborSets: Array<Set<number>> = [];
  private incidentEdgeIndexes: number[][] = [];

  private hoveredNodeId: string | null = null;
  private draggedNodeId: string | null = null;
  private readonly hoverNeighborSet = new Set<number>();
  private readonly hoverIncidentEdgeSet = new Set<number>();

  private dirty = true;
  private resizePending = false;
  private animationFrameHandle: number | null = null;
  private cssWidth = 0;
  private cssHeight = 0;
  private pixelRatio = 1;
  private cachedFontScale = -1;
  private cachedFont = '';

  constructor(canvas: HTMLCanvasElement, options?: Partial<SimulationOptions>) {
    this.canvas = canvas;
    const context = canvas.getContext('2d');
    if (context === null) {
      throw new Error(
        'GraphView: canvas.getContext("2d") returned null — a 2D rendering context is required',
      );
    }
    this.context = context;
    this.simulation = new ForceSimulation(options);
    this.applyResize();
    if (typeof ResizeObserver === 'function') {
      const observer = new ResizeObserver(() => {
        this.resizePending = true;
        this.dirty = true;
      });
      observer.observe(canvas);
    }
    window.addEventListener('resize', () => {
      this.resizePending = true;
      this.dirty = true;
    });
    this.detachController = attachController({
      canvas,
      camera: this.camera,
      pick: (screenX, screenY) => this.pick(screenX, screenY),
      findSimNode: (nodeId) => {
        const index = this.nodeIndexById.get(nodeId);
        return index === undefined ? undefined : this.simulation.nodes[index];
      },
      screenToWorld: (screenX, screenY) => this.screenToWorld(screenX, screenY),
      reheat: (alpha) => {
        this.simulation.reheat(alpha);
      },
      markDirty: () => {
        this.dirty = true;
      },
      setHoveredNode: (node) => {
        this.setHoveredNode(node);
      },
      setDraggedNode: (nodeId) => {
        this.draggedNodeId = nodeId;
        this.dirty = true;
      },
      notifyNodeClick: (node) => {
        const handler = this.events.onNodeClick;
        if (handler !== undefined) handler(node);
      },
      zoomToFit: () => {
        this.zoomToFit();
      },
    });
  }

  setData(data: GraphData): void {
    this.data = data ?? { nodes: [], edges: [] };
    this.rebuild(SET_DATA_REHEAT_ALPHA);
  }

  setFilter(filter: GraphFilter): void {
    this.filter = { ...DEFAULT_GRAPH_FILTER, ...filter };
    this.rebuild(SET_FILTER_REHEAT_ALPHA);
  }

  start(): void {
    if (this.animationFrameHandle !== null) return;
    this.animationFrameHandle = requestAnimationFrame(this.frame);
  }

  stop(): void {
    if (this.animationFrameHandle === null) return;
    cancelAnimationFrame(this.animationFrameHandle);
    this.animationFrameHandle = null;
  }

  zoomToFit(): void {
    const camera = this.camera;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const node of this.simulation.nodes) {
      if (!Number.isFinite(node.x) || !Number.isFinite(node.y)) continue;
      const radius = Number.isFinite(node.radius) ? node.radius : 0;
      if (node.x - radius < minX) minX = node.x - radius;
      if (node.x + radius > maxX) maxX = node.x + radius;
      if (node.y - radius < minY) minY = node.y - radius;
      if (node.y + radius > maxY) maxY = node.y + radius;
    }
    if (minX === Infinity) {
      camera.x = 0;
      camera.y = 0;
      camera.scale = 1;
      this.dirty = true;
      return;
    }
    const worldWidth = Math.max(maxX - minX, 1e-6);
    const worldHeight = Math.max(maxY - minY, 1e-6);
    const viewWidth = this.cssWidth > 0 ? this.cssWidth : 1;
    const viewHeight = this.cssHeight > 0 ? this.cssHeight : 1;
    let scale = Math.min(viewWidth / worldWidth, viewHeight / worldHeight) * (1 - ZOOM_FIT_PADDING);
    if (!Number.isFinite(scale) || scale <= 0) scale = 1;
    camera.scale = clamp(scale, MIN_SCALE, MAX_SCALE);
    camera.x = (minX + maxX) / 2;
    camera.y = (minY + maxY) / 2;
    this.dirty = true;
  }

  pick(screenX: number, screenY: number): GraphNode | null {
    const world = this.screenToWorld(screenX, screenY);
    const scale = this.camera.scale > 0 ? this.camera.scale : 1;
    const slack = PICK_SLACK_PX / scale;
    const simNodes = this.simulation.nodes;
    // Walk in exact reverse paint order (kinds are painted per NODE_DRAW_ORDER,
    // ascending index within a kind) so the visually topmost node wins.
    for (let order = NODE_DRAW_ORDER.length - 1; order >= 0; order--) {
      const kind = NODE_DRAW_ORDER[order];
      if (kind === undefined) continue;
      const indexes = this.nodeIndexesByKind[kind];
      for (let position = indexes.length - 1; position >= 0; position--) {
        const index = indexes[position];
        if (index === undefined) continue;
        const simNode = simNodes[index];
        if (simNode === undefined) continue;
        if (!Number.isFinite(simNode.x) || !Number.isFinite(simNode.y)) continue;
        const deltaX = world.x - simNode.x;
        const deltaY = world.y - simNode.y;
        const threshold = simNode.radius + slack;
        if (deltaX * deltaX + deltaY * deltaY <= threshold * threshold) {
          return this.visibleNodes[index] ?? null;
        }
      }
    }
    return null;
  }

  private screenToWorld(screenX: number, screenY: number): { x: number; y: number } {
    const scale = this.camera.scale > 0 ? this.camera.scale : 1;
    return {
      x: (screenX - this.cssWidth / 2) / scale + this.camera.x,
      y: (screenY - this.cssHeight / 2) / scale + this.camera.y,
    };
  }

  private setHoveredNode(node: GraphNode | null): void {
    const nextId = node === null ? null : node.id;
    if (nextId === this.hoveredNodeId) return;
    this.hoveredNodeId = nextId;
    this.rebuildHoverCaches();
    this.dirty = true;
    const handler = this.events.onNodeHover;
    if (handler !== undefined) handler(node);
  }

  private rebuildHoverCaches(): void {
    this.hoverNeighborSet.clear();
    this.hoverIncidentEdgeSet.clear();
    if (this.hoveredNodeId === null) return;
    const index = this.nodeIndexById.get(this.hoveredNodeId);
    if (index === undefined) return;
    const neighbors = this.neighborSets[index];
    if (neighbors !== undefined) {
      for (const neighborIndex of neighbors) this.hoverNeighborSet.add(neighborIndex);
    }
    const incident = this.incidentEdgeIndexes[index];
    if (incident !== undefined) {
      for (const edgeIndex of incident) this.hoverIncidentEdgeSet.add(edgeIndex);
    }
  }

  private rebuild(reheatAlpha: number): void {
    const previousById = new Map<string, SimNode>();
    for (const simNode of this.simulation.nodes) previousById.set(simNode.id, simNode);

    const sourceNodes = Array.isArray(this.data.nodes) ? this.data.nodes : [];
    const sourceEdges = Array.isArray(this.data.edges) ? this.data.edges : [];
    const filter = this.filter;
    const rawQuery = typeof filter.query === 'string' ? filter.query : '';
    const query = rawQuery === '' ? null : rawQuery.toLowerCase();

    const seenIds = new Set<string>();
    let keptNodes: GraphNode[] = [];
    for (const node of sourceNodes) {
      if (node === null || node === undefined || typeof node.id !== 'string') continue;
      if (seenIds.has(node.id)) continue;
      seenIds.add(node.id);
      if (node.kind === 'attachment' && !filter.showAttachments) continue;
      if (node.kind === 'unresolved' && !filter.showUnresolved) continue;
      if (node.kind === 'tag' && !filter.showTags) continue;
      if (query !== null) {
        const label = typeof node.label === 'string' ? node.label : node.id;
        if (!label.toLowerCase().includes(query)) continue;
      }
      keptNodes.push(node);
    }

    const keptIds = new Set<string>();
    for (const node of keptNodes) keptIds.add(node.id);

    const keptEdges: GraphEdge[] = [];
    for (const edge of sourceEdges) {
      if (edge === null || edge === undefined) continue;
      if (typeof edge.source !== 'string' || typeof edge.target !== 'string') continue;
      if (edge.source === edge.target) continue;
      if (!keptIds.has(edge.source) || !keptIds.has(edge.target)) continue;
      keptEdges.push(edge);
    }

    if (!filter.showOrphans) {
      const connectedIds = new Set<string>();
      for (const edge of keptEdges) {
        connectedIds.add(edge.source);
        connectedIds.add(edge.target);
      }
      keptNodes = keptNodes.filter((node) => connectedIds.has(node.id));
    }

    const indexById = new Map<string, number>();
    for (let index = 0; index < keptNodes.length; index++) {
      const node = keptNodes[index];
      if (node !== undefined) indexById.set(node.id, index);
    }

    const finalEdges: GraphEdge[] = [];
    const edgeSourceIndexes: number[] = [];
    const edgeTargetIndexes: number[] = [];
    const edgeLineWidths: number[] = [];
    for (const edge of keptEdges) {
      const sourceIndex = indexById.get(edge.source);
      const targetIndex = indexById.get(edge.target);
      if (sourceIndex === undefined || targetIndex === undefined) continue;
      finalEdges.push(edge);
      edgeSourceIndexes.push(sourceIndex);
      edgeTargetIndexes.push(targetIndex);
      const count = Number.isFinite(edge.count) && edge.count >= 1 ? edge.count : 1;
      edgeLineWidths.push(clamp(Math.sqrt(count), 0.75, 5));
    }

    const neighborSets: Array<Set<number>> = keptNodes.map(() => new Set<number>());
    const incidentEdgeIndexes: number[][] = keptNodes.map(() => []);
    for (let edgeIndex = 0; edgeIndex < finalEdges.length; edgeIndex++) {
      const sourceIndex = edgeSourceIndexes[edgeIndex];
      const targetIndex = edgeTargetIndexes[edgeIndex];
      if (sourceIndex === undefined || targetIndex === undefined) continue;
      neighborSets[sourceIndex]?.add(targetIndex);
      neighborSets[targetIndex]?.add(sourceIndex);
      incidentEdgeIndexes[sourceIndex]?.push(edgeIndex);
      incidentEdgeIndexes[targetIndex]?.push(edgeIndex);
    }

    const simNodes: SimNode[] = new Array<SimNode>(keptNodes.length);
    const pendingNewIndexes: number[] = [];
    for (let index = 0; index < keptNodes.length; index++) {
      const node = keptNodes[index];
      if (node === undefined) continue;
      const degree = sanitizeDegree(node);
      const mass = 1 + 0.35 * degree;
      const radius = clamp(4 + 2 * Math.sqrt(degree), 4, 22);
      const previous = previousById.get(node.id);
      if (previous !== undefined) {
        // Reuse the surviving object so a drag in progress keeps mutating the
        // node the controller captured.
        previous.mass = mass;
        previous.radius = radius;
        simNodes[index] = previous;
      } else {
        simNodes[index] = {
          id: node.id,
          x: Number.NaN,
          y: Number.NaN,
          vx: 0,
          vy: 0,
          mass,
          radius,
          fixed: false,
        };
        pendingNewIndexes.push(index);
      }
    }

    for (const nodeIndex of pendingNewIndexes) {
      const simNode = simNodes[nodeIndex];
      const graphNode = keptNodes[nodeIndex];
      if (simNode === undefined || graphNode === undefined) continue;
      let placedNearNeighbor = false;
      const neighbors = neighborSets[nodeIndex];
      if (neighbors !== undefined) {
        for (const neighborIndex of neighbors) {
          const neighbor = simNodes[neighborIndex];
          if (
            neighbor !== undefined &&
            Number.isFinite(neighbor.x) &&
            Number.isFinite(neighbor.y)
          ) {
            const offset = spawnOffset(graphNode.id);
            simNode.x = neighbor.x + offset.x;
            simNode.y = neighbor.y + offset.y;
            placedNearNeighbor = true;
            break;
          }
        }
      }
      if (!placedNearNeighbor) {
        const seed = seedPosition(graphNode.id, nodeIndex);
        simNode.x = seed.x;
        simNode.y = seed.y;
      }
    }

    const restLength = this.simulation.options.springLength;
    const simLinks: SimLink[] = [];
    for (let edgeIndex = 0; edgeIndex < finalEdges.length; edgeIndex++) {
      const sourceIndex = edgeSourceIndexes[edgeIndex];
      const targetIndex = edgeTargetIndexes[edgeIndex];
      if (sourceIndex === undefined || targetIndex === undefined) continue;
      simLinks.push({ source: sourceIndex, target: targetIndex, strength: 1, restLength });
    }

    const batchesByKey = new Map<string, EdgeBatch>();
    for (let edgeIndex = 0; edgeIndex < finalEdges.length; edgeIndex++) {
      const edge = finalEdges[edgeIndex];
      if (edge === undefined) continue;
      const kind = sanitizeEdgeKind(edge.kind);
      const lineWidth = edgeLineWidths[edgeIndex] ?? 1;
      const key = `${kind}:${lineWidth}`;
      let batch = batchesByKey.get(key);
      if (batch === undefined) {
        batch = { kind, lineWidth, edgeIndexes: [] };
        batchesByKey.set(key, batch);
      }
      batch.edgeIndexes.push(edgeIndex);
    }
    const kindOrder: Record<EdgeKind, number> = { tag: 0, link: 1, embed: 2 };
    const edgeBatches = [...batchesByKey.values()].sort(
      (first, second) => kindOrder[first.kind] - kindOrder[second.kind] || first.lineWidth - second.lineWidth,
    );

    const nodeIndexesByKind: Record<NodeKind, number[]> = {
      note: [],
      attachment: [],
      unresolved: [],
      tag: [],
    };
    for (let index = 0; index < keptNodes.length; index++) {
      const node = keptNodes[index];
      if (node === undefined) continue;
      nodeIndexesByKind[sanitizeNodeKind(node.kind)].push(index);
    }

    this.visibleNodes = keptNodes;
    this.visibleEdges = finalEdges;
    this.nodeIndexById = indexById;
    this.edgeSourceIndexes = edgeSourceIndexes;
    this.edgeTargetIndexes = edgeTargetIndexes;
    this.edgeLineWidths = edgeLineWidths;
    this.edgeBatches = edgeBatches;
    this.nodeIndexesByKind = nodeIndexesByKind;
    this.neighborSets = neighborSets;
    this.incidentEdgeIndexes = incidentEdgeIndexes;

    this.simulation.setGraph(simNodes, simLinks);
    this.simulation.reheat(reheatAlpha);

    if (this.hoveredNodeId !== null && !indexById.has(this.hoveredNodeId)) {
      this.hoveredNodeId = null;
      const handler = this.events.onNodeHover;
      if (handler !== undefined) handler(null);
    }
    this.rebuildHoverCaches();
    this.dirty = true;
  }

  private readonly frame = (): void => {
    this.animationFrameHandle = requestAnimationFrame(this.frame);
    if (this.resizePending) {
      this.resizePending = false;
      this.applyResize();
    }
    let ticked = false;
    if (!this.simulation.isSettled()) {
      this.simulation.tick();
      ticked = true;
    }
    if (ticked || this.dirty) {
      this.dirty = false;
      this.draw();
    }
  };

  private applyResize(): void {
    const width = this.canvas.clientWidth;
    const height = this.canvas.clientHeight;
    const ratio = window.devicePixelRatio > 0 ? window.devicePixelRatio : 1;
    this.cssWidth = width;
    this.cssHeight = height;
    this.pixelRatio = ratio;
    const deviceWidth = Math.max(1, Math.round(width * ratio));
    const deviceHeight = Math.max(1, Math.round(height * ratio));
    if (this.canvas.width !== deviceWidth || this.canvas.height !== deviceHeight) {
      this.canvas.width = deviceWidth;
      this.canvas.height = deviceHeight;
      this.dirty = true;
    }
  }

  private draw(): void {
    const ctx = this.context;
    const cssWidth = this.cssWidth;
    const cssHeight = this.cssHeight;
    ctx.setTransform(this.pixelRatio, 0, 0, this.pixelRatio, 0, 0);
    ctx.fillStyle = BACKGROUND_COLOR;
    ctx.fillRect(0, 0, cssWidth, cssHeight);

    if (this.simulation.nodes.length === 0) return;

    const scale = this.camera.scale;
    const offsetX = cssWidth / 2 - this.camera.x * scale;
    const offsetY = cssHeight / 2 - this.camera.y * scale;
    const hoverIndex =
      this.hoveredNodeId === null ? -1 : (this.nodeIndexById.get(this.hoveredNodeId) ?? -1);
    const hoverActive = hoverIndex >= 0;

    this.drawEdges(hoverActive, scale, offsetX, offsetY);
    ctx.setLineDash(EMPTY_DASH);
    this.drawNodes(hoverActive, hoverIndex, scale, offsetX, offsetY);
    if (hoverActive) this.drawHoverRing(hoverIndex, scale, offsetX, offsetY);
    this.drawLabels(hoverActive, hoverIndex, scale, offsetX, offsetY, cssWidth, cssHeight);

    ctx.globalAlpha = 1;
    ctx.setLineDash(EMPTY_DASH);
  }

  private drawEdges(hoverActive: boolean, scale: number, offsetX: number, offsetY: number): void {
    const ctx = this.context;
    const simNodes = this.simulation.nodes;
    for (let batchIndex = 0; batchIndex < this.edgeBatches.length; batchIndex++) {
      const batch = this.edgeBatches[batchIndex];
      if (batch === undefined) continue;
      const baseAlpha = batch.kind === 'tag' ? TAG_EDGE_ALPHA : EDGE_ALPHA;
      ctx.strokeStyle = batch.kind === 'tag' ? TAG_EDGE_COLOR : EDGE_COLOR;
      ctx.lineWidth = batch.lineWidth;
      ctx.setLineDash(batch.kind === 'embed' ? EMBED_DASH : EMPTY_DASH);
      ctx.globalAlpha = hoverActive ? baseAlpha * DIM_ALPHA : baseAlpha;
      ctx.beginPath();
      let traced = 0;
      const edgeIndexes = batch.edgeIndexes;
      for (let position = 0; position < edgeIndexes.length; position++) {
        const edgeIndex = edgeIndexes[position];
        if (edgeIndex === undefined) continue;
        if (hoverActive && this.hoverIncidentEdgeSet.has(edgeIndex)) continue;
        const sourceIndex = this.edgeSourceIndexes[edgeIndex];
        const targetIndex = this.edgeTargetIndexes[edgeIndex];
        if (sourceIndex === undefined || targetIndex === undefined) continue;
        const source = simNodes[sourceIndex];
        const target = simNodes[targetIndex];
        if (source === undefined || target === undefined) continue;
        ctx.moveTo(source.x * scale + offsetX, source.y * scale + offsetY);
        ctx.lineTo(target.x * scale + offsetX, target.y * scale + offsetY);
        traced++;
      }
      if (traced > 0) ctx.stroke();
    }
    if (hoverActive && this.hoverIncidentEdgeSet.size > 0) {
      for (const edgeIndex of this.hoverIncidentEdgeSet) {
        const edge = this.visibleEdges[edgeIndex];
        const sourceIndex = this.edgeSourceIndexes[edgeIndex];
        const targetIndex = this.edgeTargetIndexes[edgeIndex];
        if (edge === undefined || sourceIndex === undefined || targetIndex === undefined) continue;
        const source = simNodes[sourceIndex];
        const target = simNodes[targetIndex];
        if (source === undefined || target === undefined) continue;
        const kind = sanitizeEdgeKind(edge.kind);
        ctx.strokeStyle = kind === 'tag' ? TAG_EDGE_COLOR : EDGE_COLOR;
        ctx.globalAlpha = kind === 'tag' ? TAG_EDGE_HOVER_ALPHA : EDGE_HOVER_ALPHA;
        ctx.lineWidth = this.edgeLineWidths[edgeIndex] ?? 1;
        ctx.setLineDash(kind === 'embed' ? EMBED_DASH : EMPTY_DASH);
        ctx.beginPath();
        ctx.moveTo(source.x * scale + offsetX, source.y * scale + offsetY);
        ctx.lineTo(target.x * scale + offsetX, target.y * scale + offsetY);
        ctx.stroke();
      }
    }
  }

  private drawNodes(
    hoverActive: boolean,
    hoverIndex: number,
    scale: number,
    offsetX: number,
    offsetY: number,
  ): void {
    for (let order = 0; order < NODE_DRAW_ORDER.length; order++) {
      const kind = NODE_DRAW_ORDER[order];
      if (kind === undefined) continue;
      const indexes = this.nodeIndexesByKind[kind];
      if (indexes.length === 0) continue;
      if (hoverActive) {
        this.paintNodeBatch(kind, indexes, 'dim', hoverIndex, scale, offsetX, offsetY);
        this.paintNodeBatch(kind, indexes, 'highlight', hoverIndex, scale, offsetX, offsetY);
      } else {
        this.paintNodeBatch(kind, indexes, 'all', hoverIndex, scale, offsetX, offsetY);
      }
    }
  }

  private paintNodeBatch(
    kind: NodeKind,
    indexes: number[],
    pass: NodePaintPass,
    hoverIndex: number,
    scale: number,
    offsetX: number,
    offsetY: number,
  ): void {
    const ctx = this.context;
    const simNodes = this.simulation.nodes;
    ctx.beginPath();
    let traced = 0;
    for (let position = 0; position < indexes.length; position++) {
      const index = indexes[position];
      if (index === undefined) continue;
      if (pass !== 'all') {
        const highlighted = index === hoverIndex || this.hoverNeighborSet.has(index);
        if (pass === 'dim' && highlighted) continue;
        if (pass === 'highlight' && !highlighted) continue;
      }
      const node = simNodes[index];
      if (node === undefined) continue;
      if (!Number.isFinite(node.x) || !Number.isFinite(node.y)) continue;
      const screenX = node.x * scale + offsetX;
      const screenY = node.y * scale + offsetY;
      const screenRadius = Math.max(1, node.radius * scale);
      ctx.moveTo(screenX + screenRadius, screenY);
      ctx.arc(screenX, screenY, screenRadius, 0, TWO_PI);
      traced++;
    }
    if (traced === 0) return;
    const baseAlpha = kind === 'unresolved' ? UNRESOLVED_FILL_ALPHA : 1;
    ctx.globalAlpha = pass === 'dim' ? baseAlpha * DIM_ALPHA : baseAlpha;
    ctx.fillStyle = NODE_FILL_COLORS[kind];
    ctx.fill();
    if (kind === 'unresolved') {
      ctx.setLineDash(UNRESOLVED_DASH);
      ctx.strokeStyle = UNRESOLVED_OUTLINE_COLOR;
      ctx.lineWidth = 1;
      ctx.globalAlpha = pass === 'dim' ? DIM_ALPHA : 0.9;
      ctx.stroke();
      ctx.setLineDash(EMPTY_DASH);
    }
  }

  private drawHoverRing(hoverIndex: number, scale: number, offsetX: number, offsetY: number): void {
    const node = this.simulation.nodes[hoverIndex];
    if (node === undefined) return;
    if (!Number.isFinite(node.x) || !Number.isFinite(node.y)) return;
    const ctx = this.context;
    ctx.setLineDash(EMPTY_DASH);
    ctx.globalAlpha = 0.9;
    ctx.strokeStyle = HOVER_RING_COLOR;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(
      node.x * scale + offsetX,
      node.y * scale + offsetY,
      Math.max(1, node.radius * scale) + 3,
      0,
      TWO_PI,
    );
    ctx.stroke();
  }

  private drawLabels(
    hoverActive: boolean,
    hoverIndex: number,
    scale: number,
    offsetX: number,
    offsetY: number,
    cssWidth: number,
    cssHeight: number,
  ): void {
    const fadeAlpha = clamp((scale - LABEL_FADE_START) / (LABEL_FADE_END - LABEL_FADE_START), 0, 1);
    const draggedNodeId = this.draggedNodeId;
    if (fadeAlpha <= 0 && !hoverActive && draggedNodeId === null) return;
    const ctx = this.context;
    if (scale !== this.cachedFontScale) {
      this.cachedFontScale = scale;
      this.cachedFont = `${Math.max(1, 11 * scale)}px system-ui, sans-serif`;
    }
    ctx.font = this.cachedFont;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillStyle = LABEL_COLOR;
    const simNodes = this.simulation.nodes;
    for (let index = 0; index < simNodes.length; index++) {
      const simNode = simNodes[index];
      const graphNode = this.visibleNodes[index];
      if (simNode === undefined || graphNode === undefined) continue;
      if (!Number.isFinite(simNode.x) || !Number.isFinite(simNode.y)) continue;
      const hovered = index === hoverIndex;
      const dragged = draggedNodeId !== null && graphNode.id === draggedNodeId;
      let alpha = fadeAlpha;
      if (hoverActive && !hovered && !this.hoverNeighborSet.has(index)) alpha *= DIM_ALPHA;
      if (hovered || dragged) alpha = 1;
      if (alpha <= 0.02) continue;
      const screenX = simNode.x * scale + offsetX;
      const screenY = simNode.y * scale + offsetY + Math.max(1, simNode.radius * scale) + 3;
      if (screenX < -160 || screenX > cssWidth + 160 || screenY < -40 || screenY > cssHeight + 20) {
        continue;
      }
      ctx.globalAlpha = alpha;
      const label = typeof graphNode.label === 'string' ? graphNode.label : graphNode.id;
      ctx.fillText(label, screenX, screenY);
    }
  }
}
