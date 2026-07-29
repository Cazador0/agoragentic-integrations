# notegraph

A local-first, high-performance note-taking and graph-visualization desktop
app inspired by Obsidian's technical architecture. Your notes are plain
Markdown files in a local folder (the **Vault**) — notegraph watches them,
indexes their structure in memory, and renders the link topology as an
interactive force-directed graph at 60 FPS on HTML5 Canvas.

## Features

- **Local-first vault**: plain `.md` files + attachments + `.obsidian/`
  config directory on your disk. No server, no database, no lock-in.
- **Live file watcher** (chokidar): create, edit, rename, or delete notes in
  any editor and the graph updates in real time.
- **Structural Markdown parser**: extracts `[[WikiLinks]]`, `![[embeds]]`,
  `#tags` (incl. nested `#a/b`), YAML frontmatter (tags/aliases), ATX
  headings, and `^block-id` identifiers — with source spans, skipping code
  fences, inline code, and `%%comments%%`.
- **MetadataCache**: in-memory adjacency index mapping every file to its
  outgoing links, incoming backlinks, and unresolved references — no disk
  scans on query. Obsidian-style link resolution (basename shortest-path
  matching, aliases, vault-absolute and relative paths).
- **Graph topology G = (V, E)**: notes, attachments, unresolved mentions, and
  optional tag hubs as vertices; links, transclusions, and tag associations
  as edges, with in/out-degree metrics.
- **Force-directed physics**: Barnes–Hut O(n log n) repulsion, spring
  attraction along edges, center gravity, alpha cooling — deterministic
  initial layout.
- **Canvas renderer**: DPR-aware, damage-driven rAF loop; pan, zoom-to-cursor,
  node drag, hover neighbor highlighting, zoom-level label LOD, and live
  subgraph filtering (attachments / unresolved / tags / orphans / search).

## Quick start

```bash
npm install
npm start                        # opens the app; pick a vault folder
npm start -- --vault demo-vault  # or open the bundled demo vault
```

Browser-only demo (no Electron — renders the demo vault's graph in any
browser, useful for headless environments):

```bash
npm run demo    # builds, indexes demo-vault/, serves http://localhost:5173
```

## Development

```bash
npm run build      # bundle main + preload + renderer + tools into dist/
npm run typecheck  # tsc --noEmit
npm test           # vitest (parser, cache, graph builder, physics, watcher)
```

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the module map and contracts.

## Repository layout

```
src/shared/     type + IPC contracts (single source of truth)
src/core/       platform-agnostic engine: parser, MetadataCache, graph builder
src/main/       Electron main process: window, vault watcher, IPC wiring
src/renderer/   graph view: quadtree, force simulation, canvas, interaction
src/tools/      demo-data generator (vault → graph-data.json)
tests/          headless vitest suites
demo-vault/     sample vault exercising every parser feature
```
