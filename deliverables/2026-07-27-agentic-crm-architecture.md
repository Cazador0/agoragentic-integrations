# Agentic CRM for a Music Management & Booking Agency — Research and Three Architectures

**Date:** 2026-07-27
**Scope:** Research across 16 repositories, then three competing architectures for a lightweight, robust, interoperable, accessible, headless-agentic TypeScript CRM that brings Zed's **Agent Registry** and **Markdown Preview** user experiences to a CRM.
**Method:** 16 parallel repo-research agents → 3 independent solution architects → adversarial critique panel.

---

## 0. Executive summary

Three viable architectures, all named **Backline** (the gear that stands behind the band):

| | **A — Backline One** | **B — Backline Mesh** | **C — Backline Arena** |
|---|---|---|---|
| Shape | Single process, single file DB, single binary | Headless protocol platform, one services layer, N thin heads | Modular monolith + worker fleet + RAG + multi-tenant |
| Runtime | Bun + Hono + SQLite/Drizzle + Litestream | Bun + Hono + PostgreSQL (only stateful dep) | Bun/Node + Hono + PostgreSQL + pgvector + queue workers |
| Best for | 5–50 seat agency, on-prem or one container | Agency that wants agents/API as the product surface | Agency groups, labels, multi-tenant SaaS |
| Time to MVP | Fastest | Middle | Slowest |
| Scale ceiling | One writer, vertical only | Horizontal API, Postgres-bound events | Horizontal everything |

All three share the same domain model, the same Zed UX ports, and the same canonical `crm_*` operation contract. **They are the same product at three deployment weights** — which is the recommendation at the end: build A's core, ship B's contract, keep C's seams.

The single most important research correction: **`metadata-enrichment` is not a music-metadata library.** It is Salesforce's deprecated `@salesforce/metadata-enrichment` (source deleted from HEAD), for AI-describing Salesforce DX components. It cannot be the CRM's music-metadata subsystem. Music metadata must come from MusicBrainz/ISRC tooling. Its *provenance* patterns remain useful.

---

## 1. Repository research digest

Sixteen repos, each read for architecture, agentic surfaces, integration surfaces, reusable CRM patterns, UX patterns, and risks. Every claim below is anchored to a path.

### 1.1 The two UX sources

**`zed`** (Rust, GPL-3.0 — port patterns, never code) is the canonical host for external agents and the source of both requested UXs.

- **Agent Registry**: `crates/agent_ui/src/agent_registry_ui.rs` (the panel), `crates/project/src/agent_registry_store.rs` (remote index fetch, 30s timeout, 1h `refresh_if_stale` throttle, disk cache, per-icon graceful failure), `crates/project/src/agent_server_store.rs` (install-state = settings entries; `reregister_agents` diffs old vs new and re-registers launchers), `crates/agent_servers/src/acp.rs` (5.1k LOC ACP client: handshake, `request_permission`, elicitation, terminal, fs bridges), `crates/acp_thread/src/acp_thread.rs` (10k LOC session state machine, `AcpThreadEvent` vocabulary, `ToolCallStatus::WaitingForConfirmation`), `crates/acp_tools/src/acp_tools.rs` (protocol inspector).
- **Markdown Preview**: `crates/markdown_preview/src/markdown_preview_view.rs` (2.8k LOC: 200ms debounced low-priority reparse, high-priority document switch, follow mode with canonical-editor fallback, checkbox write-back, source-index ↔ block mapping) over `crates/markdown/` (pulldown-cmark with source offsets, mermaid).
- **Load-bearing risk:** the preview sync UX is impossible without a parser that preserves source offsets. Zed uses pulldown-cmark ranges; the web port must use remark/mdast `position`, not a renderer that discards positions.
- **Second load-bearing risk:** Zed's approval flow parks a `oneshot` channel inside an enum variant. Channels do not serialize. A web port must persist pending approvals as rows.

### 1.2 CRM domain sources

**`hubspot-sdk-typescript`** (Apache-2.0, alpha, Stainless-generated) contributes the CRM data-model spine:
- Property **definitions** separated from property **values** (`src/resources/shared.ts:813-1055`) — the trick that keeps a CRM both schemaless-flexible and UI-renderable; `modificationMetadata.readOnlyValue` is the agent-write gate.
- Typed labeled directional **associations** instead of foreign keys (`shared.ts:81-136`) — bookings are a graph.
- **Pipelines with per-stage `writePermissions`** (`crm/pipelines.ts:206-374`) — structurally prevents an agent auto-advancing a contracted booking.
- One closed **search algebra** (`crm/crm.ts:618-679`) — an LLM can reliably fill it; it compiles to SQL.
- **Provenance** via `propertiesWithHistory` → `ValueWithTimestamp{sourceType, sourceId}` with an AI source category, plus `objectWriteTraceId`.
- **Durable journal** (`webhooks-journal/journal/journal.ts:19-90`) — offset-cursored, replayable, ordered; strictly better than push webhooks as a source of truth.
- **Resilient HTTP core** (`src/client.ts:348-640`) — honors `x-should-retry`, parses `Retry-After`, jittered backoff, typed error ladder.

**`simple-salesforce`** (Apache-2.0) contributes the *schema-as-runtime-resource* lesson: `describe` endpoints (`api.py:310-328`), Metadata API where CustomObject/CustomField are themselves CRUD-able (`metadata.py:19-193`), external-ID upsert for idempotent sync (`api.py:1087-1118`), `updated()`/`deleted()` delta windows (`api.py:1180-1232`), transparent 401 re-login (`api.py:122-153`), API budget surfaced as data via `Sforce-Limit-Info` (`api.py:791-832`), and — critically for settlements — injectable `parse_float` so money never touches a float (`api.py:59-61`).

**`monday-sdk-js`** (MIT, server half deprecated) contributes the board/item/flexible-column view model and a rule-AST filter shape (`types/client-data.interface.ts` `FilterResponse`), plus a typed per-surface context-injection pattern for embedded panels (`types/client-context.type.ts`). Its `postMessage(..., "*")` and `Math.random()` request IDs are documented anti-patterns.

### 1.3 Agent-protocol sources

**`mcp-typescript-sdk`** (MIT): `registerTool`/`registerResource`/`registerPrompt` with zod (`src/server/mcp.ts:911`), dynamic enable/disable for per-role capability scoping (`mcp.ts:669-745`), `ResourceTemplate` + RFC 6570 with per-variable completions, Streamable HTTP stateful vs stateless by `sessionIdGenerator`, `EventStore` resumability, `outputSchema` + `structuredContent`, elicitation, the four `ToolAnnotations` hints, and a full OAuth 2.1 kit. Risks: the local v1.13.0 snapshot lacks DNS-rebinding protection; stateless mode requires a new server per request; the 60s default timeout will kill long CRM operations without progress resets.

**`mcp-servers`** (MIT, explicitly not production): the tool-design taste standard — full four-hint annotation matrix (`src/filesystem/index.ts:220-712`), dual text + `structuredContent` results, batch-first idempotent mutations that skip duplicates, elicitation as the confirmation primitive (form and URL modes with retry-dedup), tasks (SEP-1686) for long ops with `input_required`, capability-conditional registration, roots as runtime-mutable scope, server `instructions` shipped as a domain operating manual, and defensive coercion of LLM-mangled args. Explicit warning: annotation hints are advisory — **a CRM must enforce confirmation server-side**.

**`pydantic-ai`** (MIT, Python): `Agent[Deps, Output]` with `RunContext` dependency injection, composable `AbstractToolset` wrappers (`.filtered().prefixed().approval_required()`), **deferred tools** as typed run output for human-in-the-loop resume, capabilities as installable lifecycle-hook bundles, declarative `AgentSpec` (YAML/JSON, registry-resolved) — which is directly the Agent Registry's record shape — one native event stream with per-protocol UI adapters, and a documented client-input trust model (strip client system prompts, whitelist file URL schemes to block `s3://` SSRF).

