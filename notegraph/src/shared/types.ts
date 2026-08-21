/**
 * Shared type contracts for notegraph.
 *
 * This file is the single source of truth for data structures exchanged
 * between the core indexing engine (main process), the graph pipeline, and
 * the renderer. Module implementations must conform to these shapes exactly.
 */

// ---------------------------------------------------------------------------
// Source positions
// ---------------------------------------------------------------------------

export interface Pos {
  /** 0-based line index. */
  line: number;
  /** 0-based column (UTF-16 code units) within the line. */
  col: number;
  /** 0-based absolute offset into the file (UTF-16 code units). */
  offset: number;
}

export interface Span {
  start: Pos;
  /** Exclusive end position. */
  end: Pos;
}

// ---------------------------------------------------------------------------
// Parsed Markdown structure (the extracted AST surface)
// ---------------------------------------------------------------------------

/** An internal link: [[target#subpath|alias]] or embed ![[target]] or a
 * relative markdown link [alias](target.md). */
export interface LinkRef {
  /** Full raw source text of the link, e.g. "![[img.png]]". */
  raw: string;
  /** The link path portion, before any '#' subpath or '|' alias. May be ""
   * for self-references like [[#heading]]. Never URL-decoded for wikilinks;
   * percent-decoded for markdown-style links. */
  target: string;
  /** Subpath including leading '#', e.g. "#Heading" or "#^block-id". */
  subpath?: string;
  /** Display alias, if any. */
  alias?: string;
  /** True for transclusion embeds (![[...]] or ![alias](file.png)). */
  embed: boolean;
  span: Span;
}

/** A body tag occurrence, e.g. #project/active → tag: "project/active" (no '#'). */
export interface TagRef {
  tag: string;
  span: Span;
}

export interface HeadingRef {
  /** 1-6 */
  level: number;
  /** Heading text with inline markup left as-is, trimmed. */
  text: string;
  span: Span;
}

/** A block identifier definition, e.g. a line ending in " ^quote-1". */
export interface BlockIdRef {
  /** The id without the leading '^'. */
  id: string;
  span: Span;
}

/** Result of parsing one Markdown file. */
export interface ParsedNote {
  /** Parsed YAML frontmatter object, or null when absent/invalid. */
  frontmatter: Record<string, unknown> | null;
  /** Span covering the frontmatter block including delimiters, if present. */
  frontmatterSpan: Span | null;
  links: LinkRef[];
  /** Body tags only (frontmatter tags are merged at the FileMetadata level). */
  tags: TagRef[];
  headings: HeadingRef[];
  blocks: BlockIdRef[];
  /** Prose regions of the body: everything outside frontmatter, fenced code,
   * inline code, %% comments, and link syntax. Unlinked-mention scanning must
   * search only these, so a note's own links never count as mentions. Spans
   * are ordered by start offset and never overlap. */
  textSpans: Span[];
}

// ---------------------------------------------------------------------------
// Vault files and metadata cache
// ---------------------------------------------------------------------------

/** Extensions treated as attachments (linkable non-markdown vault members). */
export const ATTACHMENT_EXTENSIONS: ReadonlySet<string> = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'avif',
  'pdf',
  'mp3', 'wav', 'm4a', 'ogg', 'flac',
  'mp4', 'webm', 'mov', 'mkv',
  'canvas',
]);

export interface FileMetadata {
  /** Vault-relative path using '/' separators, e.g. "projects/Roadmap.md". */
  path: string;
  /** File name without directory or extension, e.g. "Roadmap". */
  basename: string;
  /** Lowercase extension without dot, e.g. "md", "png". */
  extension: string;
  mtimeMs: number;
  size: number;
  /** True when extension === "md". */
  isMarkdown: boolean;
  /** Parse result for markdown files; null for attachments. */
  parsed: ParsedNote | null;
  /** Merged, deduplicated tags from body + frontmatter, without '#',
   * original case preserved, order of first appearance. */
  tags: string[];
  /** Aliases declared in frontmatter (string or string[] accepted). */
  aliases: string[];
}

// ---------------------------------------------------------------------------
// Graph topology  G = (V, E)
// ---------------------------------------------------------------------------

export type NodeKind = 'note' | 'attachment' | 'unresolved' | 'tag';

/** Stable node id conventions:
 *  - note/attachment: the vault-relative path ("projects/Roadmap.md")
 *  - unresolved:      "unresolved:" + normalized link text lowercase
 *  - tag:             "tag:" + tag lowercase
 */
export interface GraphNode {
  id: string;
  kind: NodeKind;
  /** Display label: basename for files, link text for unresolved, "#tag". */
  label: string;
  /** Present for note/attachment nodes. */
  path?: string;
  mtimeMs?: number;
  tags?: string[];
  inDegree: number;
  outDegree: number;
}

