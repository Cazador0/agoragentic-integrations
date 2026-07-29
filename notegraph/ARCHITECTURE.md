# notegraph architecture

Local-first Markdown note-taking + graph-visualization desktop app, modeled on
Obsidian's technical architecture. Electron shell, Node.js file-system layer,
in-memory metadata cache, Canvas 2D force-directed graph view.

```
┌────────────────────────── Electron main process ──────────────────────────┐
│  vault_watcher.ts (chokidar)  →  markdown/parser.ts  →  metadata_cache.ts │
│                 └────────────── vault_service.ts ──────────┘              │
│                                    │ graph_builder.ts                     │
│                                    ▼                                      │
│                              IPC (shared/ipc.ts)                          │
└────────────────────────────────────┬───────────────────────────────────────┘
                                     ▼
┌───────────────────────────── renderer process ─────────────────────────────┐
│  app.ts  →  graph/renderer.ts (GraphView, Canvas 2D, rAF loop)             │
│                 ├─ graph/simulation.ts (force sim, Barnes–Hut quadtree)    │
│                 └─ graph/controller.ts (pan / zoom / drag / hover)         │
└─────────────────────────────────────────────────────────────────────────────┘
```

All cross-module data shapes live in `src/shared/types.ts` (the contract) and
`src/shared/ipc.ts`. Implementations must conform to them exactly. Modules are
imported extensionless (`import { x } from '../shared/types'`).

## Module surfaces

### `src/core/markdown/parser.ts` — Markdown structural parser
Single-pass scanner producing the extracted AST surface (no full CommonMark
tree — only the structural elements the index needs, with source spans).

Exports:
- `parseMarkdown(source: string): ParsedNote`
- `slugifyHeading(text: string): string` (lowercase, spaces→`-`, strip punctuation)

Rules:
- YAML frontmatter only at offset 0: `---\n … \n---` (js-yaml; invalid YAML →
  `frontmatter: null` but still skipped from body scanning).