**`agoragentic-integrations`** (the user's own repo, MIT + Apache-2.0 in `micro-ecf/`): already contains most of the registry primitives. `integrations.json` + `integrations.schema.json` + `scripts/verify-integrations-json.js` is a CI-enforced registry index. `acp/agent.json` is the ACP manifest shape the registry entry can adopt verbatim. `a2a/agent-card.json` is the outward-facing card template. `AGENTS.md` defines the canonical-tool-ID contract. `harness-core/schema/agent-os-harness.v1.json` is a ready-made governance policy packet (tool/budget/approval/context policies). `ag-ui/` has a backend-event → UI-hint translation table (`quote_ready→card`, `approval_required→modal`, `receipt_ready→artifact card`). The quote → approval → execute → **receipt** lifecycle in `specs/ACP-SPEC.md` is structurally identical to hold → contract → settlement. Warning carried forward: "ACP" is triple-overloaded in this repo; the CRM must disambiguate in docs.

### 1.4 Platform and infrastructure sources

**`onyx`** (MIT core, EE dirs separately licensed — do not copy `backend/ee/`): connector capability interfaces (`connectors/interfaces.py`) with checkpointed generators yielding `Document | ConnectorFailure`; an **MCP server registry persisted in DB** with per-server transport/auth/ACLs (`db/models.py:4930-5060`, admin UI `web/src/sections/actions/MCPActionCard.tsx`) — this is the Agent Registry as a database schema; dual MCP posture (server *and* client with SSRF guard); a uniform Tool ABC serving chat, API, and MCP from one implementation; typed streaming packet protocol; a single `OnyxError` with stable machine-readable codes; LLM tracing that auto-wraps every call and emits `UNTAGGED_*` sentinels for missed instrumentation; document-level access sets with fail-closed `ExternalAccess.empty()`; tenant contextvar + schema-per-tenant; and the "consolidated background app" trick for small deployments.

**`bun`** (MIT, links LGPL JavaScriptCore — matters only for distributed `--compile` binaries): collapses six dependencies into the runtime — typed `Bun.serve({routes})`, `bun:sqlite`, `Bun.SQL` (SQLite→Postgres graduation path), native WebSocket topic pub/sub (no Redis), `Bun.cron`, `Bun.password`/`Bun.CSRF`/`Bun.secrets`, `Bun.s3` with sync presigned URLs, fullstack HTML imports, `bun test`, workspaces + catalogs, `bun build --compile`. Honest gaps: `node:http` client bodies buffer instead of stream (breaks large Bulk 2.0 uploads through Node-style SDKs), workers experimental, `Bun.markdown` and `Bun.secrets` flagged unstable, the bundler does not typecheck.

**`notebooklm-mcp-cli`** (MIT): the layering blueprint — one `services/` layer, `cli/` and `mcp/` as ~20-line heads that must not import `core/`. Also: two-phase `confirm=false` → `pending_confirmation` echo; `ServiceError{message, user_message, hint, debug_code}` where `NotFoundError` auto-generates the next command an agent should run; an idempotency-aware retry taxonomy (retry connect-phase failures, **never** retry read/write timeouts on mutating calls); upstream-drift detection with env hot-patch; decorator tool registry with sensitive-param redaction; `coerce_list()` cataloging how real MCP clients mangle params; and `nlm setup add <host>` — a first-class registry of *agent hosts*, the inverse of what the CRM needs. Its own `SKILL.md` rule 4 documents a real confirmation-gate drift bug: **enforce gates in services, not per tool.**

**`lumen`** (the user's own workspace, Apache-2.0): governance primitives. A mode × scope permission matrix with a **never-ALLOW-egress invariant** (`scrum/permissions.ts`) — agents may draft freely, but sending a contract to a promoter is human-gated in every mode with no bypass. A single validating write seam (`filesystem-tool.ts`) where validators *block but never mutate*, so what the agent proposed is byte-for-byte what lands. Record-before-act append-only ledger with a DB trigger physically rejecting UPDATE/DELETE (`chainz.ts`, `state/schema.sql`). Typed signal envelopes with a closed `kind` catalog. A pure-function dispatcher with loop-guard, WIP limit, and single-writer-per-resource contention. A brief compiler that assembles context cheaply before spending on the expensive model. Cost-aware triage with hard budget caps that fail *degraded-and-visible*, never silently overspending. Per-role MCP tool RBAC, fail-closed. Persona-as-registry: agents as markdown files with YAML frontmatter declaring model tier and tool grants.

**`spec-kit`** (MIT): the workflow layer — machine-parseable task grammar, constitution-as-gate, declarative lifecycle hook bus (`before_<event>`/`after_<event>`), resumable YAML workflows with human review gates and fan-out, a pluggable agent registry with `requires_cli` checks and manifest-tracked install/uninstall, a layered customization stack (project > preset > extension > core), bounded clarification (max 3 questions, A/B/C/Custom), and a curated-vs-community catalog split with an `install_allowed` flag — the governance model for an agent marketplace.

**`raptor`** (MIT, stale 2024, algorithm reference only): recursive embed → cluster → summarize into a tree; **collapsed-tree retrieval** ranking leaves and summaries in one token-budgeted pool is the single most reusable idea — an agent asking "what's our history with this promoter" gets summaries, one verifying a contract clause gets leaves. Layer provenance on results is the citation hook. Gaps to fix in any port: no incremental update (must design subtree invalidation), pickle persistence, O(n) brute-force query, and summarization errors silently embedded into node text.

**`ollama`** (MIT): the local/private LLM backend, consumed as a service not a library. Contributes: a declarative integration registry with install detection (`cmd/launch/registry.go`) — a second reference for the registry panel; tool-execution approval with deny/once/always session allowlists; protocol-adapter middleware (one internal handler, N wire dialects) — exactly how the CRM should host MCP/A2A/Salesforce/HubSpot; the Modelfile as a declarative blueprint compiled to an API request (template for an "Agentfile"); **capability enumeration with graceful degradation** (query `/api/show`, never assume tool support); stale-while-revalidate registry caches; and `app/ui/app/src/components/StreamingMarkdownContent.tsx` — streaming markdown with memoized shiki code blocks, the solved form of the Markdown Preview UX for the streaming-agent case.

**`metadata-enrichment`** (Apache-2.0, **deprecated, source deleted from HEAD**; historical source at commit `c14991b`): not music metadata. Still contributes an enrichment-job lifecycle worth copying: per-record status `NOT_PROCESSED → SUCCESS/FAIL/SKIPPED`, `Promise.allSettled` fan-out where rejections become FAIL records rather than aborting the run, pre-flight skip-set validation before any network call, a metrics rollup serving both UI and JSON, and `modelUsed`/`descriptionScore` provenance plus a `skipUplift` consent gate — which becomes the CRM's `hand_curated` flag that agents must never overwrite.

---

## 2. The two Zed UX ports (shared by all three solutions)

Both UXs are ported identically in every solution; only the storage and transport differ.

### 2.1 Agent Registry

**Data.** A versioned `registry.json` index, entry schema adopted from `agoragentic-integrations/acp/agent.json`:

```jsonc
{
  "schema_version": "1",
  "id": "backline.tour-router",
  "name": "Tour Router",
  "version": "2.1.0",
  "description": "...",
  "icon": "<svg…>",
  "runtime": { "type": "mcp-http" | "a2a" | "stdio-on-server", "url": "…", "headers": {} },
  "auth": [{ "type": "oauth" | "api_key" | "env", "name": "…", "required": true, "how_to_get": "…" }],
  "capabilities": { "tools": true, "streaming": true, "elicitation": true, "tasks": true },
  "recommended_tools": ["crm_search", "crm_create_hold"],
  "categories": ["routing", "booking"]
}
```

Fetched with Zed's robustness trio verbatim (`agent_registry_store.rs:204-326`): 30s hard timeout, 1-hour `refresh_if_stale` throttle, raw-body cache reused on cold start, per-icon graceful failure. Index hygiene enforced in CI exactly like `verify-integrations-json.js` (path existence, ID prefix regex, duplicate keys, docs presence).

**Install is a config row, not a process.** Zed's settings-file-as-install-database (`agent_registry_ui.rs` `install_button` + `agent_server_store.rs` `reregister_agents`): installing writes a declarative entry; removing deletes it; a change observer diffs old vs new and re-registers launchers. Install state is therefore auditable, hot-reloadable, exportable, and editable via API, UI, or JSON import equally. Install status is the two-source model — registry-installed vs custom-installed vs not-installed — by cross-referencing index membership with config rows (`agent_registry_ui.rs:32-37,146-167`).

**Transport is inverted.** Zed spawns local child processes over stdio. A web CRM must not. The sanctioned path is Zed's own Remote/Collab proto-mirroring of `AgentServerStore` (`agent_server_store.rs:145-161`): connections live server-side, the browser sees state. On connect, the CRM acts as MCP client (SDK `Client` + `OAuthClientProvider`) or A2A client, runs `initialize`, records negotiated capabilities, and runs a registration-time smoke test (`scripts/verify-acp.js` pattern: connect → initialize → list-tools → assert capability claims) before marking healthy.

**Connection store.** Per-agent state `Connecting{shared promise}` / `Connected{capabilities}` / `Error{detail}` — concurrent requesters await the same promise (`agent_connection_store.rs`). Watch channels become WebSocket topics carrying status text ("authorizing…"). Version-diff reconnect handshake from `agent_server_store.rs:337-472`: changed version → "reconnect to update" banner; unchanged → status transfers silently.

**Panel UI** (translating `agent_registry_ui.rs` to React): search input live-filtering id/name/description; All / Installed / Not-Installed toggle group; virtualized card list (icon with Sparkle fallback, name, `v{version}`, truncated description, ID line, repo/website icon buttons); state-driven trailing action Install / Remove / Unavailable; distinct empty states per filter × search combination; fetch-error state with Retry; scroll-to-top on filter change.

**Threads.** The `AcpThreadEvent` vocabulary (`acp_thread.rs:2144`) becomes a typed WebSocket protocol: `NewEntry`, `EntryUpdated(ix)`, `EntriesRemoved(range)`, `ToolAuthorizationRequested`, `TokenUsageUpdated`, `Stopped(reason)`. It drives an index-addressed virtualized entry list with lazily-materialized per-entry view state — the `entry_view_state.rs` split is what keeps 500-entry threads fast. Streaming text uses the `StreamingTextBuffer` trick verbatim (`acp_thread.rs:2108-2132`): buffer unrevealed chunks, drain on a 16ms timer targeting ~200ms full reveal.

**Approvals are rows.** Because oneshot channels do not survive the web, a permission request creates a `pending_approval` row `{tool_call_id, options[Allow|Reject × Once|Always], command_patterns?, expires_at}`; the agent's request blocks on it server-side; resolution resumes the job. Rendered with Zed's Flat / Dropdown / DropdownWithPatterns button variants (`thread_view.rs:9154`). "Always allow" writes an `agent_policies` rule. Because it is a row, an approval survives restart and renders on a phone.

**Governance on top of Zed.** Each installed agent carries a policy packet from `harness-core/schema/agent-os-harness.v1.json` — `tool_policy`, `budget_policy`, `approval_policy`, `context_policy`. Evaluated in the services layer. **EGRESS-class operations (send contract, email promoter, write to Salesforce) are never auto-allowed regardless of any "Always" grant** — lumen's never-ALLOW-egress invariant, defensively asserted so a future table edit cannot open a hole.

**Debug.** An admin "Protocol Inspector" page tailing every JSON-RPC frame per connection from a ring buffer, with direction icons, expandable payloads, and request-id→method correlation both ways (`acp.rs` debug tap + `acp_tools.rs`) — agent misbehavior becomes diagnosable by an ops admin, not only a developer.

**@-mentions.** `MentionUri` (`acp_thread/mention.rs`) becomes a typed `crm://` URI scheme — `crm://artist/{id}`, `crm://booking/{id}`, `crm://venue/{id}`, `crm://release/{id}`. Autocomplete inserts ordinary markdown links, so references survive serialization, render as hoverable chips, and are parseable by any agent reading the same note through the API. **The same URIs are the MCP resource namespace**, so a mention in a note *is* an addressable resource.

### 2.2 Markdown Preview

Used for notes, contracts, riders, tour advances, artist one-sheets, and agent-authored documents.

**The load-bearing mechanic is source-offset mapping.** CodeMirror 6 for editing; `unified`/`remark` (remark-parse + remark-gfm) for parsing, because mdast nodes carry `position.start.offset`/`end.offset`. A custom React renderer stamps `data-source-start`/`data-source-end` on every block element. That one map powers all four sync behaviors from `markdown_preview_view.rs:410-1018`:

1. Editor selection change → find enclosing block by offset → preview autoscroll + active-block highlight ring (`set_active_root_for_source_index`).
2. Preview click → `data-sourcepos` → CodeMirror `dispatch(setSelection)` and focus.
3. Checkbox click in preview → locate the exact `[ ]`/`[x]` byte range → CodeMirror replace transaction. **Never re-serialize the tree** — the source stays canonical.
4. Heading anchors and `crm://` mention links resolve to in-app routes; external links open new tabs.

**Reparse pipeline** copies the debounce discipline exactly (`markdown_preview_view.rs:48,508-580`): edits schedule one pending low-priority parse debounced 200ms, dropped if one is already queued; a document switch is high-priority and skips the debounce. Parsing runs in a Web Worker so keystrokes stay at 60fps on long contracts.

**Follow mode**: a side panel with two modes — Pinned (one document) and Follow (retargets to whichever markdown record is active, with canonical-editor fallback when the original view closes) (`markdown_preview_view.rs:65-98,348-505`). Mode and font-size step persist per user (their `SerializableItem` `to_db` pattern → a `user_prefs` row).

**Rendering extras**: mermaid via dynamic import, code blocks with copy-on-hover, optional KaTeX, browser-native find (the preview is real DOM), and `rehype-sanitize` with a strict schema — **agent-generated markdown is untrusted input**.

**Streaming reuse**: the same renderer displays streaming agent output (ollama's `StreamingMarkdownContent.tsx` pattern — memoized code blocks, stable layout while tokens arrive), so a contract draft streams into the exact component a human then edits. Preview-before-apply for agent-drafted revisions shows a diff of proposed markdown against current, gated by an approval row.

**Server-side**: the same remark pipeline renders for PDF export and email. `Bun.markdown.html()` may serve a fast read-only path behind an adapter interface — it is flagged unstable and lacks source positions, so it can never be the primary.

---

## 3. Shared domain model — music management & booking

All three solutions implement this. Storage differs; semantics do not.

**Core CRM.** `contacts` (buyers, tour managers, label reps), `companies` (kind: venue | promoter | label | agency | brand), `deals`, `activities` (call/email/meeting), `notes` (markdown), `tasks`, `pipelines`/`pipeline_stages`.

**Roster & catalog.** `artists` (roster status, territories, `commission_rate_bps`, management type, manager links); `releases` (title, type, `upc` unique, release date, label, catalog no.); `tracks` (`isrc` UNIQUE, format-validated `CC-XXX-YY-NNNNN`, duration, contributors); `works` (`iswc` UNIQUE `T-NNNNNNNNN-C`, writers, `splits_bps`). Track ↔ Work is a many-to-many "embodies" association — **the recording/composition distinction is modeled, not blurred.**

**Booking.** `venues` (capacity, city, geo, tech-pack refs); `promoters`; `tours` → `tour_stops`; `bookings` (artist, venue, promoter, event_date, status `inquiry → hold → confirmed → contracted → played → settled | cancelled`, `guarantee_cents`, `deal_type: flat | vs_split | door_split`, `split_bps`, currency).

**The hold ladder is a real constraint, not a status string.** `holds` (booking_id, venue_id, event_date, `level` 1–5, status `active | challenged | released | promoted`, `expires_at`) with `UNIQUE(venue_id, event_date, level) WHERE active`. A *challenge* is a service operation that notifies the level above; *promotion* H2→H1 happens only when H1 releases or expires. This etiquette is encoded as service-layer invariants the agent layer cannot bypass.

**Money.** `contracts` (booking, version, status `draft → sent → redlined → executed`, markdown body + executed PDF blob ref, **immutable after executed**); `settlements` (status `draft → submitted → approved → paid`, **immutable after approved**, enforced by trigger) with `settlement_lines` (kind: guarantee | door | expense | commission | tax). **All money is integer minor units plus currency** — never floats near a settlement (`simple-salesforce api.py:59-61` lesson).

**Flexibility layer.** `property_definitions` (name, type incl. `money`/`isrc`/`iswc`, field_type, options, `has_unique_value`, required, searchable, group, display_order, `modification_metadata{read_only_value, agent_writable}`) + `object_schemas`, exposed through `/describe` so both agents and forms introspect at runtime. Typed columns for the spine; JSON for runtime-defined fields.

**Associations** as typed labeled directional edges `{from_type, from_id, to_type, to_id, association_type_id, label, category: SYSTEM | USER | INTEGRATOR}` — because artist ↔ promoter history, agent-of-record, and support-act relationships outgrow foreign keys.

**Audit spine.** `property_history` / `field_history` (record, property, value, ts, `source_type: USER | API | IMPORT | AGENT | SYNC`, source_id, `agent_run_id`, `model_used`, `confidence`) plus a per-record `hand_curated` boolean that agents must honor as a write opt-out.

**Sync spine.** `sync_links` (record_id, system, external_id, last_synced_at, etag) and `sync_cursors` per connector.

**Agent spine.** `agent_servers`, `agent_sessions`, `agent_entries`, `pending_approvals`, `elicitations`, `agent_policies`.

---

## 4. Solution A — **Backline One** (single-binary, local-first appliance)

> *Everything must be earned.* One process, one file database, one deployable artifact.

### 4.1 Philosophy

A music agency of 5–50 seats does not need distributed infrastructure; it needs correctness, auditability, and speed. So the usual architecture is inverted: **the domain services layer is the product**, and the web UI, REST API, MCP server, A2A card, and CLI are all thin heads over it (the `notebooklm-mcp-cli` "one services layer, N thin heads" rule). Agents are first-class clients, not a bolted-on chat panel: every mutation flows through one policy-checked write seam with an append-only ledger written *before* the act (lumen's `FileSystemTool` + `chainz.ts` record-before-act), every agent-written field carries provenance (HubSpot `sourceType`/`objectWriteTraceId`), and every destructive operation is gated by a persisted human approval. Local-first means the agency owns its data — a SQLite file it can copy — can run fully offline against Ollama, and streams to S3 for durability. **Not CRDT sync**, which is complexity not yet earned for a single-team tool with a server always present.

### 4.2 Stack

| Layer | Choice | Why |
|---|---|---|
| Runtime | **Bun 1.3.x**, version-pinned in CI | Collapses six deps into the runtime: HTTP+WS with native topic pub/sub, `bun:sqlite`, `Bun.cron`, `Bun.password`/`CSRF`/`secrets`, `Bun.s3` presigned URLs, `bun test` |
| Server | **Hono** | fetch-native, ~14kB, first-class `zod-openapi`, stays Node/Workers-portable (Elysia is not) |
| DB | **SQLite via `bun:sqlite` + Drizzle**, WAL, **Litestream** → S3 | Typed schema and migrations, no runtime codegen, zero ops |
| UI | Vite + React 19 + TS + Tailwind + **shadcn/ui** (Radix) | Radix primitives buy the WCAG baseline |
| Editor | CodeMirror 6 + `unified`/`remark` | remark preserves source positions — required for preview sync |
| Validation | **Zod v4** as single schema source | Compiled to JSON Schema for MCP tools, OpenAPI, and elicitation forms |
| Agent protocol | `@modelcontextprotocol/sdk` | `StreamableHTTPServerTransport` needs only `node:http`; skip the Express OAuth router, do bearer auth in Hono |
| LLM | Anthropic API default; **Ollama** private option | Consumed via `/api/chat` with capability probing through `/api/show` — degrade per model, never assume parity |
| Deploy | one `oven/bun` container, or `bun build --compile` | Note the LGPL JavaScriptCore relink obligation when distributing binaries |

**No Redis, no Postgres, no queue system in v1.** The Bun-only APIs sit behind five small adapter interfaces (`Db`, `Clock`, `Pubsub`, `Blob`, `Scheduler`) so a forced Node retreat costs a week, not a rewrite.

### 4.3 Architecture

Single process, four layers, strict import direction (enforced by ESLint boundaries):

1. **`core/`** — Drizzle schema, repositories, the append-only `event_log` (SQLite trigger raising on UPDATE/DELETE, lumen's `prevent_updates`), and **the write seam**: one `commit(mutation, actor, policyContext)` that (a) resolves the permission matrix, (b) runs pure validators that **block but never rewrite**, (c) appends intent to `event_log`, (d) applies the write in a transaction, (e) publishes to the in-process pubsub topic (`record:{type}:{id}`, `pipeline:{id}`, `agent:{sessionId}`).
2. **`services/`** — all business logic: bookings, holds, contracts, settlements, catalog, pipeline, prospecting, enrichment, sync, agents. Each function takes deps + typed input, returns typed DTOs, throws only `ServiceError` subclasses carrying `{error_code, message, user_message, hint}` (onyx codes + notebooklm's hint affordance — `NotFoundError` auto-suggests the list call an agent should make next).
3. **`heads/`** — Hono REST routes, MCP tool modules registered through a decorator-style registry with sensitive-param log redaction, A2A endpoints, WebSocket topics, and the web UI served from the same process via Bun fullstack HTML imports.
4. **`jobs/`** — `Bun.cron` entries (nightly Salesforce/HubSpot/monday sync, hold-expiry sweep, settlement reminders, relationship summarization). Every job is resumable from a checkpoint row because long work is modeled as **task records** with status `working → input_required → completed`, not in-memory promises; a restart re-hydrates from `event_log` + checkpoints.

**Realtime** uses Bun's native `ws.subscribe` / `server.publish` — no socket.io, no Redis. **Scaling is vertical and honest**: one writer process per agency; read-heavy load is fine under WAL; the `event_log` doubles as the external change journal.

### 4.4 Headless surface

**Canonical tool IDs.** One authoritative table of `crm_*` operations (`crm_search_records`, `crm_get_record`, `crm_create_hold`, `crm_challenge_hold`, `crm_promote_hold`, `crm_update_deal_stage`, `crm_draft_contract`, `crm_submit_settlement`, `crm_add_note`, `crm_start_research`, …) mirrored identically across MCP tools, A2A skills, and REST routes, with a CI check asserting the surfaces never drift (`agoragentic-integrations` canonical-tool-ID contract + `verify-integrations-json.js`).

**REST**: Hono + `zod-openapi`, OpenAPI 3.1 at `/openapi.json`. HubSpot envelope conventions because they are agent-legible — cursor pagination `{results, paging:{next:{after}}}`, the closed search DSL compiled to SQL, batch upsert keyed by external `idProperty` (ISRC, sync IDs) with per-item error partitioning `{status, results, errors[], numErrors}`, and soft-delete/restore/merge record lifecycle. Errors use a uniform `{error_code, detail, hint}` envelope; every response carries an `X-Backline-Usage` quota header (the `Sforce-Limit-Info` pattern) so agents self-throttle.

**Change journal**: `GET /journal?after={offset}` — a durable offset-cursored pull feed straight off `event_log` with typed event classes and action enums. Push webhooks exist as a convenience; **the journal is the source of truth.**

**MCP**: Streamable HTTP at `/mcp` in stateless mode (new server + transport per request — sessionless and horizontally safe), plus a tiny published `backline-mcp` npm binary that runs as a **stdio relay** to the HTTP endpoint for desktop hosts (the `agoragentic` single-binary-two-protocols blueprint). Tool discipline from `mcp-servers`: full four-hint annotations, zod `inputSchema` **and** `outputSchema` with dual `content` + `structuredContent` returns, verb-first names, and server `instructions` markdown shipped in `initialize` carrying domain rules ("always check hold conflicts before creating a booking; settlements are immutable after approval"). CRM records are exposed as **resources** (`crm://artist/{id}` via RFC 6570 templates with per-variable completions) and playbooks as **prompts** — not a tools-only surface. Long operations are pollable tasks. Confirmations are enforced in `services/` as two-phase `confirm:false` → `pending_confirmation` preview echoing exact settings. Defensive coercion of LLM-mangled params happens at the boundary.

**A2A**: `/.well-known/agent-card.json` publishing the same canonical `crm_*` set as skills with `inputModes`/`outputModes` and a bearer descriptor with key prefix `bck_`; task lifecycle `submitted → working → completed` with structured outputs as `DataPart`. **"ACP" is explicitly disambiguated in the docs**: the CRM implements Agent Client Protocol as a *client* (hosting registry agents) and A2A as a *server* (exposing itself as an agent).

**Machine auth**: API keys `bck_<id>.<secret>` stored sha256 with displayable truncation and dual Bearer/raw header acceptance (onyx `auth/api_key.py`), per-key role → per-role MCP tool allowlist, fail-closed on unknown role (lumen `mcp/rbac.ts`).

**Discovery stack**: `AGENTS.md`, `SKILL.md`, `llms.txt`, `llms-full.txt`, `/.well-known/*`, and a live `/api/discovery/check` self-test — so an agent can find, learn, and connect with zero human help.

### 4.5 Integrations

One connector framework shaped by onyx's capability interfaces: each connector implements some of **Poll** (time-windowed incremental), **Checkpointed** (resumable generator yielding `Record | ConnectorFailure`, returning a typed checkpoint), **Slim** (ID-only pass for prune/delete detection), and **OAuth**. Sync is idempotent by construction: writes keyed through `sync_links` external IDs, upsert-by-external-key both directions. The retry taxonomy is copied verbatim from notebooklm's `core/retry.py`: retry 429/5xx with jittered backoff honoring `Retry-After`, but **transport retries only on connect-phase failures** so mutating calls are never duplicated after a write timeout. Rate limiting is proactive sliding-window per connector, not reactive-only.

- **Salesforce** — own thin client on the REST API (patterns from `simple-salesforce`, not its code): OAuth2 JWT bearer, transparent 401 re-login with bounded retry, describe-driven field mapping UI, `updated()`/`deleted()` window polling, Bulk 2.0 CSV jobs with per-row failed/successful retrieval, `Sforce-Limit-Info` parsed to schedule syncs under org quota.
- **HubSpot** — `@hubspot/sdk` pinned exactly (alpha) and wrapped behind a `SyncPort` interface, never importing resource files directly; tree-shakable `createClient` mounting only CRM resources; inbound via webhooks-journal offset polling; outbound via batch upsert; associations map 1:1 to the labeled-edge table.
- **monday.com** — `@mondaydotcomorg/api` (the README-designated successor; `monday-sdk-js`'s server half is deprecated), GraphQL with complexity-budget-aware throttling and `items_page` cursor pagination, pipelines ↔ boards and stages ↔ status columns. The deprecated SDK is used only if an embedded monday board view ships — with origins pinned, never its `postMessage('*')`.
- **Field mapping is data, not code** — a mapping table per connector resolved against both sides' describe output, editable in an admin UI.
- **Music industry** — MusicBrainz (free, 1 rps respected) for release/recording enrichment and ISRC validation; Spotify Web API optional for audience signals feeding prospecting. Enrichment runs as per-record jobs with the `metadata-enrichment` lifecycle: `NOT_PROCESSED → SUCCESS/FAIL/SKIPPED`, `Promise.allSettled` fan-out, rejections downgraded to FAIL records, pre-flight skip-set validation, metrics rollup serving both UI toast and JSON. Every enriched field lands in `field_history` with model + confidence; `hand_curated` records are SKIPPED. **DDEX delivery is explicitly out of scope for v1.**
- **Agentic frameworks** — MCP + A2A cover LangChain/CrewAI/Vercel AI/pydantic-ai consumers through their MCP clients. **No 65 thin adapters** (the `agoragentic-integrations` adapter-sprawl anti-pattern); one canonical MCP surface plus published OpenAPI is the interop story.

### 4.6 Accessibility and mobile

WCAG 2.2 AA verified in CI (axe-core against Playwright flows + Storybook a11y addon per component). shadcn/ui = Radix, so dialogs, menus, comboboxes, and the registry toggle group ship with correct roles, focus trapping, and keyboard interaction. **Zed's keyboard-first action system is rebuilt for the web** — every command (create hold, challenge hold, approve tool call, open preview, follow mode) is a named action dispatchable from a command palette with rebindable shortcuts; GPUI has no web-ARIA analog, so this is net-new. Agent-specific a11y: streaming output announces via a throttled `aria-live="polite"` region with sentence-boundary batching (not per-token); pending approvals are modal with focus moved to the safest option; elicitation JSON-schema forms render as native labeled controls with fieldset/legend for enums; `prefers-reduced-motion` disables the streaming reveal animation and mermaid transitions. Theming is token-based light/dark with all pairs ≥4.5:1 and focus rings never suppressed. Mobile: same SPA, responsive-first — pipeline board collapses to a swimlane list, calendar to an agenda view, markdown preview becomes edit/preview tabs, agent panel becomes a bottom sheet; touch targets ≥44px; approval pushes arrive as web-push so a manager can approve a hold promotion from a phone; MCP resumability (Last-Event-ID replay via a SQLite-backed `EventStore`) means agent streams survive mobile network drops. Settlement tables get proper `th`/`scope` with a per-row card fallback under 480px.

### 4.7 Tradeoffs — and when *not* to pick it

1. **Bun risk is real.** `node:http` client bodies buffer instead of stream, so large Bulk 2.0 CSV uploads must use `fetch` with streams and any vendor SDK doing Node-style uploads needs verification. `Bun.markdown` and `Bun.secrets` are flagged unstable. The five adapter interfaces and Hono's portability are the mitigation, but a forced migration is still real work.
2. **Single-writer SQLite = single node.** Fine to ~50 seats and hundreds of agent sessions/day; wrong for multi-tenant SaaS with thousands of orgs. Litestream gives durability, not HA — failover is minutes, not seconds.
3. **No queue system.** `Bun.cron` + task rows + event-log resumption covers scheduled sync and long agent jobs, but there is no work-stealing and no priority preemption; a crash mid-job re-runs from the last checkpoint, so connectors must be checkpoint-honest.
4. **Local-first is a posture, not CRDT.** Offline mobile writes are not supported (read-only cache offline).
5. **Protocol churn.** ACP is pinned `=2.0.0`-with-`unstable` in Zed itself; A2A is being deprecated *out of* pydantic-ai core toward fasta2a; MCP stateless mode requires new-server-per-request or request-ID collisions. The versioned adapter layer needs quarterly maintenance.
6. **Two of three CRM integrations sit on shifting vendor ground** (HubSpot SDK alpha, monday server SDK deprecated). The `SyncPort` wrapper is the insurance.
7. **Do not pick Backline One if**: you need multi-region HA or >100 concurrent heavy writers; your org mandates Node LTS + Postgres; you need embedded BI over years of data; you need DDEX delivery or royalty accounting in v1; or you want the CRM itself to be a horizontal multi-tenant product. This architecture is deliberately an appliance.

### 4.8 Roadmap

| Phase | Weeks | Content |
|---|---|---|
| 0 Skeleton | 1–2 | Bun+Hono+Drizzle+SQLite, write seam + `event_log` append-only trigger, `ServiceError` taxonomy, auth (sessions + `bck_` keys), CI (`tsc --noEmit` since Bun's bundler doesn't typecheck, `bun test`, axe smoke) |
| 1 CRM core | 3–6 | Contacts/companies/artists/venues/promoters, `property_definitions` + `/describe`, associations, pipelines with per-stage write permissions, activities/notes/tasks, search DSL → SQL compiler, cursor pagination, `field_history`; SPA shell, command palette, record pages, pipeline board |
| 2 Booking | 7–10 | Bookings, hold ladder with uniqueness constraints + challenge/promote services, tours with calendar and agenda views, contracts (markdown + immutability validator), settlements with cents-only math and approval state machine; markdown editor + preview with full offset sync, follow mode, checkbox write-back |
| 3 Headless | 11–14 | OpenAPI 3.1, `/journal`, batch upsert, MCP server (tools+resources+prompts+annotations+instructions, stateless HTTP + stdio relay), two-phase confirmations in services, A2A card + tasks, discovery stack, protocol inspector |
| 4 Agent registry | 15–18 | `registry.json` + CDN cache/throttle, settings-as-install-DB with observer re-registration, connection store with shared-promise dedupe and version-reconnect, thread UI on the `AcpThreadEvent` vocabulary with `StreamingTextBuffer`, persisted approvals + elicitations, `agent_policies` (allowlists, budget caps failing degraded-not-blocked), Ollama capability-probed local option |
| 5 Integrations | 19–24 | Connector framework (Poll/Checkpointed/Slim), Salesforce, HubSpot, monday, field-mapping admin UI, MusicBrainz enrichment with per-record lifecycle + consent gate |
| 6 Hardening | 25–28 | WCAG audit of full flows, mobile bottom-sheet agent panel + web-push approvals, Litestream runbook + restore drills, load test to the honest single-node ceiling, `bun build --compile` on-prem artifact, RAPTOR-style relationship-summary trees as an optional background capability — **earned only now, last** |

---

## 5. Solution B — **Backline Mesh** (protocol-centric headless platform)

> The CRM is not a web app with an API bolted on. It is a typed services layer plus an append-only event log; everything else is a thin, replaceable head.

### 5.1 Philosophy

The `notebooklm-mcp-cli` layering rule scaled up to a product: one place for business logic, validation, and confirmation gates; N presentation adapters of ~20 lines each. **Protocols are the product surface.** Every capability is defined once as a canonical `crm_*` operation (the `agoragentic-integrations` canonical-tool-ID pattern, CI-enforced) and mechanically projected into REST routes, GraphQL fields, MCP tools, and A2A skills. Agents being first-class clients concretely means: structured error contracts with machine-actionable hints, two-phase confirmation gates enforced in the services layer (not per tool — notebooklm's `SKILL.md` rule 4 documents exactly the drift bug you get otherwise), per-value write provenance including an AI source category, and a durable offset-cursored change journal instead of fire-and-forget webhooks. **Humans get the same data shapes agents get; the UI never has a privileged path.**

### 5.2 Stack

Bun 1.3 (pinned), TypeScript 5.x strict, ESM, **Bun workspaces monorepo**: `packages/domain`, `services`, `api`, `mcp`, `a2a`, `connectors`, `web`, `sdk`, `cli`, with version catalogs.

- **HTTP**: Hono 4 on `Bun.serve` — Hono keeps a Node escape hatch; `Bun.serve` provides native WebSocket topic pub/sub for live boards and agent activity feeds with zero Redis.
- **DB**: **PostgreSQL 16 as the only stateful dependency** — Drizzle ORM, **pgvector** for note/knowledge embeddings, `LISTEN`/`NOTIFY` + `FOR UPDATE SKIP LOCKED` polling workers for the outbox and sync jobs. No Redis, no broker. This is the deliberate lightweight bet.
- **Schema single source of truth**: **Zod 4** — each domain operation is `{input, output, annotations}`; zod→JSON Schema feeds MCP tool advertisement, `zod-openapi` emits OpenAPI 3.1, and **Pothos** builds the GraphQL schema from the same types.
- **MCP**: `@modelcontextprotocol/sdk` pinned ≥ the DNS-rebinding-protected line, `StreamableHTTPServerTransport` in stateless mode + a **Postgres `EventStore`** implementing `storeEvent`/`replayEventsAfter`.
- **A2A**: `@a2a-js/sdk` serving the FastA2A shape (Storage/Broker/Worker/TaskManager from pydantic-ai `_a2a.py`) backed by the same Postgres job tables.
- **Auth**: OAuth 2.1 resource server via the MCP SDK auth kit (`requireBearerAuth` + `ProxyOAuthServerProvider` delegating to the agency's IdP) plus tenant-prefixed API keys `blk_<tenant>.<secret>` sha256-stored; integration tokens in encrypted Postgres columns.
- **Web**: React 19 + Vite, TanStack Router/Query, Tailwind 4, **React Aria Components** for WCAG, CodeMirror 6, `unified`/`remark`.
- **HTTP client**: one hardened fetch core copied structurally from `@hubspot/sdk` `client.ts:565-640`.
- **Tests**: `bun test` + Playwright; `tsc --noEmit` in CI.

### 5.3 Architecture — five strictly one-directional layers

1. **`packages/domain`** — entities, Zod schemas, and **the canonical operation registry**: a typed map `crm_*` id → `{input, output, annotations{readOnlyHint, destructiveHint, idempotentHint, openWorldHint}, requiredScope, confirmRequired}`. Annotations follow the full four-hint discipline: reads readOnly; upserts destructive+idempotent; external-sync ops `openWorld:true`.
2. **`packages/services`** — all business logic. Every function takes `(ctx: RunContext, input)` where `RunContext` carries tenantId, principal (user | api-key | agent-session), scopes, requestId, idempotencyKey — pydantic-ai's `RunContext` DI shape ported to TS. Returns typed DTOs; raises only `ServiceError{code, message, hint, retriable}`. **Confirmation gates, scope checks, and provenance stamping happen here, once.**
3. **Event backbone** — every mutation writes, *in the same Postgres transaction*: (a) the record change, (b) an append-only `event_log` row (UPDATE/DELETE physically rejected by trigger), (c) an `outbox` row. Record-before-act. An outbox dispatcher (SKIP LOCKED poller, at-least-once, consumer-side idempotency keys) fans out to WebSocket topics, the public journal `GET /v1/journal?after=<offset>`, MCP `notifications/resources/updated` for subscribed sessions, and connector sync triggers.
4. **Heads** — REST (Hono), GraphQL (Yoga + Pothos), MCP server, A2A endpoint, CLI (`blk`), web UI. Each head is projection + error translation only, generated from the operation registry where mechanical.
5. **Workers** — the same binary run with `--role worker` (onyx's consolidated-background-app trick) executing outbox dispatch, connector sync, hold-expiry sweeps, and agent job runs.

**Deployment**: one container image, two processes (api, worker), one Postgres. Horizontally scalable because MCP is stateless-mode and all session/journal state lives in Postgres.

### 5.4 Data model note

Two-tier record model: a generic `record` table `{id, tenant_id, object_type, properties jsonb, …}` plus a `property_def` metadata layer and `object_schema` — so agencies **and agents** can add custom types and fields at runtime (a Metadata-API-style schema-as-data surface), while first-class music entities get typed Drizzle overlays, real columns, and real constraints. Search is one closed JSON query algebra over all types, compiled to SQL, exposed identically in REST, GraphQL, and as one MCP tool `crm_search`.

### 5.5 Headless surface — one registry, four projections

~40 canonical `crm_*` operations, polymorphic where it reduces context bloat (notebooklm's consolidated `source_add(source_type=…)` pattern), with descriptions documenting idempotency, side effects, and error shapes in the text itself ("MAY SEND EXTERNAL EMAIL", "NOT idempotent").

- **REST**: `/v1/{objectType}` generic CRUD + typed convenience routes; `/v1/{objectType}/search`; `/v1/{objectType}/batch/{create|update|upsert|archive}` with upsert keyed by `idProperty` and error-partitioned responses; soft delete/restore/merge/`gdpr_delete`; `/v1/describe` and `/v1/describe/{objectType}`; `/v1/journal?after=<offset>`; `X-Backline-Usage` on every response; server-emitted `x-should-retry` and `Retry-After` so well-behaved clients inherit correct backoff; `Idempotency-Key` on all mutating routes deduped on (tenant, key, operation-hash).
- **GraphQL** at `/v1/graphql` (Pothos over the same services) — chosen specifically for association-graph traversals REST does badly (artist → bookings → settlements in one query). Mutations intentionally thin; **REST is the write path of record.**
- **MCP**: Streamable HTTP at `/mcp`, `sessionIdGenerator: undefined` for scale-out, Postgres `EventStore` for stream resumability; tools from the registry with zod→JSON Schema and `structuredContent` + text dual output; CRM records as **resources** under `crm://` templates with per-variable completions; booking playbooks as **prompts**; `initialize` `instructions` shipping the domain operating manual; capability-conditional registration (elicitation-requiring tools advertised only to clients that negotiated elicitation); long ops as pollable tasks with mid-task elicitation; **dynamic per-session tool enable/disable driven by the principal's scopes** with `listChanged`.
- **A2A**: `/.well-known/agent-card.json` advertising skills `contact-search`, `booking-hold`, `deal-update`, `settlement-status`; task lifecycle over the same job tables; structured outputs as `DataPart` with embedded JSON schema.
- **Discovery for agent self-onboarding**: `/.well-known/{agent-card.json, mcp/server.json, openapi.json}`, `AGENTS.md`, `SKILL.md`, `llms.txt`, `llms-full.txt`, a live `/v1/discovery/check`, and `blk setup add <host>` writing MCP config into Claude Desktop/Cursor/etc. with per-host quirks.

### 5.6 Integrations

The onyx connector capability interfaces translated to TS: `{FullSync, IncrementalSync (checkpointed async generator yielding Record | ConnectorFailure), SlimIdSync, OAuthFlow, WriteBack}`. Per-record failures never abort a run; every run produces an `EnrichmentMetrics`-style rollup rendered identically in UI and API. All writes **into** Backline go through `crm_batch_upsert` keyed on external natural IDs (`sf:{18charId}`, `hs:{objectId}`, `mon:{itemId}`); all writes **out** go through the outbox with per-target idempotency keys; field mapping is introspection-driven on both sides. Conflict policy is **last-writer-wins per field with provenance recording both sides**, and `hand_curated` fields are never overwritten by sync. A per-connector "sync inspector" page shows checkpoint, lag, per-run metrics, and dead-lettered items with replay buttons. **Connector registry entries live in the same table as agent registry entries (`category: integration`), sharing install/health/version-reconnect machinery.**

### 5.7 Accessibility

WCAG 2.2 AA as a CI-enforced budget, treated as net-new — the research found **zero reusable a11y code in any of the 16 repos** (GPUI has no ARIA analog; onyx and monday ship none). React Aria Components exclusively for interactive primitives. **Schema-driven forms are the a11y multiplier**: elicitation JSON Schemas and `property_def` metadata both render through *one* accessible form generator, so agent-initiated dialogs are exactly as accessible as hand-built ones. Mobile reliability is treated as an a11y concern: MCP/SSE resumability via the Postgres `EventStore` + `Last-Event-ID` means a tour manager on venue wifi does not lose an in-flight agent job. Testing: axe-core in Playwright on every page state including open dialogs and pending-approval cards, plus manual VoiceOver/TalkBack passes on the four money flows (hold placement, approval, settlement review, registry install) each release.

### 5.8 Tradeoffs

1. **Bun lock-in** (`Bun.serve`, native WS, `Bun.cron`) with real Node-compat gaps; mitigated by Hono and adapter seams, but a forced migration costs weeks.
2. **Postgres-as-everything** (queue, event store, MCP `EventStore`, pub/sub) is the sweet spot to roughly tens of events/sec and a few hundred concurrent agent sessions — comfortably inside a booking agency — but it is not a horizontal event platform. The outbox seam is where you would retrofit NATS/Redis.
3. **Dual REST + GraphQL doubles the projection surface.** Capped by making GraphQL read-mostly and generating both from the registry, but schema drift is a standing tax. If you lack graph-shaped read needs, delete GraphQL.
4. **Protocol churn**: MCP tasks are experimental (SEP-1686), A2A libraries are young, Zed's own ACP code is full of version workarounds. Every protocol sits behind a versioned adapter and protocol types never reach `services/` — costing an indirection layer and deliberately lagging spec features.
5. **The generic property-bag model** buys runtime flexibility at the cost of weaker DB-level integrity for custom fields. First-class music entities get real constraints; custom ones get app-level validation.
6. **Two-phase confirmation and never-auto-EGRESS make agents slower and chattier by design.** That is the point, but it is a product stance, not a free lunch.
7. **Journal-pull as the primary change feed** pushes effort onto consumers expecting push webhooks.
8. **No native mobile app, no offline writes** — a responsive PWA with stale-read cache only.
9. **Building our own Salesforce client** instead of jsforce trades ecosystem breadth for a small audited surface.
10. **GPL discipline**: Zed is GPL-3.0. Everything taken here is pattern-level porting, and that boundary must be actively policed in code review. **Never paste Zed code.**

### 5.9 Roadmap

| Phase | Weeks | Exit criterion |
|---|---|---|
| 0 Skeleton + contracts | 1–3 | Headless CRUD + search + journal usable via `curl` |
| 1 Music domain | 4–7 | An agency can run holds → settlement headlessly |
| 2 MCP head + web core | 8–11 | Claude/Cursor operate the CRM end-to-end; humans see the same data live over WebSocket |
| 3 Agent registry + threads | 12–15 | External agents installable, governable, debuggable |
| 4 Sync connectors | 16–19 | Bidirectional field-mapped sync with replayable dead letters |
| 5 Documents + A2A + polish | 20–23 | Markdown preview with source-offset sync, `crm://` mentions, A2A tasks, GraphQL read head, PDF export, VoiceOver/TalkBack passes, load tests documenting the Postgres-only ceiling |

Continuous: every new operation lands as a registry entry first (schemas + annotations + scope); heads pick it up mechanically; weekly registry-hygiene and a11y budgets in CI.

---
<!-- SECTION-C-PLACEHOLDER -->

## 8. Appendix — reusable pattern index

The concrete inventory every solution draws on. Each row is *pattern → where it lives → why it matters for an agentic CRM*.

### 8.1 zed — the two UX ports

| Pattern | Where | Why |
|---|---|---|
| Settings-file-as-install-database; a settings observer diffs old vs new and re-registers launchers | `agent_ui/src/agent_registry_ui.rs:491-566`, `project/src/agent_server_store.rs:294-489,1524-1571` | Registry entries become declarative config — diffable, auditable, hot-reloadable, no separate install DB |
| Two-source install status (registry-installed / custom-installed / not-installed) | `agent_registry_ui.rs:32-37,146-167`, `agent_servers/src/custom.rs:305-322` | Distinguishes curated marketplace agents from user-defined ones in one list |
| Registry index fetch robustness: 30s timeout, 1h `refresh_if_stale`, raw-body disk cache, per-icon graceful failure | `project/src/agent_registry_store.rs:204-326` | A registry panel must render offline and never block on a CDN |
| `AgentConnection` trait with capability-probing optional methods | `acp_thread/src/connection.rs:91-266` | The exact shape of an agent-first headless API; the panel renders features per agent, not per vendor |
| `AcpThreadEvent` vocabulary (`NewEntry`, `EntryUpdated(ix)`, `ToolAuthorizationRequested`, `TokenUsageUpdated`, `Stopped`) | `acp_thread/src/acp_thread.rs:2144` | A typed, versionable WebSocket event protocol for the agent panel |
| `ToolCallStatus::WaitingForConfirmation{options, respond_tx}` + `authorize_tool_call` mapping Allow/Reject × Once/Always | `acp_thread.rs:3372,3425` | The approval state machine — but the oneshot must become a row on the web |
| `StreamingTextBuffer`: buffer unrevealed chunks, drain on 16ms timer to ~200ms full reveal | `acp_thread.rs:2108-2132` | Streaming that reads smoothly instead of stuttering per token |
| Per-entry view state split from thread entries | `agent_ui/src/entry_view_state.rs` | What keeps 500-entry threads fast |
| Connection store: `Connecting(shared task)` / `Connected` / `Error` + version-change reconnect handshake | `agent_ui/src/agent_connection_store.rs`, `agent_server_store.rs:337-472` | Concurrent requesters await one promise; version bumps surface as "restart to update" |
| Protocol inspector: every JSON-RPC line in/out with request-id→method correlation | `acp_tools/src/acp_tools.rs`, `agent_servers/src/acp.rs` debug tap | Makes agent misbehavior diagnosable by admins |
| `MentionUri` typed URI scheme embedded as ordinary markdown links | `acp_thread/src/mention.rs:20-460` | Entity references survive serialization and are agent-parseable |
| Markdown preview: 200ms debounced low-priority reparse, drop if queued; high-priority document switch skips debounce | `markdown_preview/src/markdown_preview_view.rs:48,508-580` | Keeps typing at 60fps on long contracts |
| Bidirectional source-offset sync: selection→block highlight, click→editor selection, checkbox→exact byte-range edit | `markdown_preview_view.rs:410-1018` | The whole preview UX; requires a position-preserving parser |
| Follow mode with canonical-editor fallback + persisted mode/font-size | `markdown_preview_view.rs:65-98,348-505` | One preview panel that tracks the active document |

### 8.2 hubspot-sdk-typescript — CRM modeling

| Pattern | Where | Why |
|---|---|---|
| `SimplePublicObject` property-bag record with `objectWriteTraceId` | `src/resources/crm/crm.ts:850-896` | One storage/CRUD/search engine serves every object type; trace ID is a ready-made agent-write hook |
| Runtime-definable `ObjectSchema` with labels, required/searchable properties, primary display | `crm/object-schemas/object-schemas.ts:118-260` | Declare Release/Venue/Tour at runtime; drives API validation and UI rendering from one schema |
| Rich property metadata incl. `hasUniqueValue`, `dataSensitivity`, `modificationMetadata` | `shared.ts:813-1055` | ISRC as unique; `readOnlyValue` gates what agents may write |
| Typed labeled association graph with `SYSTEM｜USER｜INTEGRATOR` category | `shared.ts:81-136`, `crm/associations/` | Bookings are a graph; the category separates system from integrator edges |
| Pipelines with per-stage `writePermissions` and stage audit endpoints | `crm/pipelines.ts:206-374,9-192` | Stops an agent auto-advancing a contracted booking |
| Closed search DSL (`filterGroups` OR-of-AND, 14 operators, cursor `after`) | `crm/crm.ts:618-679` | One query algebra an LLM fills reliably; compiles to SQL |
| Cursor pagination as async iterable | `src/core/pagination.ts:13-169` | Stateless cursors survive concurrent writes; agents stream collections in three lines |
| Batch upsert by `idProperty` with error-partitioned responses | `crm/objects/contacts/batch.ts`, `shared.ts:236-314` | Sync engines need per-item errors, not all-or-nothing |
| Generic objectType-parameterized endpoints alongside typed twins | `crm/objects/generic-objects/generic-objects.ts:23-117` | One code path for runtime-created types + ergonomic typed wrappers |
| Tree-shakable capability registry (`static _key` + `createClient` mounting) | `src/tree-shakable.ts:29-103` | Bundle only what's used; also a proven registry pattern |
| Resilient HTTP core (server `x-should-retry`, `Retry-After`, jittered backoff, typed error ladder) | `src/client.ts:348-640` | Reference implementation for both the sync worker and what the CRM's own API should emit |
| Offset-cursored webhooks journal with action enums + snapshots | `webhooks-journal/journal/journal.ts:19-90` | Replayable ordered ingestion; no lost webhooks |
| Per-value provenance `ValueWithTimestamp{sourceType, sourceId}` with an AI source category | `crm/crm.ts:890-931`, `shared.ts:1066-1119` | Answers "which agent changed this field, when" |
| Injection-hardened path tagged template (percent-encode, reject `..`/`%2e%2e`) | `src/internal/utils/path.ts` | Path segments will come from LLM output |
| Record lifecycle: soft delete + restore window, merge, `gdprDelete`, `idProperty` alternate keys | `crm/objects/contacts/contacts.ts:38-105` | Battle-tested CRM semantics incl. natural-key addressing for sync |

### 8.3 simple-salesforce — schema, sync, and money

| Pattern | Where | Why |
|---|---|---|
| Dynamic entity proxy — any object name becomes a working client | `api.py:345-387` | The API surface should be object-name-parameterized; one generic MCP `crud(object, op, data)` tool instead of N |
| Describe-driven schema introspection (global, per-object, layout) | `api.py:310-328,965-1017` | Schema is a runtime API resource — agents discover fields, UIs render forms generically, connectors map by introspection |
| Schema-as-data Metadata API (CustomObject/CustomField are CRUD-able) | `metadata.py:19-193` | Runtime-definable custom objects for per-agency deal terms and territory splits |
| External-ID upsert `PATCH /{object}/{extIdField}/{value}` + safe formatting | `api.py:1039-1118`, `format.py:76-78` | Idempotent sync keyed on ISRC/ISWC/external IDs |
| Injection-safe SOQL templating with type-aware quoting | `format.py:25-73` | Agents will generate queries from natural language |
| `updated(start,end)` / `deleted(start,end)` delta windows | `api.py:1180-1232` | Both consume these *and* expose equivalents so others can delta-sync without webhooks |
| Transparent 401 re-login as a stored closure, bounded retry | `api.py:122-153,300-308,743-795` | Headless agents hold long-lived connections; refresh must be invisible |
| API budget surfaced as typed data from `Sforce-Limit-Info` | `api.py:791-832` | Agents making autonomous bursts need visible quota to self-throttle |
| Typed exception taxonomy mapped from HTTP status | `util.py:70-89`, `exceptions.py:5-149` | Lets agents branch retry vs re-auth vs conflict instead of parsing strings |
| Bulk 2.0 job lifecycle with failed/successful/unprocessed record splits | `bulk2.py:420-514,1315-1400` | Catalog imports need partial-failure semantics, not transactions |
| Payload-limit-aware auto-batching (records **and** serialized bytes) | `bulk.py:363-428`, `bulk2.py:131-220` | Chunk against the target API's documented limits, encoded as constants beside the splitter |
| Injectable `parse_float` / `object_pairs_hook` at the deserialization boundary | `api.py:59-61,275-276` | **Settlements cannot tolerate float drift** |
| Documented raw passthrough escape hatches (`restful`, `apexecute`) | `api.py:426-489,679-741` | No client covers every endpoint; keep the connector usable without a library release |

### 8.4 monday-sdk-js — panels, views, host bridge

| Pattern | Where | Why |
|---|---|---|
| Environment-split single package (browser session auth vs headless explicit token, identical `api()` signature) | `src/index.js`, `src/helpers/index.js:5` | Maps exactly to "web app **and** headless agent API" — one client contract |
| Seamless-auth fallback: no token → delegate to trusted host frame, credentials never touch the app | `src/client.js:65-83`, `client-data.interface.ts:87-97` | Blueprint for embedding agent-authored panels; `sessionToken` JWT hands a verifiable short-lived identity to the backend |
| `postMessage` RPC with requestId correlation and multi-key listener demultiplexing | `src/client.js:202-251` | ~60 lines of promise RPC + pub-sub for hosting external agent panels — **with origins pinned, unlike the source** |
| Typed per-surface context injection (`get("context", {appFeatureType})` + mapped-type registry) | `types/client-context.type.ts:71,258` | Each mount point (artist detail, pipeline, settlement) declares a typed context payload agents receive on load |
| Discriminated `execute(type, params)` command bus with per-command overloads and an `any` escape hatch | `types/client-execute.interface.ts:15,22-315` | One verb registry serving both UI plugins and agents; new capabilities ship before types do |
| Board/item/flexible-column model with a rule-AST filter (`{column_id, operator, compare_value}`) | `client-data.interface.ts:8-27`, `client-context.type.ts:83-152` | Views become serializable filter+settings over the same items — also the cleanest monday sync target |
| Host-provided scoped KV with two segments and `previous_version` CAS | `src/client.js:35-44,178-200` | Agent/plugin state without giving extensions DB access |
| GraphQL `extensions.warnings` surfaced as structured warnings | `helpers/monday-api-helpers.js` | Cheap API-evolution channel humans and agents both see |
| Theme token contract (`theme` + `themeConfig` per system theme) | `types/theme-config.type.ts` | Pass tokens, not stylesheets — WCAG light/dark for embedded panels |

### 8.5 mcp-typescript-sdk + mcp-servers — the agent surface standard

| Pattern | Where | Why |
|---|---|---|
| `registerTool`/`registerResource`/`registerPrompt` with zod — one call yields advertisement, validation, error wrapping | sdk `src/server/mcp.ts:911,616,1001` | Zod schemas double as the REST validation layer |
| Dynamic tool registry with `enable()`/`disable()` auto-emitting `list_changed` | sdk `mcp.ts:669-745` | Settlement/contract-send tools appear only after auth upgrade — per-principal capability scoping |
| `ResourceTemplate` + RFC 6570 with per-variable completion callbacks | sdk `src/shared/uriTemplate.ts`, `mcp.ts:532-616` | `crm://artists/{id}/bookings/{id}` is a stable namespace; completions power agent *and* human autocomplete |
| Streamable HTTP stateful vs stateless by `sessionIdGenerator`; multi-node taxonomy | sdk `src/server/streamableHttp.ts:34-123`, `src/examples/README.md` | Persistent-storage mode = any node serves any agent session |
| `EventStore` resumability + client resumption tokens with backoff | sdk `streamableHttp.ts:17-29`, `src/client/streamableHttp.ts:6-75` | Long agent jobs survive mobile network drops — a reliability *and* accessibility requirement |
| `outputSchema` + `structuredContent` with client-side validation | sdk `mcp.ts:127-132`, `src/client/index.ts:429-498` | Agents get typed records, not prose — the contract that makes them API clients |
| Elicitation: server-initiated JSON-schema forms with accept/decline/cancel; URL mode with retry-dedup | sdk `src/server/index.ts:313-343`; servers `everything/tools/trigger-elicitation-request.ts`, `trigger-url-elicitation.ts:128` | In-band human confirmation; the form vocabulary renders accessibly on mobile |
| Four-hint `ToolAnnotations` matrix applied consistently, with a README rationale table | servers `filesystem/index.ts:220-712`, `filesystem/README.md:182-210` | Drives confirm-before-execute policy from metadata instead of hardcoded lists |
| Batch-first idempotent mutations that skip duplicates and return only the delta | servers `memory/index.ts:120-153` | Agents emit batches; duplicate-skipping makes retries safe |
| Live resource mirror: mutations call `notifyGraphUpdated()`, pushed only to subscribed sessions | servers `memory/index.ts:262-274,547-586` | Real-time panels that stay in sync when agents mutate records |
| Tasks (SEP-1686): `working → input_required → completed` with mid-task elicitation | servers `everything/tools/simulate-research-query.ts` | Long CRM jobs pause for human clarification instead of blocking a tool call |
| Capability-conditional registration after `oninitialized` | servers `everything/tools/index.ts:26-55` | Advertise confirmation-requiring tools only to clients that can render confirmations |
| Roots as runtime-mutable scope with normalize-then-prefix validation | servers `filesystem/index.ts:723-770`, `path-validation.ts` | Template for binding an agent session to a roster subset, re-validated per call |
| Server `instructions` shipped as versioned markdown in `initialize` | servers `everything/docs/instructions.md` | Every connecting agent gets the domain operating manual without per-client prompt engineering |
| Defensive coercion of LLM args (`"false"` → false, `z.coerce.number`, leading-dash rejection) | servers `sequentialthinking/index.ts:8-16`, `git/server.py:273-279` | Real failure modes for any tool that filters or shells out |
| Self-describing truncation cursor in output ("call again with `start_index` of N") | servers `fetch/server.py:151-255` | Teaches agents to paginate long activity feeds without client special-casing |
| OAuth 2.1 resource+authorization kit with `AuthInfo` in every tool handler | sdk `src/server/auth/` | Per-scope tool access delegating to the agency IdP |

### 8.6 pydantic-ai + lumen + spec-kit — agent runtime and governance

| Pattern | Where | Why |
|---|---|---|
| `Agent[Deps, Output]` with `RunContext` DI carrying run_id, retries, usage | pydantic-ai `_run_context.py`, `agent/abstract.py` | The abstraction to mirror in TS — deps (db handle, tenant, principal) flow into every tool; `RunContext` fields *are* the audit fields |
| Composable toolset wrappers `.filtered().prefixed().approval_required()` | pydantic-ai `toolsets/abstract.py:192-279` | Per-role filtering, per-integration namespacing, approval gates — without touching tool implementations |
| **Deferred tools**: run ends with typed `DeferredToolRequests`, resumes with `DeferredToolResults` (`ToolApproved` with `override_args` / `ToolDenied`) | pydantic-ai `tools.py:256-421`, `toolsets/external.py` | The correct pause/resume shape for "agent wants to email the promoter — approve?" |
| Declarative `AgentSpec` (YAML/JSON) with capability registry and generated JSON schema | pydantic-ai `agent/spec.py` | Agents as data — directly the Agent Registry's record shape |
| One native event stream + thin per-protocol UI adapters | pydantic-ai `ui/_adapter.py`, `ui/_event_stream.py` | One agent run feeds web panel, mobile, and headless consumers without touching the runtime |
| Client-input trust model (strip client system prompts, drop dangling tool calls, whitelist file-URL schemes) | pydantic-ai `ui/_adapter.py:148,169,191` | Chat endpoints where the client resends history are an injection surface — replicate verbatim |
| Mode × scope permission matrix with a **never-ALLOW-egress invariant**, fail-closed, defensively asserted | lumen `scrum/permissions.ts` | Agents draft freely; sending a contract is human-gated in every mode with no bypass flag |
| Single validating write seam where validators **block but never mutate**; typed outcomes `written｜denied｜awaiting_approval｜rejected` | lumen `scrum/filesystem-tool.ts` | What the agent proposed is byte-for-byte what lands — the property that makes agent writes reviewable |
| Record-before-act append-only ledger; DB trigger physically rejects UPDATE/DELETE; crashed sessions resume from the ledger | lumen `scrum/chainz.ts`, `state/schema.sql` | Replayable causality for settlements and crash-safe long workflows |
| Typed signal envelope with a closed `kind` catalog and per-kind payload schemas | lumen `agents/docs/CEREMONIES.md §B` | Workflow handoffs (prospecting → booking → contract → settlement) as typed edges, never prose-scraping |
| Pure-function dispatcher with loop guard, WIP limit, single-writer-per-resource contention | lumen `scrum/dispatcher.ts` | Stops two agents mutating the same booking, and escalates to human as a first-class terminal outcome |
| Brief compiler: cheap local assembly of a self-contained brief before spending on the expensive model | lumen `scrum/brief-compiler.ts` | Assemble catalog + deal history + prior settlements locally before an LLM drafts an offer |
| Cost-aware triage with hard budget caps returning `degraded: true` instead of silently overspending | lumen `scrum/triage.ts`, `routing_policy.ts` | Visible degradation beats invisible spend |
| Exec/egress choke point with segment-wise classification and secret-stripped child env | lumen `scrum/exec-guard.ts` | Closes the prompt-injection → credential-exfiltration path when agent inputs include promoter emails |
| Per-role MCP tool RBAC, unknown roles get nothing | lumen `mcp/rbac.ts` | A prospecting agent and a settlement agent must not see the same tools |
| No-self-approval: authorship, judgment, and routing separated; refuses to fabricate approval from prose | lumen `scrum/agents.ts:386-427` | For actions with money attached, the tripartite separation is what makes pipelines non-self-dealing |
| Declarative lifecycle hook bus (`before_<event>` / `after_<event>`, optional vs mandatory) | spec-kit `extensions/EXTENSION-API-REFERENCE.md` | Pipeline-stage hooks (`before_contract_send` → compliance check) where extensions plug in without modifying core |
| Resumable YAML workflows with human review gates, fan-out, and per-step persisted run state | spec-kit `workflows/ARCHITECTURE.md` | Exactly the shape of prospect → hold → offer → contract → settlement |
| Constitution as a machine-checked gate with a complexity-justification table | spec-kit `templates/plan-template.md` | Encodes agency business rules (no double-booking, hold etiquette, approval thresholds) as checkable invariants |
| Bounded clarification: max 3 questions, A/B/C/Custom, answers recorded as structured data | spec-kit `templates/commands/specify.md` | An agent parsing an ambiguous booking brief asks few, structured questions |
| Curated vs community catalog split with `install_allowed` and org override URL | spec-kit `extensions/README.md` | The governance model for an agent marketplace: admins curate what appears in the registry panel |

### 8.7 onyx + bun + ollama + raptor + notebooklm + agoragentic — platform

| Pattern | Where | Why |
|---|---|---|
| Connector capability interfaces with checkpointed generators yielding `Document \| ConnectorFailure` | onyx `connectors/interfaces.py`, `models.py:497,521` | Resumable incremental sync, per-record failure capture, ID-only prune passes |
| MCP server registry **persisted in DB** with per-server transport/auth/auth-performer and user/group ACLs | onyx `db/models.py:4930-5060`, `web/src/sections/actions/MCPActionCard.tsx` | The Agent Registry as a database schema plus a working admin panel |
| Dual MCP posture: platform is both server and client, with Host-header denylist SSRF guard | onyx `mcp_server/`, `tools/tool_implementations/mcp/mcp_ssrf.py` | Expose CRM ops to agents while consuming external MCP servers — with auth reuse, not a second auth system |
| Uniform Tool ABC + `NullEmitter` so one implementation serves chat, API, and MCP | onyx `tools/interface.py`, `chat/emitter.py` | `override_kwargs` cleanly separates trusted server args from LLM-supplied args |
| Single error type with stable machine-readable codes → one global handler | onyx `error_handling/` | Agents branch on codes; trivially portable to a TS discriminated union |
| LLM tracing that auto-wraps every subclass and emits `UNTAGGED_*` sentinels for missed instrumentation | onyx `tracing/flows.py`, `llm/tracing_wrap.py` | 100% agent-call audit coverage *by construction* |
| Access sets computed centrally and stamped into the index; `ExternalAccess.empty()` fail-closed | onyx `access/` | Row-level permissions enforced in search/RAG, not just at the API layer |
| Tenant contextvar + schema-per-tenant + tenant-aware workers | onyx `shared_configs/contextvars.py`, `db/engine/sql_engine.py:443` | Lighter than database-per-tenant if the CRM serves agency groups |
| Consolidated single-process background app for small deployments | onyx `background/README.md` | Same queue topology at appliance weight |
| Runtime plugin dispatch resolving optional heavyweight modules by module path | onyx `utils/variable_functionality.py` | Ship a lightweight core with optional perm-sync/analytics without forking code paths |
| Prefixed API keys with tenant routing inside the key, sha256 storage, displayable truncation | onyx `auth/api_key.py` | The agent-credential story |
| Proactive sliding-window rate limiters per connector (incl. real HubSpot/Salesforce ones) | onyx `connectors/cross_connector_utils/rate_limit_wrapper.py`, `connectors/hubspot/rate_limit.py` | Reactive-only 429 retry is the documented gap in both vendor SDKs |
| Typed `Bun.serve({routes})` with inferred params; fullstack HTML imports; `bun:sqlite`; native WS topic pub/sub; `Bun.cron`; `Bun.s3`; `bun build --compile` | bun `docs/runtime/*`, `docs/bundler/fullstack.mdx` | One process, one binary, no Redis/socket.io/queue for the appliance tier |
| `Bun.SQL` unified client (SQLite → Postgres without rewriting data access) | bun `docs/runtime/sql.mdx` | The graduation path from Solution A to B |
| Declarative integration registry with install detection and per-entry status | ollama `cmd/launch/registry.go` | A second reference for the registry panel: Installed / AutoInstallable / Usable per entry |
| Tool-execution approval with session allowlist (deny / once / always) + safe auto-allow list | ollama `x/agent/approval.go` | The same human-in-the-loop model the CRM needs for deals and settlements |
| Protocol-adapter middleware: one internal handler, N wire dialects, adapters carry no business logic | ollama `middleware/openai.go`, `middleware/anthropic.go` | Exactly how to host MCP + A2A + Salesforce + HubSpot + monday |
| Capability enumeration with typed "does not support tools" errors | ollama `types/model/capability.go`, `server/images.go` | Never assume model parity; degrade gracefully |
| Stale-while-revalidate registry caches with single-flight | ollama `server/model_recommendations.go` | Keeps registry metadata fresh without blocking requests |
| Streaming markdown with memoized shiki code blocks and sanitized rehype pipeline | ollama `app/ui/app/src/components/StreamingMarkdownContent.tsx` | The Markdown Preview UX solved for the streaming-agent case |
| Collapsed-tree retrieval: rank leaves **and** summaries in one token-budgeted pool | raptor `tree_retriever.py:158-195` | Agent context that automatically mixes abstraction levels — summaries for "our history with this promoter", leaves for a contract clause |
| Layer provenance returned with results | raptor `tree_retriever.py:313-326` | Citations: "this came from a layer-2 summary, not the raw email" |
| Soft clustering with recursive re-split on token overflow | raptor `cluster_utils.py:60-66,162-183` | One email covering a hold *and* a release date appears under both summaries |
| One services layer, N thin heads; heads must not import core | notebooklm `services/` vs `mcp/tools/` vs `cli/commands/`, `CLAUDE.md` | The layering rule all three solutions adopt |
| Two-phase confirmation returning a `pending_confirmation` payload echoing exact settings | notebooklm `mcp/tools/studio.py:148-190` | Machine-enforced approval that doubles as an idempotent dry-run |
| `ServiceError{message, user_message, hint, debug_code}` where `NotFoundError` generates the next command | notebooklm `services/errors.py` | Agents recover dramatically better when errors carry a machine-readable next action |
| Idempotency-aware retry taxonomy: retry connect-phase failures; **never** retry read/write timeouts on mutating calls | notebooklm `core/retry.py:33-41` | Duplicate-write prevention for CRM sync |
| Upstream-drift detection raising an actionable error + env hot-patch overrides | notebooklm `core/base.py:69-88,421-436` | Vendor APIs drift silently; fail loudly with remediation beats silent nulls |
| `coerce_list()` cataloging how real MCP clients mangle params | notebooklm `mcp/tools/_utils.py:245-277` | Tools fail unpredictably without a tolerant deserialization layer |
| TTY-aware output negotiation (auto-JSON when stdout isn't a TTY) | notebooklm `cli/formatters.py:29-56` | One CLI that is human-friendly and agent-friendly with no flags |
| Secure-by-default network posture: HTTP transport refuses non-loopback bind without explicit opt-out | notebooklm `mcp/server.py:240-258` | Explicit-consent gate for network exposure |
| CI-enforced registry index (path existence, ID prefix regex, duplicate keys, docs presence) | agoragentic `integrations.json` + `scripts/verify-integrations-json.js` | Registry hygiene as a build gate |
| ACP manifest entry shape (runtime, auth with `how_to_get`, capabilities, recommended tools) | agoragentic `acp/agent.json` | The registry record schema, adoptable verbatim |
| A2A card with skills, endpoints map, bearer descriptor, capability flags | agoragentic `a2a/agent-card.json` | The CRM's outward-facing agent identity |
| Canonical tool-ID contract mirrored across every adapter, CI-verified | agoragentic `AGENTS.md`, `verify-integrations-json.js` | One `crm_*` table; surfaces never drift |
| Backend-event → UI-hint table (`approval_required→modal`, `receipt_ready→artifact card`) | agoragentic `ag-ui/agoragentic_ag_ui.ts` | Visualize agent runs without coupling UI to any agent framework |
| Governance policy packet (tool / budget / approval / context / memory policies) | agoragentic `harness-core/schema/agent-os-harness.v1.json` | Per-agent allowed tools, spend caps, and human-approval gates |
| Quote → procurement check → approval queue → execute → **receipt** with typed error codes | agoragentic `specs/ACP-SPEC.md` | Structurally identical to hold → contract → settlement; reuse the receipt envelope for every agent mutation |
| Live protocol handshake verification in CI (spawn, initialize, assert capabilities) | agoragentic `scripts/verify-acp.js` | Smoke-test registered agents before marking them healthy |
| Layered LLM-discovery doc stack (`AGENTS.md`, `SKILL.md`, `llms.txt`, `llms-full.txt`, `/.well-known/*`, self-test endpoint) | agoragentic `README.md` Discovery Surfaces | Agents discover, learn, and self-register with no human |
| Enrichment lifecycle `NOT_PROCESSED → SUCCESS/FAIL/SKIPPED`, `allSettled` fan-out, pre-flight skip validation, metrics rollup, `skipUplift` consent gate | metadata-enrichment `c14991b:src/enrichment/` | The per-record job shape for MusicBrainz enrichment, incl. the `hand_curated` opt-out |

---