/** 'mention' is an unlinked mention: the target note's name or alias appears
 * as plain prose in the source note without a link. */
export type EdgeKind = 'link' | 'embed' | 'tag' | 'mention';

export interface GraphEdge {
  /** GraphNode.id of the source. */
  source: string;
  /** GraphNode.id of the target. */
  target: string;
  kind: EdgeKind;
  /** Number of occurrences merged into this edge (>= 1). */
  count: number;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface GraphFilter {
  showAttachments: boolean;
  showUnresolved: boolean;
  /** When true, tag hub nodes are added and files link to their tags. */
  showTags: boolean;
  /** When true, unlinked mentions are added as 'mention' edges between notes. */
  showMentions: boolean;
  /** When false, nodes with no visible edges are hidden. */
  showOrphans: boolean;
  /** Case-insensitive substring match against node labels; '' = no filter. */
  query: string;
}

export const DEFAULT_GRAPH_FILTER: GraphFilter = {
  showAttachments: true,
  showUnresolved: true,
  showTags: false,
  showMentions: false,
  showOrphans: true,
  query: '',
};

// ---------------------------------------------------------------------------
// Force simulation contracts (renderer)
// ---------------------------------------------------------------------------

export interface SimNode {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Mass scales repulsion and inertia; derived from degree. */
  mass: number;
  /** World-space radius used for rendering and hit-testing. */
  radius: number;
  /** While true (e.g. during drag), integration skips this node. */
  fixed: boolean;
}

export interface SimLink {
  /** Index into the simulation's node array. */
  source: number;
  /** Index into the simulation's node array. */
  target: number;
  strength: number;
  restLength: number;
}

export interface SimulationOptions {
  /** Coulomb-style repulsion constant (positive). */
  repulsion: number;
  /** Spring constant for links. */
  springStrength: number;
  /** Default rest length for links. */
  springLength: number;
  /** Pull toward world origin. */
  centerGravity: number;
  /** Velocity retained per tick, in (0, 1]. */
  velocityDecay: number;
  /** Barnes–Hut opening angle; 0 disables approximation. */
  theta: number;
  /** Cooling: alpha += (alphaTarget - alpha) * alphaDecay each tick. */
  alphaDecay: number;
  /** Simulation is considered settled below this alpha. */
  alphaMin: number;
}

export const DEFAULT_SIMULATION_OPTIONS: SimulationOptions = {
  repulsion: 1200,
  springStrength: 0.06,
  springLength: 90,
  centerGravity: 0.02,
  velocityDecay: 0.6,
  theta: 0.9,
  alphaDecay: 0.028,
  alphaMin: 0.001,
};

/** Implemented by renderer/graph/simulation.ts. */
export interface IForceSimulation {
  readonly nodes: SimNode[];
  readonly links: SimLink[];
  alpha: number;
  options: SimulationOptions;
  /** Replace the topology. The caller provides node positions (seeding new
   * nodes, preserving surviving ones); implementations must not reposition. */
  setGraph(nodes: SimNode[], links: SimLink[]): void;
  /** Advance one step. Returns the new alpha. No-op below alphaMin. */
  tick(): number;
  /** Re-energize (e.g. after a topology change or drag), clamped to [0,1]. */
  reheat(alpha?: number): void;
  /** True when alpha < alphaMin. */
  isSettled(): boolean;
}

// ---------------------------------------------------------------------------
// Graph view contracts (renderer)
// ---------------------------------------------------------------------------

export interface Camera {
  /** World coordinate at the canvas center. */
  x: number;
  y: number;
  /** Pixels per world unit. */
  scale: number;
}

export interface GraphViewEvents {
  onNodeClick?(node: GraphNode): void;
  onNodeHover?(node: GraphNode | null): void;
}

/** Implemented by renderer/graph/renderer.ts (class GraphView). The app layer
 * (renderer/app.ts) must interact with the view only through this surface. */
export interface IGraphView {
  /** Replace graph data; positions of ids that persist are preserved. */
  setData(data: GraphData): void;
  /** Recompute visible subgraph. */
  setFilter(filter: GraphFilter): void;
  /** Start the requestAnimationFrame render loop (idempotent). */
  start(): void;
  stop(): void;
  /** Fit all visible nodes into view with padding. */
  zoomToFit(): void;
  readonly camera: Camera;
  events: GraphViewEvents;
}

// ---------------------------------------------------------------------------
// Vault service events (main process)
// ---------------------------------------------------------------------------

export type VaultEvent =
  | { type: 'ready'; fileCount: number }
  | { type: 'file-changed'; path: string }
  | { type: 'file-removed'; path: string }
  | { type: 'graph'; graph: GraphData };

export interface VaultStats {
  vaultPath: string;
  fileCount: number;
  noteCount: number;
  attachmentCount: number;
  unresolvedCount: number;
}