- Skips fenced code blocks (``` / ~~~, respecting fence length), inline code
  spans (matching backtick runs), and `%%…%%` comments when scanning for
  links/tags.
- Wikilinks `[[target#subpath|alias]]`, embeds `![[…]]`. `target` may be empty
  (`[[#h]]` self-link). Subpath keeps its leading `#`; `#^id` is a block ref.
- Markdown links `[alias](target)` count only when target is a relative path
  (not `http(s)://`, `mailto:` etc.); percent-decode the target; `![…](…)` is
  an embed.
- Tags: `#tag` at start-of-line or after whitespace/punctuation `([{,;:!?—`—
  chars `[A-Za-z0-9_/-]`, must contain ≥1 non-numeric char, trailing `/`
  stripped. Not inside links, not headings (`# ` with space = heading).
- ATX headings `#{1,6} text`; block ids: line-final `\s\^([A-Za-z0-9-]+)$`
  (also standalone `^id` line referencing the previous block).

### `src/core/metadata_cache.ts` — MetadataCache + link resolution
In-memory adjacency index over `FileMetadata`. No disk access.

Exports `makeFileMetadata(path, source | null, stats: {mtimeMs, size}): FileMetadata`
(uses parser for `.md`; merges frontmatter `tags`/`aliases` — string, array, or
comma-separated; strips leading `#`) and `class MetadataCache`:
- `setFile(meta: FileMetadata): void`, `deleteFile(path: string): void`,
  `renameFile(oldPath: string, newPath: string): void`
- `getFile(path): FileMetadata | undefined`, `files(): FileMetadata[]`,
  `size: number`
- `resolvedLinks: Map<string, Map<string, number>>` — src path → target path → count
- `unresolvedLinks: Map<string, Map<string, number>>` — src path → link text → count
- `getBacklinks(path: string): Map<string, number>` — target → (src → count)
- `getRefs(path: string): ReadonlyArray<{ text: string; embed: boolean; resolvedPath: string | null }>`
  — the per-occurrence resolved link list the graph builder consumes (embed
  distinction preserved; `text` is the raw link target as typed).
- `resolveLink(linkText: string, sourcePath: string): string | null`
- `onChange(cb: () => void): () => void` — fires after any mutation that
  changed the index (debouncing is the caller's job).

Link resolution (Obsidian-flavored), given link text with subpath/alias
already stripped:
1. Empty text → resolves to `sourcePath` (self).
2. Contains `/` → vault-absolute path; try exact, then `+ .md`, then
   case-insensitive both; also resolve relative to the source file's folder.
3. Otherwise basename lookup: exact basename (as typed, with or without
   extension), then case-insensitive; on ties prefer the shortest path, then
   lexicographic. Aliases from frontmatter participate in basename lookup.
4. Every set/delete/rename re-resolves affected links — including previously
   unresolved links that a newly added file may now satisfy (index unresolved
   by lowercase text for this).

### `src/core/graph_builder.ts` — GraphData assembly
Exports `buildGraph(cache: MetadataCache, filter?: GraphFilter): GraphData` and
`computeStats(cache, vaultPath): VaultStats`. When `filter` is omitted the
graph includes **everything** (attachments, unresolved, tag hubs, orphans) —
the renderer applies user filtering client-side via `IGraphView.setFilter`.
- Nodes for every file (`note`/`attachment` per `isMarkdown`), one
  `unresolved` node per distinct lowercase unresolved link text, and (when
  `filter.showTags`) one `tag` node per distinct lowercase tag.
- Edges merge per (source, target, kind) with `count`; self-loops dropped.
  `embed` kind when every underlying occurrence is an embed, else `link`.
  Tag edges: file → tag node, kind `tag`, count 1.
- in/out-degree computed on the **unfiltered** graph, then filters applied
  (attachments / unresolved / tags / query substring on label / orphans last).
- Deterministic output ordering: nodes by id, edges by (source, target, kind).

### `src/main/vault_watcher.ts` — chokidar wrapper
`class VaultWatcher` with `start(vaultPath)` (resolves on initial-scan ready),
`close()`, and callbacks `{ onAdd, onChange, onRemove, onReady }` where the
file callbacks receive `(relPath, absPath)`. Ignores dotfiles/dirs
(including `.obsidian`, `.git`, `.trash`), emits only `.md` +
`ATTACHMENT_EXTENSIONS` files, normalizes to POSIX vault-relative paths,
uses `awaitWriteFinish` to avoid half-written reads.

### `src/main/vault_service.ts` — orchestration
`class VaultService` (EventEmitter-style, no Electron imports — testable
headless): `open(vaultPath)` scans via watcher, parses, fills cache;
`getGraph(filter?)`, `getStats()`, `close()`; `on(cb: (e: VaultEvent) => void)`.
Emits `ready` once the initial scan settles, then debounced (150 ms) `graph`
events on changes. Reads `.obsidian/app.json` when present (best-effort
`userIgnoreFilters` support).

### `src/main/main.ts` + `src/main/preload.ts` — Electron shell
BrowserWindow (dark background, `contextIsolation: true`, no nodeIntegration),
loads `dist/renderer/index.html`, wires `IPC_CHANNELS` ↔ `VaultService`,
`--vault <path>` CLI flag or `NOTEGRAPH_VAULT` env opens a vault at launch.
Preload exposes the `NotegraphBridge` via `contextBridge` exactly as declared
in `shared/ipc.ts`.

### `src/renderer/graph/quadtree.ts` + `simulation.ts` — physics
Barnes–Hut quadtree (`class QuadTree` with `insert`, `computeMass`,
`accumulateForce(node, theta, repulsion, out)`) and
`class ForceSimulation implements IForceSimulation`. Semi-implicit Euler:
repulsion (BH approximation), springs along links, center gravity, velocity
decay, alpha cooling per `SimulationOptions`. Deterministic initial placement
(hash of node id → phyllotaxis spiral) so layouts are reproducible in tests.

### `src/renderer/graph/renderer.ts` + `controller.ts` — canvas + input
`class GraphView implements IGraphView`: owns the canvas, camera, sim, and
rAF loop; renders edges then nodes then labels; devicePixelRatio-aware;
renders only when dirty (sim unsettled, camera/hover/data changed). Node
radius ∝ sqrt(degree); kind-based colors; hover highlights the node + its
neighbors and dims the rest; labels appear above a zoom threshold or on
hover. `controller.ts` (`attachController(view internals…)`) implements
pointer pan, wheel zoom-to-cursor, node drag (fixes node + reheats sim),
click and hover picking in world space.

### `src/renderer/app.ts` + `index.html` + `styles.css` — app shell
Wires `window.notegraph` bridge → `GraphView`. Toolbar: open-vault button,
search input (`filter.query`), toggles for attachments/unresolved/tags/
orphans, node/edge counts, zoom-to-fit. Listens to `vaultEvent` pushes and
re-fetches the filtered graph. **Browser demo fallback:** when
`window.notegraph` is undefined (plain Chromium, no preload), fetch
`./graph-data.json` and render it read-only — this powers `npm run demo` and
headless screenshot verification.

### `src/tools/gen_demo_data.ts` — demo pipeline
Node CLI: scans a vault directory directly (fs.readdir recursion — no watcher),
runs parser + cache + builder, writes `demo/graph-data.json`
(`{ graph, stats }`). Args: `[vaultPath] [outPath]`, defaults
`demo-vault` → `demo/graph-data.json`.

## Testing
Vitest, headless, no Electron: `tests/parser.test.ts`,
`tests/metadata_cache.test.ts`, `tests/graph_builder.test.ts`,
`tests/simulation.test.ts` (energy decreases, settles below alphaMin, spring
length convergence, determinism), `tests/vault_service.test.ts` (tmp-dir
vault: initial scan, add/edit/delete file → graph events; real chokidar).
`npm run demo` serves the renderer bundle + demo data for visual checks.
