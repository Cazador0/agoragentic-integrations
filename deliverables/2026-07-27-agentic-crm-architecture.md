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

All three share the same domain model, the same Zed UX ports, and the same canonical `crm_*` operation contract.

**The recommendation in §7.4 is none of them unmodified.** An adversarial review found each fails the brief in a specific, nameable way — A's synchronous SQLite on a shared event loop and unsandboxed agent spawning, B's generic write head that silently voids its own invariants, C's Keycloak-in-the-"lite"-profile and week-22 time-to-value. The recommended build is **B's contract mechanism + C's domain and safety model + A's deployment discipline**, on Node rather than Bun, with `tenant_id` + Postgres RLS rather than schema-per-tenant, and with **email, calendar, and data migration re-sequenced ahead of the agent platform** — because that ordering is how CRM rollouts die.

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

## 6. Solution C — **Backline Arena** (enterprise modular platform)

> A booking agency's CRM is three systems wearing one coat: a **graph**, a **ledger**, and an **agent host**. Solution C optimizes for the last two never being bolted on later.

### 6.1 Philosophy — five commitments

1. **One domain core, many heads.** All business logic in `packages/services/*` returning typed DTOs; the Next.js UI, REST API, MCP server, A2A worker, and CLI are thin wrappers handling presentation and transport only. The notebooklm layering rule and onyx's Tool-ABC-with-`NullEmitter` pattern promoted to an architectural law **enforced by an ESLint boundary rule**. *A feature that cannot be driven headlessly does not ship.*
2. **Agents are principals, not features.** Every agent — internal or external, MCP or ACP or A2A — has an identity, a scope, a tool allowlist, a budget, and an audit trail. Every field an agent writes is stamped with `source`, `agentRunId`, `model`, `confidence`. *"Which agent changed this settlement line and on whose approval" is a first-class query, not a log grep.*
3. **Human gates are persisted records, not in-memory channels.** Zed's `oneshot` inside `ToolCallStatus::WaitingForConfirmation{respond_tx}` cannot survive a web request boundary. Backline persists a `pending_approval` row, blocks the agent's JSON-RPC request on Postgres `LISTEN/NOTIFY` + timeout, and resolves it when a human clicks.
4. **Flexible schema, typed edges, hard money.** Property-bag records with a runtime property-metadata layer so an agency adds "Territory Split %" without a migration — but bookings, contracts, and settlements get hard relational columns, exclusion constraints, and `NUMERIC` money. Money never touches a float.
5. **Retrieval is hierarchical because relationships are.** A RAPTOR-style tree (leaf = one email/note/settlement line; layer 1 = per-thread/per-show; layer 2 = per-tour/per-release; root = per-relationship) is the only way an agent answers "what's our history with this promoter" inside a context window while still drilling to the exact contract clause. Layer provenance rides on every retrieval result so the UI renders an evidence ladder.

**Honest positioning:** this is what you build when the customer is an agency *group* — multiple rosters, a label arm, sub-agents in three territories, a finance team, and SOC 2 questions from a major. It is over-engineered for a two-person boutique.

### 6.2 Stack

**Node 22 LTS, not Bun** — the worker fleet needs mature `undici`/OTel/Temporal-class ecosystem support and long-horizon LTS, and Bun's Node-compat gaps on streaming client request bodies and `node:cluster` FD passing are exactly the surfaces a sync worker hits. TypeScript 5.7 strict, pnpm 9 workspaces + Turborepo.

**Packages:** `@backline/domain` (entities, zod schemas, invariants — zero I/O), `db` (Drizzle + migrations + scope helpers), `services` (all business logic; the only layer allowed to touch `db`), `agents` (runtime, registry, connections, ACP/MCP clients), `connectors`, `rag`, `api` (Fastify), `worker` (BullMQ), `web` (Next.js 15), `ui`, `sdk`, `cli` (`bl`).

| Layer | Choice | Rationale |
|---|---|---|
| API server | **Fastify 5** | Not NestJS (DI decorators cost bundle/startup for little gain); not Next route handlers (the API must run without the UI) |
| Contract | zod 3 → `@asteasolutions/zod-to-openapi` → OpenAPI 3.1 → `openapi-typescript`/`openapi-fetch` | The *same* zod schemas become MCP `inputSchema`/`outputSchema` and A2A skill schemas — one schema, four surfaces |
| Database | **PostgreSQL 17** + `pgvector` (HNSW), `btree_gist`, `pg_trgm`, `pgcrypto`; Drizzle | **No Vespa, no OpenSearch** — an agency corpus is millions of rows, not billions; Postgres FTS + pgvector + a reranker covers hybrid search |
| Queue | **BullMQ 5 on Redis 7** | Six named queues mirroring onyx's worker fleet: `sync`, `index`, `agent`, `notify`, `finance`, `beat`; a `--all-queues` consolidated process exists for small deployments |
| Identity | **Keycloak 26** (OIDC + SAML + SCIM) | "A major label wants SSO" is not optional at this tier; Backline is an OAuth 2.1 resource server |
| LLM | Vercel AI SDK 5 wrapped by `@backline/agents/llm` | Adds a **model-profile capability registry** (pydantic-ai's anti-if-ladder split), an **LLMFlow tag registry** emitting `UNTAGGED_*` spans for missed instrumentation (onyx), and per-tenant/agent/run cost accounting. Ollama is a first-class provider for on-prem |
| Agent protocols | `@modelcontextprotocol/sdk`, `agent-client-protocol`, `@a2a-js/sdk` | All three normalize into one internal `AgentSession` event stream |
| RAG | `@backline/rag` | Sentence-boundary token-budget chunking (RAPTOR port), pgvector HNSW, **TS-native recursive agglomerative clustering with soft multi-membership** replacing UMAP+GMM+BIC — a deliberate simplification (see tradeoffs) |
| Observability | OTel → Tempo/Loki/Mimir, Langfuse for LLM runs, `pino` with a scrubber registry every secret registers into | 100% agent-call trace coverage by construction |
| Frontend | Next.js 15 App Router (RSC record pages, client agent panels), Radix + Tailwind 4 tokens + CVA, `cmdk`, TanStack Query/Virtual, `react-aria` surgically | Storybook 9 with `addon-a11y` |
| Markdown | `remark-parse → gfm → math → directive → crm-mention → rehype-sanitize → katex → shiki` | **mdast `position` offsets are load-bearing** — the direct replacement for pulldown-cmark's source ranges |
| Testing | Vitest, Testcontainers, Playwright + `@axe-core/playwright`, `msw` | a11y assertions on every page object |
| Deploy | Docker Compose (`lite`/`standard` profiles) + Helm | Migrations gated in CI |

### 6.3 Architecture — modular monolith + worker fleet + protocol edge

```
          ┌──────────────────── protocol edge (Fastify) ─────────────────────┐
browser  ─┤ /api/v1/*   REST + OpenAPI 3.1                                   │
mobile   ─┤ /mcp        MCP Streamable HTTP (stateless + Postgres EventStore)│
MCP hosts─┤ /a2a        A2A JSON-RPC + /.well-known/agent-card.json          │
A2A      ─┤ /acp        ACP over WebSocket (browser agent clients)           │
ACP      ─┤ /events     SSE (thread + registry + record change streams)      │
webhooks ─┤ /hooks/:connector  (signature-verified)                          │
          └───────────────────────────┬─────────────────────────────────────┘
                                      │ every request → RequestContext
                                      │ {tenantId, principal, scopes, traceId, runId?}
  ┌───────────────────────────────────▼──────────────────────────────────────┐
  │ @backline/services — ALL business logic. Typed DTOs. ServiceError only.  │
  │ crm/ · music/ · booking/ · finance/ · pipeline/ · agents/ · registry/    │
  └──┬──────────────┬──────────────────┬───────────────────┬─────────────────┘
     │              │                  │                   │
   db/          agents/            connectors/           rag/
  (Drizzle,   (registry, conn    (Load/Poll/Slim/     (chunk, embed,
   scope,      store, ACP/MCP     Checkpoint/PermSync  RAPTOR build,
   journal)    clients, approvals) OAuth, WriteBack)   hybrid retrieve)
     │              │                  │                   │
  ┌──▼──────────────▼──────────────────▼───────────────────▼─────────────────┐
  │ Postgres 17 (records, journal, vectors, tree) · Redis 7 (BullMQ, locks)  │
  │ S3 (documents) · Keycloak (identity) · external agent processes (sandbox)│
  └──────────────────────────────────────────────────────────────────────────┘
```

**RequestContext / tenancy.** Node `AsyncLocalStorage` carries `{tenantId, principal, scopes, traceId, agentRunId?}` — the TS analogue of onyx's tenant contextvar and pydantic-ai's `RunContext`. Tenancy is **schema-per-tenant** for agency groups (per-request `SET search_path`) with a shared `public` schema for the registry index cache, plus **row-level scope** inside a tenant for roster partitioning (a sub-agent in Berlin sees only their roster). **No service accepts a raw `tenantId` argument — it reads context, so an agent cannot forge one.**

**Layering rule, enforced.** `eslint-plugin-boundaries`: `api`/`web`/`worker`/`cli` may import `services` and `domain`; only `services` may import `db`, `connectors`, `rag`, `agents`. Violations fail CI. *This is what makes the headless surface free rather than a parallel implementation.*

**Three event streams, one vocabulary.**

1. **Record change journal.** Every write goes through `db.mutate()` which, in the same transaction, appends to `journal_event` (append-only; a Postgres trigger raises on UPDATE/DELETE). Rows carry `{offset BIGSERIAL, tenantId, objectType, objectId, action(CREATE|UPDATE|DELETE|MERGE|RESTORE|ASSOCIATION_ADDED|ASSOCIATION_REMOVED|STAGE_CHANGED), changedProperties, source, actor, occurredAt}`. **One append, five consumers**: the audit log, the outbound change feed (`GET /api/v1/journal?after=<offset>`), the automation trigger source, the RAG re-index queue, and the SSE feed for live UI. Push webhooks are a *projection* of the journal, never a separate path.
2. **Agent session stream.** Zed's `AcpThreadEvent` vocabulary ported wholesale. Entries are index-addressed with a separate `EntryViewState` map lazily materializing heavy per-entry components (diff viewers, settlement tables, markdown previews).
3. **Registry stream.** `AgentInstalled`, `AgentRemoved`, `AgentConnectionStateChanged`, `AgentVersionAvailable`, `RegistryRefreshed`.

All three multiplex over one authenticated SSE endpoint; WebSocket upgrade only for ACP.

**Workers.** Beat schedules dispatcher jobs (`checkForDueSyncs`, `checkForExpiringHolds`, `checkForStaleRaptorTrees`, `checkForSettlementDue`) — onyx's `check_for_X` shape. Long agent runs execute in the `agent` queue with heartbeat + watchdog: a run silent for 90s is marked `stalled`, its context serialized to a resumable record, and a `needs_human` signal emitted. **Time limits are implemented in-task, never trusted to the queue** (the onyx thread-pool lesson). Redis locks with heartbeat lease for singleton jobs. `Idempotency-Key` on every mutating operation, 24h replay window. Retry taxonomy is idempotency-aware: connect-phase failures retry, read/write timeouts on mutating calls do **not**.

**Deployment profiles.** `lite`: one Postgres, one Redis, API+worker in one process, local disk, hosted embeddings — runs on a $40 VPS. `standard`: separate API/worker/beat, MinIO, Keycloak. `group`: HA Postgres, per-queue autoscaling, per-tenant schema, Keycloak cluster. **The lite profile is a hard requirement, not a nicety — without it this design is unsellable below the enterprise tier.**

### 6.4 Data model — two layers, deliberately

**Layer 1 — generic object core** (HubSpot-derived): `object_type` (standard types are *seeded, not hardcoded*), `property` (with `hasUniqueValue` giving ISRC/ISWC/UPC uniqueness without bespoke DDL, and `agentWritable:false` making "hand-curated artist bio" un-overwritable), `record` (`properties jsonb` + GIN, `externalIds jsonb` = `{salesforce, hubspot, monday, musicbrainz}` — the natural-key map that makes sync idempotent), `property_value_history` (**the answer to "prove the agent didn't invent this guarantee figure"**), `association` + `association_type` (typed labeled directional edges — what makes the booking graph queryable in one engine and lets an agency add "co-headliner of" without a migration), `pipeline`/`pipeline_stage` (with `writePermission: OPEN|CURATOR_ONLY|SYSTEM_ONLY`), `journal_event`, `merge_log` (venues and promoters duplicate constantly via imports).

**Layer 2 — hard domain tables.**

- **Roster**: `artist` (legal entity vs performing name, `feeFloorMinor`, `commissionRatePct`, agreement term and scope, rider/tech-spec document refs); `artist_member` (*bands ≠ people — a departing drummer must not break booking history*); `artist_team` (manager, business manager, label, publisher, publicist, tour manager, attorney, per territory).
- **Catalog**: `work` (`iswc CITEXT UNIQUE NULLS DISTINCT`, PRO registration ref); `work_share` (`sharePct NUMERIC(7,4)`, role, PRO affiliation, territory) **with a deferred constraint asserting writer shares sum to 100.0000 per territory — splits are the #1 source of downstream royalty disputes, so they get a table, not a JSON blob**; `recording` (`isrc CHAR(12) UNIQUE`, version label, master owner, P-line); `release` (UPC/GTIN, catalog number, territory availability, C-line, DDEX ERN ref); `release_track`; `catalog`/`catalog_item` (ownership %, territory, term).
- **Venues/buyers**: `venue` (**IANA `timezone` — every date computation is venue-local**, `capacityConfigurations jsonb[]`, curfew, load-in notes, house split default, facility fee, box-office contact, market); `market` (for "don't play the same market within 90 days"); `promoter` (tier, internal credit rating, deposit requirement, default deal template); `radius_clause` (radiusKm, daysBefore/After, exclusivity scope) — **enforced in the hold engine, surfaced as a conflict warning, never silently violated**.
- **Bookings & the hold ladder** — the heart of the system:
  - `booking` with `holdLevel SMALLINT NULL`, `holdExpiresAt`, `billing: headline|support|co_headline|festival`, `announceAt`, `onsaleAt`.
  - Multiple holds share `(venueId, showDateLocal)` distinguished by level, with a **unique partial index on `(venueId, showDateLocal, holdLevel) WHERE status='hold'`**.
  - **Exactly one confirmed show per venue/date is enforced by `EXCLUDE USING gist (venue_id WITH =, daterange(show_date_local, show_date_local, '[]') WITH &&) WHERE status IN ('confirmed','contracted','settled')` — the database, not application code, is the last line of defense against a double-booking, because an agent will eventually try.**
  - `hold_challenge` (challenger, challenged, `respondByAt`, outcome `promoted|released|expired`) — the industry's "challenge the 1st hold, 24 hours to confirm or drop" ritual is a state machine with a `beat`-queue timer, not a calendar reminder. On expiry, holds cascade-promote (2nd→1st) inside one transaction and emit journal events.
  - **Artist availability is derived, not stored**: a query over confirmed bookings + travel-time feasibility + `booking_availability_block` rows.
- **Deals**: `offer` (versioned and **immutable once sent** — a counter creates version n+1; `dealType: flat|vs_percentage|door_deal|plus_bonus|festival_fee`, breakeven, bonus schedule, deposits); `contract` (**`termsSnapshot jsonb` frozen at execution — settlements reconcile against it, never against the live offer**; e-sign envelope, executed document, riders); `tour`/`tour_leg` with routing feasibility as a computed advisory surfaced in UI *and* as an agent tool.
- **Money**: `settlement` (gross box office, tickets sold/comped, ticket scaling, taxes, facility/ticketing fees, guarantee, overage, expenses, artist net, agency commission, withholding, FX rate, approver) — **every money column `NUMERIC(19,4)` in minor units, no floats anywhere**; approved settlements are append-only and corrections create `settlement_adjustment` rows; `settlement_line` with a category taxonomy (production, hospitality, marketing, backline, local crew, buyout) for cross-tour analytics; `commission`/`payout` exportable to Xero/QuickBooks.
- **Pipeline & core CRM**: `deal` for the *agency-side* pipeline (signing an artist, landing a festival slot, brand partnership) — **two pipelines, two vocabularies, one stage engine**; `contact`/`company` with music-specific properties; `activity` (including `type: agent_run`); `task` where **agents can own tasks**, so "the advancing agent owes you a tech pack by Friday" becomes visible work; `note` (markdown, `@`-mentions as typed URIs).
- **Agent tables**: `agent_definition`, `agent_install`, `agent_connection_state`, `agent_run`, `agent_run_entry`, `pending_approval`, `elicitation`, `agent_scope_grant`, `agent_budget`, `protocol_frame_log`.
- **RAG tables**: `rag_node` (layer, text, `embedding vector(1024)`, sourceRefs, model), `rag_node_child` (many-to-many — **soft cluster membership**), `rag_subject_state` (`lastBuiltJournalOffset`, `dirty`). **Incremental rebuild — the gap RAPTOR itself never closed — works by marking a subject dirty on journal append, then rebuilding only the leaf→root path containing changed leaves.**

### 6.5 Agent Registry — additions beyond the shared port

Solution C adds four things to the shared registry design in §2.1:

1. **`requiredScopes[]` on registry entries**, rendered as an **OAuth-style consent screen** in the install dialog. A registry entry declares which `crm_*` tool families it needs; installing is an explicit grant.
2. **Three hosting modes**, because a web CRM cannot spawn agents as browser child processes:
   - **Container** (default for registry agents): the agent image runs as a short-lived Kubernetes Job / Docker container in a locked-down network namespace, egress-allowlisted, with a per-run OAuth token minted for Backline's own MCP endpoint; Backline speaks ACP over the container's stdio via the worker.
   - **Sandboxed npx**: spawned inside the `agent` worker under a seccomp profile with `HTTPS_PROXY`/`NO_PROXY` injected (Zed's `load_proxy_env`) and **secrets injected per-agent from the vault, never inherited** (lumen's `safeChildEnv()`).
   - **Remote**: a hosted MCP/A2A/ACP endpoint where Backline is the client with full OAuth 2.1 (protected-resource-metadata discovery, PKCE, dynamic client registration, RFC 8707 resource indicators).
3. **Production health checking**: on install and every 15 minutes, a live handshake smoke test — connect, `initialize`, assert declared capabilities match actual, disconnect. The agoragentic `verify-acp.js` pattern **promoted from CI into production**. Failures flip the card to a red "Unhealthy" badge with captured stderr.
4. **Approval hardening**: the Flat / Dropdown / DropdownWithPatterns variants gain domain-shaped pattern rules ("Always allow *holds at venues under 800 cap*", "Always allow *sending offers under €5,000*") persisted to `agent_scope_grant` and evaluated before the gate on later calls; keyboard `A` / `Shift+A` / `D`; and **Allow buttons are disabled until a suspicious-content warning is acknowledged when arguments contain confusable Unicode or injected-looking instructions** (Zed's `unicode_confusables.rs` gate) — non-negotiable when arguments derive from promoter emails. The Mode × Scope matrix resolves scopes `READ | SEARCH | WRITE_DRAFT | WRITE_COMMIT | MONEY | EGRESS` against modes `assisted | supervised | autonomous`, with the unit-tested invariant that **EGRESS and MONEY never resolve to ALLOW in any mode**.

Tool-call cards get **domain-specific result renderers**: a proposed hold renders as a calendar diff, a proposed settlement as a line-item table with deltas highlighted, a proposed contract as a Markdown Preview pane.

### 6.6 Markdown Preview — additions beyond the shared port

Beyond §2.2, Solution C specifies: a `<MarkdownWorkspace>` component in `@backline/ui` composed of `<MarkdownSource>` (CodeMirror 6) and `<MarkdownPreview>` sharing a `MarkdownDocumentController`; two parse-time indices (`blockRanges` sorted for binary search, `offsetToBlock(offset)`) that every sync behavior consumes; a `comlink` Web Worker returning `{hast, blockRanges, headings, links, images, mentions}` with React reconciling against the previous tree **so unchanged blocks don't remount — which is what keeps Mermaid and Shiki blocks from flickering**; `crm://` mentions with query fragments (`crm://booking/01H4Q...?tab=settlement`, `crm://agent-run/01H9...#entry=42`) resolved batched-and-cached into chips with live status dots and hover cards, where **`@`-autocomplete queries `crm_search_records` — the same tool agents use**; Mermaid diagrams **paired with a `<details>` text alternative** (a diagram with no text alternative is a WCAG failure); a `≈70ch` max measure as a readability requirement; `Cmd/Ctrl+F` in-preview search whose matches map back to source ranges so "find in preview, edit in source" works; a print/PDF path through the same renderer **so what you review is what you send**; and **diff preview for agent edits** — when an agent proposes a rider revision or contract clause, the pane switches to a two-column or inline diff with block-level accept/reject, nothing written until accepted, acceptance being a `WRITE_COMMIT`-scoped journaled action.

### 6.7 Headless surface

**The UI is a client of the same API agents use. No private endpoints, no UI-only mutations.**

The **canonical operation registry** is a single `defineOperation({...})` call per capability:

```ts
defineOperation({
  id: 'crm_booking_place_hold',
  title: 'Place hold',
  description: '...states side effects, idempotency, and error shapes...',
  input:  z.object({ artistId, venueId, showDate, holdLevel, expiresAt, notes }),
  output: z.object({ bookingId, holdLevel, expiresAt, conflicts: z.array(ConflictSchema) }),
  scope: 'WRITE_COMMIT',
  annotations: { readOnly: false, destructive: false, idempotent: false, openWorld: false },
  rest:     { method: 'POST', path: '/bookings/holds' },
  a2aSkill: { id: 'booking-hold', inputModes: ['application/json'], outputModes: ['application/json'] },
  handler: bookingService.placeHold,
})
```

From this the build emits the Fastify route, the OpenAPI path, the MCP `registerTool` call, the A2A skill entry, the SDK method, and the CLI subcommand. A CI check asserts every operation has a description ≥ 120 characters, non-empty annotations, an id matching `^crm_[a-z_]+$`, and **that no protocol surface has drifted from the registry — the mechanism that prevents the classic failure where the MCP surface is a stale subset of the REST API.**

Canonical families include `crm_search_records`, `crm_batch_upsert`, `crm_describe_schema`, `crm_move_stage`, `crm_booking_check_availability`, `crm_booking_place_hold`, `crm_booking_promote_hold`, `crm_booking_challenge`, `crm_offer_draft`, `crm_offer_send` *(EGRESS — always gated)*, `crm_contract_send_for_signature` *(EGRESS)*, `crm_settlement_draft`, `crm_settlement_approve` *(MONEY — always human)*, `crm_tour_route_check`, `crm_catalog_lookup_isrc`, `crm_catalog_register_work`, `crm_ask` (RAG Q&A), `crm_journal_read`.

**REST** carries the closed search DSL compiled to parameterized SQL (**no string SQL, ever — injection is structurally impossible**), cursor pagination with `X-Total-Estimate`, error-partitioned batch endpoints with `idProperty` upsert, the journal feed with `/journal/status`, an error envelope `{errorCode, detail, traceId, hint?, retryable, retryAfterMs?}` where **every 4xx is actionable prose**, `X-Backline-Usage: requests=142/5000; tokens=88k/2m; window=day` so agents self-throttle, and `Idempotency-Key` on all mutations.

**MCP** at `/mcp` is stateless by default with an opt-in stateful mode whose `EventStore` is **Postgres, not memory** — which is what makes a dropped mobile connection resumable via `Last-Event-ID`. Records are resources (`crm://venue/{id}/tech-pack`, `crm://tour/{id}/routing`) with per-variable completions; playbooks (`advance-a-show`, `reconcile-settlement`, `prospect-market`, `draft-offer`) are prompts with `Completable` arguments; `resources/subscribe` pushes `notifications/resources/updated` from journal changes; `initialize` `instructions` ship the domain rules; tool handles support `enable()/disable()/update()` so **upgrading an agent's scope grant mid-session immediately exposes new tools**; sampling requests are served by the tenant's configured model **with cost attributed to that agent's budget**.

**A2A** at `/a2a` publishes Backline as an agent others delegate to, with `input_required` as the mechanism by which a delegating agent gets asked to confirm a hold date.

**ACP** at `/acp` over WebSocket serves browser-resident agent clients and third-party ACP hosts. **A versioned adapter layer sits between ACP wire types and the internal `AgentSession` events** — the internal vocabulary must never be the wire vocabulary, because ACP v1 is churning.

**Discovery**: `/.well-known/{agent-card.json, mcp.json, openapi.json, ai-plugin.json}`, `/llms.txt`, `/llms-full.txt`, `AGENTS.md`, a distributable `SKILL.md` (`bl skill install <host>` writes it into Claude Code / Cursor / Copilot skill dirs — **the most underrated adoption mechanism in the whole research set**), and a `crm_server_info` tool reporting version, auth status, granted scopes, and remaining budget.

### 6.8 Integrations — framework first, vendors second

`@backline/connectors` is a TS port of onyx's capability-interface design — **the single most reusable artifact in the research corpus for this requirement**:

```ts
interface Connector<Cfg, Ckpt>          { validate(cfg): Promise<ValidationResult> }
interface LoadConnector<T>              { load(): AsyncGenerator<Batch<T>> }
interface PollConnector<T>              { poll(since, until): AsyncGenerator<Batch<T>> }
interface CheckpointedConnector<T,Ckpt> { run(ckpt: Ckpt): AsyncGenerator<T | ConnectorFailure, Ckpt> }
interface SlimConnector                 { listIds(): AsyncGenerator<string[]> }
interface PermSyncConnector             { externalAccess(id): Promise<ExternalAccess> }
interface WriteConnector<T>             { push(ops: UpsertOp<T>[]): Promise<BatchResult> }  // Backline's addition
interface OAuthConnector                { authorizeUrl(...), exchange(...), refresh(...) }
interface EventConnector                { verify(req), toEvents(req): ChangeEvent[] }
```

Generators **yield `Document | ConnectorFailure` so one bad record never aborts a sync**; checkpoints are typed and returned so a 4-hour Salesforce backfill resumes after a deploy; `SlimConnector` ID-only passes detect remote deletions; per-record failures land in `sync_failure` with the vendor's error text preserved. A lazy-import connector registry keeps 30 connectors from bloating startup, and each ships a `connector.yml` manifest rendered by the **same card component as the Agent Registry — one registry UX, two catalogs**.

**Field mapping is data**: `connector_mapping{remoteObject, localObjectTypeId, fieldMap jsonb, direction, conflictPolicy: local_wins|remote_wins|newest_wins|manual, filterExpression}`, seeded from **describe-driven introspection of both sides** so an admin picks from real field lists and an agent can propose a mapping a human approves.

**Sync mechanics**: per-credential distributed lock; bidirectional conflict resolution keyed on `externalIds` + `updatedAt` + a per-field last-writer table; idempotent writes; **proactive token-bucket rate limiting per vendor because HubSpot/monday throttle on burst and reactive-429-retry alone is not enough**; a circuit breaker per credential that opens after N consecutive failures and **surfaces a red banner rather than silently stalling**.

**CRM interop**: **Salesforce** via `jsforce` v3 with the **Pub/Sub API (gRPC) Change Data Capture as the primary ingestion path** and `updated()`/`deleted()` windows as fallback, JWT bearer auth (no password grants), Bulk 2.0 only (v1 is deprecated) — *custom objects work natively because Backline's own object layer is schema-driven, so a Salesforce `Booking__c` maps to a Backline `booking` without codegen*. **HubSpot** via the pinned alpha SDK wrapped so date-versioned route churn is isolated to one module, ingesting through the **webhooks-journal offset feed rather than push webhooks**. **monday.com** via `@mondaydotcomorg/api` with mandatory complexity-budget throttling, boards→object types, items→records, columns→properties, and monday's filter AST mapped onto the search DSL; the deprecated `monday-sdk-js` is used **only** client-side if Backline ships as an embedded monday board view.

**Music-industry integrations that actually matter to a booking agency**: MusicBrainz (1 rps, proper User-Agent) for ISRC/ISWC cross-checking; Spotify/Apple Music for catalog verification, prospecting signals, artwork; **DDEX ERN 4.x** ingest and export for label clients; **CWR v2.2/3.0 export** to ASCAP/BMI/PRS from `work` + `work_share`, plus SoundExchange ISRC repertoire export; ticketing (Ticketmaster/AXS/Eventbrite/DICE, read-only) for settlement pre-reconciliation and "how are we tracking"; Bandsintown/Songkick push on confirmation and pull for routing intelligence; DocuSign/Dropbox Sign with hash-pinned executed PDFs; Google Workspace + Microsoft 365 two-way calendar (per-artist and per-agent ICS feeds) and email threading into `activity` — **email *sending* is EGRESS-scoped and always gated**; Xero/QuickBooks for settlement→invoice, commission accrual, and multi-currency payouts with rate snapshots at settlement time; a generic ICS/CSV itinerary connector rather than bespoke travel integrations; Slack and Twilio for escalations and day-of-show.

**Agent-side**: any MCP server in the Agent Registry becomes a toolset for Backline's own agents (onyx's dual MCP posture), with **SSRF defenses ported verbatim** — Host-header denylist, private-IP/link-local blocking, and a URL-scheme allowlist blocking `s3://`/`gs://` (the IAM-credential SSRF vector) — and no credential inheritance into spawned processes.

**Credentials** live in a vault (HashiCorp Vault, or Postgres `pgcrypto` envelope encryption with a KMS-held DEK in the lite profile), **never in `config jsonb`**, with every secret registering into the log scrubber at load, and per-user vs per-tenant credential modes so a sub-agent's HubSpot access uses their own OAuth grant, not the agency's.

### 6.9 Accessibility and mobile

**WCAG 2.2 AA, verified.** The research found no reusable a11y code anywhere in the 16 repos, so this is budgeted at **~12% of frontend engineering, not retrofitted.**

Foundation: Radix for every interactive pattern with `react-aria` filling gaps (data grids, tour-routing date-range pickers); **design tokens with contrast as a build-time constraint** — a CI job runs APCA/WCAG checks over every foreground/background pairing in light, dark, and high-contrast themes and fails the build; Zed's keyboard-first action system ported, with every capability a named, remappable, palette-discoverable action (**both an accessibility win and the fastest path for power users — booking agents live in keyboards**); and a focus-management contract where every route change moves focus to `<h1>`, every dialog returns focus to its trigger, and visible focus rings are never removed.

**The hard parts, named:**

1. **Virtualized lists** break screen-reader context by default. Mitigations: `aria-setsize`/`aria-posinset` so "item 12 of 847" is announced, `aria-rowcount`/`aria-rowindex` on virtualized tables, scroll-into-view before focus, and **a "Show all items" escape hatch that disables virtualization below a threshold**.
2. **Streaming agent output.** A naive `aria-live="polite"` region attached to a token stream is a **screen-reader denial-of-service**. Backline announces at sentence boundaries with a 1.5s minimum interval, offers a per-thread "Announce agent output: off / summaries / full" preference (default *summaries* — announce state transitions like "checking venue availability", not every token), and **always announces terminal events regardless of setting**.
3. **Approval and elicitation dialogs** are the highest-stakes interactions in the product: `aria-modal`, descriptive labelling, **the full argument payload readable as text and not only as a syntax-highlighted blob**, destructive actions never focused by default, explicit confirm for MONEY/EGRESS, and generated forms using real `<label>`, `<fieldset>/<legend>`, `aria-describedby`, `aria-invalid`/`aria-errormessage`, and native `<input type="date">` (**mobile keyboards and AT date pickers beat every custom widget**).
4. **Markdown preview** emits semantic HTML with heading-order linting on render, Mermaid paired with text alternatives, and the active-block indicator exposed as `aria-current="location"` rather than colour alone. **Scroll follows, focus does not** — unless the user activated the jump.
5. **Data density vs touch.** The booking grid is genuinely dense. Rather than one responsive layout stretched thin, Backline ships **two compositions of the same components** — a desktop grid and a mobile card/stack with 44×44 targets, thumb-reachable primary actions, bottom sheets instead of popovers, and no hover-only information — selected by a `useLayoutDensity()` container query, **not user-agent sniffing**.

**Mobile specifically** (agents live on phones in venue loading docks): RSC-rendered record pages readable before hydration; a PWA service worker giving offline read of today's shows, contacts, and advance docs with queued writes and conflict surfacing on reconnect; agent-session resumability across network drops; `prefers-reduced-motion`/`prefers-contrast`/`prefers-color-scheme` and OS text scaling to 200% **tested at 320px × 200% zoom, the WCAG 1.4.10 reflow condition**; no fixed viewport, no `user-scalable=no`.

**Verification**: `@axe-core/playwright` failing CI on any serious/critical violation, Storybook `addon-a11y`, `eslint-plugin-jsx-a11y` at error level, quarterly manual audits with NVDA/Firefox and VoiceOver/Safari (macOS + iOS) plus keyboard-only and 400%-zoom passes on the ten highest-traffic flows, and **a published VPAT/ACR as a Phase 4 deliverable, because the enterprise buyers this tier targets will ask during procurement.**

### 6.10 Tradeoffs — the expensive option, named costs

1. **Time to first value is 4–6 months, not 4–6 weeks.** RBAC, multi-tenancy, the connector framework, the journal, and the agent registry are all foundational — they must exist before the first booking is entered, and none are visible to a user. **Solutions A and B will demo better for six months.**
2. **Operational surface.** Postgres + Redis + S3 + Keycloak + a worker fleet + an OTel backend + a vector index, plus container sandboxing. The `lite` profile compresses this to two services, but even lite needs someone who can read a queue-depth graph. Dropping Vespa pre-concedes part of that fight; **this is still not a zero-ops product and cannot honestly claim to be.**
3. **RAPTOR is expensive and it was simplified.** Building the tree is O(nodes) LLM summarization calls; a five-year history for 40 artists is a real bill, and incremental rebuild is net-new engineering with genuine correctness risk around dirty-path propagation. Replacing UMAP+GMM+BIC with agglomerative cosine clustering is cheaper and dependency-free but **will produce worse cluster boundaries on heterogeneous corpora**; if retrieval quality disappoints, the fix is a Python sidecar running the real algorithm — an architectural regression better admitted up front than discovered in production. Mitigation: feature-flag RAPTOR per tenant and **ship flat pgvector retrieval first**.
4. **Three agent protocols is three maintenance burdens.** MCP is stable-ish. ACP is explicitly churning. A2A is fragmenting. **If forced to cut, cut ACP first — keep the UX, drop the wire protocol — and keep MCP + A2A.**
5. **Persisted approvals are slower and more complex than Zed's oneshot**: orphaned pending approvals, agents timing out mid-negotiation, approvals resolved after the run died, and p99 latency on every mutating agent action measured in human minutes. Correct for contracts and settlements, actively annoying for low-stakes reads — **which is exactly why the scope matrix matters; get it wrong and the product feels like a permissions dialog with a CRM attached.**
6. **The two-layer data model is a real cost.** Keeping a `booking` coherent as both a `record` row and a `booking` row requires discipline in every service and one very careful write path. Simpler designs pick one. Both were picked deliberately — pure property bags cannot enforce "one confirmed show per venue per date," and pure relational cannot absorb a Salesforce custom object — **but the seam is where bugs will live.**
7. **The registry index is a dependency on someone else's CDN and schema** if the ACP community index is used. Cache-and-throttle mitigates outages, not schema changes; the curated index is the safe default and community is opt-in per tenant.
8. **HubSpot's SDK is alpha and date-versioned**, its mock-server tests are all `test.skip`, so behaviour coverage must be built from scratch on our side.
9. **What was not built**: no real-time collaborative editing (contracts are reviewed, not co-typed), no native mobile apps, no ticketing platform, no royalty accounting engine (splits are modeled; distribution accounting is not), no email client. Each is a plausible ask and each is a "no" for v1.

**Do not pick Backline Arena if**: the customer is a single agency under ~15 seats in one territory; the buyer wants to be live in a month; there is no engineer who will own the worker fleet; agent autonomy is a "nice to have" rather than the reason for buying; or the integration requirement is really just "export to CSV." **In all of those cases the lightweight solution wins outright, and the honest move is to say so.**

### 6.11 Roadmap

| Phase | Weeks | Exit criterion |
|---|---|---|
| 0 Foundations | 1–5 | `crm_create_record` / `crm_search_records` / `crm_get_record` exist simultaneously as REST, SDK, and CLI, with a journal entry per write, in a tenant-scoped test |
| 1 Domain | 6–13 | An agency runs a full show lifecycle — enquiry → 1st hold → challenge → confirm → offer → contract → settlement — **entirely through the UI *and* entirely through the REST API**, with a full journal trail; first axe gate on |
| 2 Agent platform | 14–22 | A third-party MCP agent installed from the registry places a hold, is blocked at `crm_offer_send`, a human approves with an "always under €5k" pattern rule, and the whole exchange is inspectable and journaled |
| 3 Documents & retrieval | 20–28 (overlapping) | An agent answers "summarize our history with this promoter and cite the settlements" with a drillable evidence ladder; a rider is edited with live preview and clickable checkboxes |
| 4 Integrations & enterprise | 26–38 | Bidirectional HubSpot sync survives a chaos test (kill worker mid-batch, replay from checkpoint, **zero duplicates**); an external A2A agent completes a delegated task; published accessibility conformance report |
| 5 Scale & sharpen | 38+ | Per-queue autoscaling, HA Postgres, cross-tenant analytics for agency groups, marketplace curation tooling — and *"whatever the first three customers actually ask for, which on the evidence of every CRM ever shipped will be report builders and email templates, not more agent protocols."* |

**Two hard gates:** (a) no feature merges without its headless path, enforced by the operation-registry drift check; (b) no page merges with a serious/critical axe violation. **Both are cheap on day one and unaffordable to add in month nine.**

---


## 7. Adversarial critique, comparison, and recommendation

An independent reviewer attacked all three designs against the brief. **None of the three is shippable as proposed.** What follows is unedited in substance.

### 7.1 Where each solution fails

#### Solution A — Backline One

- **The synchronous-DB-in-a-single-event-loop hazard is unnamed and disqualifying at load.** `bun:sqlite` is a *synchronous* API. Solution A puts the HTTP server, WebSocket fanout, MCP streams, `Bun.cron` jobs, and every connector sync in one process with one event loop. A two-second FTS query or a bulk Salesforce import transaction blocks **every** agent stream and **every** human request in the agency. No worker threads, no async driver, no read-replica split, no `SQLITE_BUSY` policy. **This is the single largest robustness defect across all three solutions and A never mentions it.**
- **Litestream is durability, not an audit ledger.** A's `event_log` is simultaneously the money audit spine and a table replicated asynchronously with an admitted minutes-long RPO. A restore *rewinds the journal* — and journal offsets are the public change-feed cursor. **Offset regression after restore silently breaks every external consumer and every agent that cached a cursor.**
- **Agent hosting is a security hole.** The manifest allows `runtime: "stdio-on-server"` — spawning third-party agent processes as children of the process that owns the SQLite file and the secrets. No sandbox, no seccomp, no egress allowlist, no environment scrubbing, no digest pinning, no per-run credential minting. **Installing a registry agent on Backline One is equivalent to `curl | sh` on the production database host.**
- **No SQLite exclusion constraint = no database-level double-booking prevention.** `UNIQUE(venue_id, event_date, level) WHERE active` prevents duplicate holds at the same level but not two *confirmed* shows at the same venue on the same date. SQLite has no `EXCLUDE USING gist`. A's own philosophy says the DB is the last line of defense; here it isn't.
- **Tenancy is hidden ops burden, not absent complexity.** "One writer process per agency" means N containers × N Litestream sidecars × N migration runs × N restore drills, with no control plane or rolling-upgrade orchestration. Calling it "an appliance" avoids pricing it.
- **Auth is a downgrade dressed as simplification.** Skipping the SDK's OAuth router means no RFC 9728 protected-resource metadata, no PKCE, no dynamic client registration — which **directly contradicts A's own claim that an agent can connect "with zero human help,"** since modern MCP hosts auto-onboard through exactly that discovery dance. No OIDC/SAML/SCIM either: A fails procurement the first time a major label's IT asks for SSO.
- **Music-domain gaps that matter commercially**: no `offer` entity at all (offers are the actual negotiation artifact — versioned, immutable-on-send, countered; A jumps enquiry→hold→contract); no venue timezone / show-local date modeling; deal types limited to flat/vs/door (no plus-bonus, no breakeven, no backend percentage); no radius clauses; no artist-member vs artist distinction; splits as bps on the work row rather than per-territory rows with sum-to-100, PRO affiliation, and capacity codes, **putting PRO/CWR registration architecturally out of reach**; no catalog entity despite the brief naming catalogs; no FX snapshot, withholding tax, or ticket scaling.
- **Accessibility is asserted, not designed.** "Radix primitives buy the WCAG baseline" overclaims — shadcn copies components into your repo, and its tables, virtual lists, and toasts have known gaps. No virtualization-vs-screen-reader treatment, no 200%-zoom/320px reflow, no VPAT, no manual AT plan.
- **Streaming markdown is waved through.** Re-parsing partial, syntactically invalid markdown every 16ms is a different problem from Zed's debounced reparse of a complete buffer — **Zed's preview never streams.** Incomplete-node handling, position-map churn, and Mermaid/KaTeX thrash mid-stream are unaddressed.
- **Roadmap is fiction at the tail.** Phase 5 packs Salesforce + HubSpot + monday + field-mapping UI + MusicBrainz into six weeks. Salesforce alone is six weeks. And naming the LGPL relink obligation is not mitigating it.

#### Solution B — Backline Mesh

- **The generic record head is an invariant bypass around the domain services — the most serious defect in B.** B exposes `/v1/{objectType}` generic CRUD and `crm_batch_upsert` over `record.properties jsonb` while claiming hold etiquette is a "services-enforced invariant the agent layer cannot bypass." **An agent with write scope can `PATCH /v1/booking/{id}` directly and never touch `crm_advance_booking`.** No database-level constraint prevents two confirmed shows at a venue on a date. Application-layer invariants plus a generic write head means **the invariants are advisory.**
- **`Bun.cron` in a horizontally-scaled deployment fires on every replica.** B's headline claim is horizontal scale-out, yet hold-expiry sweeps run on `Bun.cron` with no leader election or advisory-lock guard. **Two replicas = two hold-expiry sweeps = double promotions on a money-bearing state machine.**
- **Single outbox table = coupled fanout.** One dispatcher feeds WebSocket topics, the public journal, MCP resource notifications, and connector triggers, with no per-consumer offsets. A throttled monday sync backs up UI liveness behind it. *The design meant to decouple heads couples them at the dispatcher.*
- **Bun + Postgres is the worst of both bets.** B pays Bun's risk surface — Node-compat gaps on streaming client request bodies, **which is exactly what Salesforce Bulk 2.0 CSV upload needs** — to buy `Bun.serve` WS topics and `Bun.cron`, then uses Postgres LISTEN/NOTIFY + SKIP LOCKED for the actual coordination. Small wins, full-price risk.
- **Music domain is the thinnest of the three.** Splits as `writers[], splits[]` JSON cannot carry per-territory shares, sum-to-100, PRO affiliation, or publisher roles, **excluding PRO registration architecturally**. **There is no catalog entity at all, though the brief explicitly names catalogs.** Tour legs are an array, not entities with dates and routing order. Prospecting gets one sentence. No venue timezone. No offer versioning as a first-class entity.
- **The Agent Registry can install almost nothing that is actually in the ACP registry.** B's connection model is remote endpoints only, but the real ACP registry is dominated by npx/stdio-distributed agents. **B ports Zed's registry UI faithfully onto a catalog it cannot populate, and never acknowledges the gap.**
- **Dual REST + GraphQL is admitted tax that stays in the roadmap.** Saying "delete GraphQL if you don't need it" and then shipping it in Phase 5 with deliberately half-built mutations is the worst configuration: two surfaces, one incomplete, both needing drift checks.
- **Auth assumes an IdP the customer doesn't have.** A 12-person booking agency has Google Workspace and a shared password manager, not an IdP to proxy to. Integration tokens live in "encrypted Postgres columns" with no stated key custody or rotation.
- **Roadmap:** the connector framework plus HubSpot plus Salesforce plus monday in four weeks is not credible.

#### Solution C — Backline Arena

- **Fails requirement (1) outright, and the "lite" escape hatch doesn't hold.** Its human auth is Auth.js *with the Keycloak provider* — **Keycloak is not optional in the design**, and it is ~1 GB of RAM plus realm config, key rotation, and an upgrade path. "$40 VPS running Postgres 17 + Redis + API + worker + Next.js + HNSW indexing" is not credible. The brief said *most lightweight possible*; this is the least lightweight possible.
- **Schema-per-tenant + `SET search_path` is a cross-tenant data-leak footgun.** Under transaction pooling (pgBouncer, Supavisor, most managed setups), `search_path` set on checkout leaks to the next borrower. C cites the onyx pattern but **never names the pooling hazard**. Worse, C chose schema isolation *instead of* row-level security, so there is no defense in depth: **one lost `search_path` is a full cross-tenant read.** Combined with `AsyncLocalStorage` as the sole carrier of `tenantId` — easily lost across BullMQ job boundaries and escaped callbacks — the claim "an agent cannot forge a tenantId" rests entirely on propagation discipline. Also: 100 tenants × ~60 tables = 6,000 tables and multi-hour migrations, with no orchestration story.
- **RAPTOR is worse than the admitted schedule risk — it is a provenance-laundering risk in a money system.** LLM-summarized layer-2 nodes about a promoter's payment history become retrievable "facts" an agent cites when drafting a settlement. The evidence ladder mitigates *display*, not retrieval bias or summary hallucination. C says gate it behind a flag, then puts it in Phase 3 anyway.
- **Duplicated money model.** `settlement.expenses jsonb` **and** `settlement_line` rows both hold itemized expenses — two sources of truth for money, in the one place C insists correctness is non-negotiable, with nothing reconciling them.
- **The proposed protocol cut destroys the requirement it was meant to protect.** "Cut ACP first, keep the UX" leaves C's registry able to host only MCP/A2A endpoints — **the exact limitation of Solution B, arrived at after building the sandbox runtime for it.** Either the ACP transport is load-bearing (don't offer to cut it) or it isn't (don't build it).
- **Salesforce Pub/Sub gRPC CDC as *primary* ingestion adds a licensing dependency.** CDC availability and object limits are edition/add-on gated, so many customers silently get the fallback path — **which then never gets the same testing.**
- **Running arbitrary registry container images per tenant is an unpriced business liability.** Digest pinning is mentioned; supply-chain review, egress-allowlist maintenance, compute cost attribution, and **who is liable when a registry agent exfiltrates a contract** are not. C is the only solution that can host these agents and therefore the only one that inherits the liability.
- **Time to first value is the killer.** No booking exists until week 13; the agent platform — the reason someone buys an agentic CRM — lands week 22. In a market where agencies evaluate three tools in a two-week trial, "A and B outdemo us for six months" is not a tradeoff, it is a loss.
- **The two-layer seam is admitted and unmitigated**: no stated transactional invariant, no reconciliation job, no consistency test. **Mixed a11y primitive stacks** (Radix + react-aria) means two focus-management philosophies in one design system. **Cost is unmodeled** in the solution whose entire justification is enterprise-tier value.

### 7.2 Cross-cutting gaps — what *all three* underserve

1. **Data migration from incumbents — absent in all three, and the #1 reason CRM rollouts fail.** All three offer *sync* and CSV import; none offers *migration*. No importer for what booking agencies actually run (Prism, Master Tour, Muzeek, Overture, Artist Growth, Gigwell), and no plan for the universal reality that the data is in Excel, Google Sheets, and fifteen years of Outlook. Missing everywhere: entity resolution and dedupe at import scale, staged migration with rollback, historical settlement/contract backfill, and a **60-day parallel-run mode with reconciliation reporting** — which is what every agency will actually demand before switching.
2. **Email and calendar are the CRM's real surface, and all three sequence them behind agent infrastructure.** Booking agents live in email threads and hold calendars. A and B have **no email ingestion, no calendar sync, no ICS feeds, no thread→activity association, no shared team inbox**. C lists them at week 26+, *after* the agent platform. Without them the activity timeline is empty and every touchpoint is manual data entry — **the classic CRM adoption failure, and all three walked into it.** Also missing everywhere: outbound email infrastructure (DKIM/SPF/DMARC, bounce and complaint handling, suppression lists, consent for prospecting outreach), meeting scheduling, and inbox ownership.
3. **Delegated agent authorization — the on-behalf-of question is unanswered in all three.** None defines whether an agent acts *as* a user (inheriting that user's roster scope) or *as itself*. So none specifies RFC 8693 token exchange/downscoping, per-user consent recording, what happens to in-flight runs when the delegating user is deprovisioned, revocation propagation into live sessions, or **transitive delegation across A2A** — when Backline delegates to an external agent that calls back into Backline, whose scopes apply? **That is a textbook confused deputy and all three enable it.** B and C cite RFC 8707; nobody cites 8693.
4. **Prompt injection through ingested CRM content is not treated as an architectural threat.** All three ingest untrusted third-party text — promoter emails, riders, contracts, web research — into agent context. C alone has a confusable gate and strict render sanitization. None specifies a trusted/untrusted boundary *in the prompt*, provenance tagging of context chunks, or output-side egress checks. Human gates bound blast radius but do not stop exfiltration via a read-only tool plus the agent's own network access, or **stored prompt injection — an agent writes a note containing instructions, a later agent reads it as context.** All three have `crm_note_write`, all three feed notes back to agents, **and none treats agent-authored content as an attack surface against the next agent.**
5. **Unit economics and metering of the agentic layer.** None models cost-per-workflow, who pays for registry agents' compute (decisive for C, which hosts them), embedding/RAPTOR refresh cost, or behavior when a budget exhausts mid-settlement. None states a pricing model, **even though metering must be designed into the write seam, not bolted on.** An agentic CRM whose COGS scale with usage and whose pricing scales with seats is a business-model failure, not an architecture detail.
6. **Offline write path.** A: read-only cache. B: stale reads. C: "queued writes with optimistic UI and conflict surfacing" — one clause with no conflict model behind it, **which is the most dangerous of the three because it implies an engine that doesn't exist.** The actual user is a tour manager settling a show at 1am in a venue basement with no signal.
7. **Multi-currency, withholding, and cross-border tax are systematically under-modeled.** Only C carries FX snapshots and withholding. None handles tax-treaty withholding reduction / Central Withholding Agreements, VAT and reverse charge on commission invoices, currency-of-record vs settlement-currency reconciliation, or per-territory registration state. **This interacts badly with "settlements are immutable after approval" — a retroactive FX or withholding correction has no mechanism in A or B at all.**
8. **Zed Markdown Preview fidelity: all three lose the *workspace* semantics.** Zed's preview is a workspace **item/tab**, not a panel — `OpenPreview`, `OpenPreviewToTheSide`, `CloseAndReturnToEditor`, `activate_or_add_preview` / `find_existing_independent_preview_item_idx` (reuse an existing preview rather than opening a second), a distinct singleton Follow-mode view coexisting with per-document Default previews, keyboard `ScrollDown`/`ScrollUp` actions, and `limit_content_width`/`max_width` settings. All three model it as a side panel, **silently dropping preview-tab reuse, open-to-the-side, close-and-return, and the Default-vs-Follow coexistence rule.**
9. **Agent Registry fidelity: the credential-capture flow that web hosting *requires* is under-designed everywhere.** Zed's install is trivially local. On the web, install additionally needs per-tenant vs per-user secret capture, OAuth callback routing per tenant, credential health monitoring, and a coherent failure UX — **"agent installed and healthy for Alice, unauthenticated for Bob."** C gets closest but even C doesn't describe that split-state UX; A and B put an `auth[]` descriptor in the manifest and stop.
10. **No agent-behavior evaluation harness in any of the three.** All three test code. **None tests the product, which is agent behavior**: golden transcripts, regression tests that the agent still refuses to auto-approve a settlement after a prompt or model change, tool-contract conformance against real MCP hosts' quirks (Claude Desktop, Cursor, and Copilot each mangle params differently — A and B cite defensive coercion but neither tests against the real clients), model-upgrade regression gates, or a staging tenant with synthetic roster data.
11. **"Interoperable with ALL agentic frameworks" collapses to "we ship MCP + OpenAPI" — missing the direction that matters commercially.** Being interoperable with Salesforce/HubSpot/monday in 2026 means being invocable **inside their** agent runtimes (Agentforce actions, HubSpot Breeze, monday AI/app blocks), not only syncing records outward. **No solution exposes itself as a callable action in a partner platform's agent runtime.** Also unmentioned by all three: **AG-UI** (sitting in the same workspace as the ACP/A2A research), native LangChain/LlamaIndex tool packages, OpenAI Responses-format tool definitions, and vendor-neutral inbound webhooks for Zapier/Make — *which is how small agencies actually integrate.*
12. **Nobody designs for the search/dedupe work that dominates daily use.** Fuzzy venue/promoter/contact matching, merge with field-level survivorship, and identity resolution across email domains are core CRM hygiene. C has the pieces; B mentions merge in an enum; A has neither. **None makes dedupe a workflow with an agent tool and a human review queue — the single most obvious high-value agent task in a CRM, left on the table by all three.**

### 7.3 Comparison matrix

Scores 1–5, higher is better. The two rows marked *(added)* were introduced by the reviewer because the original criteria did not cover the brief's music-domain and Zed-UX requirements.

| Criterion | A — Backline One | B — Backline Mesh | C — Backline Arena |
|---|---|---|---|
| **Lightweight** (5 = least infra) | **5** — one process, one file DB, one artifact; the only design a 6-person agency self-hosts unaided | **3** — Postgres-only is genuinely restrained, but 9 packages, 5 layers, and REST+GraphQL+MCP+A2A+CLI is not lightweight | **1** — PG + Redis + S3 + Keycloak + 6 queues + OTel + Langfuse + container sandbox; "lite" still needs an IdP |
| **Robustness** | **2** — sync SQLite on the event loop blocks all heads; no DB-level double-booking constraint; async-replicated audit ledger; journal offsets regress on restore; unsandboxed agent spawn | **3** — Postgres + append-only trigger is sound, but generic CRUD bypasses lifecycle invariants; `Bun.cron` fires per replica; single coupled outbox | **4** — gist EXCLUDE, NUMERIC money, sandboxed agents, circuit breakers; docked for `search_path` pooling leak, ALS-only tenancy, duplicated expenses |
| **Interop breadth** | **3** — MCP+A2A+OpenAPI+3 CRMs+MusicBrainz; no email/calendar, e-sign, accounting, ticketing | **3** — same plus GraphQL; 3 CRMs only; no catalog entity to sync | **5** — 3 CRMs + Google/M365 + DocuSign + Xero/QBO + DDEX + CWR + ticketing + Bandsintown/Songkick + Slack/Twilio on a real capability framework |
| **Agentic depth** | **4** — persisted approvals, elicitations, policies, budgets, protocol inspector, CI drift check; weak on sandboxing and delegated auth | **4** — same core plus stateless-MCP scale-out and PG EventStore resumability; registry hosts remote endpoints only, so real catalog coverage is thin | **5** — container/npx/remote hosting, health smoke tests, version-reconnect, Mode×Scope with never-ALLOW-EGRESS, confusable gate, pattern grants |
| **Accessibility** | **3** — Radix is a real baseline but a11y is asserted; no reflow/zoom, no VPAT, no AT plan | **4** — React Aria is the strongest primitive choice; axe in CI, manual AT on four flows; light on virtualization and reflow | **5** — names the hard parts (aria-setsize under virtualization, live-region DoS, 320px×200% reflow, dual compositions, VPAT as deliverable); docked for stack mixing |
| **Time-to-MVP** (5 = fastest) | **4** — bookings + holds + settlements at ~week 10; integrations slip but the core demos early | **3** — headless CRUD at ~week 3, but registry and connectors push real value to week 15–19 | **1** — no booking until week 13, agent platform week 22, integrations week 26–38 |
| **Scale ceiling** | **2** — single writer, vertical only; Litestream is durability not HA; one process per agency with no control plane | **3** — horizontal API + stateless MCP is real, but the outbox dispatcher and `Bun.cron` are un-sharded singletons | **5** — schema-per-tenant, per-queue autoscaling, HA Postgres; genuinely built for agency-group scale |
| **Ops burden** (5 = lowest) | **4** — one binary is trivial per tenant, but N tenants = N containers + N sidecars + N restore drills, unautomated | **3** — PG + workers + S3 + external IdP dependency; two roles, one image | **1** — needs a dedicated platform owner |
| *(added)* **Music-domain fidelity** | **3** — good hold ladder and ISRC/ISWC uniqueness; no offers, no venue timezone, no radius clause, no band-vs-member, no FX/withholding | **2** — thinnest: splits as JSON (blocks PRO/CWR), **no catalog entity**, tour legs as an array, prospecting in one sentence | **5** — versioned immutable offers, `termsSnapshot`, challenge state machine with cascade promotion, radius clauses, IANA timezones, sum-to-100 per territory, CWR/PRO, ticket scaling, FX, withholding |
| *(added)* **Zed UX fidelity** | **4** — faithful registry mechanics and source-position map; loses preview-as-tab; streaming markdown unsolved | **4** — equally faithful registry UI over a catalog it cannot populate; loses tab semantics and max-width | **5** — highest fidelity on both incl. hosting modes, health checks, consent screen, diff review, print pipeline, mermaid text alternative; still loses the workspace tab model |
| **Unweighted total** | **34** | **32** | **37** |

### 7.4 Recommendation

> **A hybrid beats all three, and it is not a close call — but it is a hybrid with a specific spine, not a merge.**

A is the only design that satisfies *most lightweight*, and it fails *robust* at the architecture level. C is the only one that satisfies *robust* and the music domain, and it fails lightweight, time-to-value, and cost so badly it is unsellable to the stated customer. B is the intellectual bridge — **the operation-registry-projects-to-four-protocols idea is the single best mechanism in the whole set** — but its own data model undermines it.

**Build: B's contract mechanism + C's domain and safety model + A's deployment discipline.**

- **Spine (from B).** One canonical `crm_*` operation registry — `{input, output, annotations, scope, confirmRequired, rest, a2aSkill, handler}` — mechanically emitting the HTTP route, the OpenAPI path, the MCP tool, the A2A skill, the SDK method, and the CLI subcommand, with a CI drift check. *This is what makes the headless requirement free rather than a parallel implementation, and it is the only credible answer to "interoperable with all integration points."* Enforce the layering rule with `eslint-plugin-boundaries` as a CI gate from commit one.
- **Correctness and domain (from C).** Postgres with hard tables for the money-and-conflict spine: `EXCLUDE USING gist` for one confirmed show per venue/date, partial unique index per hold level, versioned immutable offers, `termsSnapshot` frozen at execution, `work_share` with per-territory sum-to-100, NUMERIC minor units, venue IANA timezone on every date computation, FX snapshot at settlement. **Delete B's generic write head**: keep `record.properties jsonb` and `property_def` for *custom* fields only, and make the generic route read-only plus custom-property writes. Domain state transitions go through domain operations, period. **That single change removes the largest correctness hole in B while keeping the runtime-schema flexibility that makes sync and agent introspection work.**
- **Agent safety (from C).** The Mode × Scope matrix with the unit-tested invariant that EGRESS and MONEY never resolve to ALLOW; persisted `pending_approval` rows where timeout resolves to *Denied*; sandboxed hosting with egress allowlist, no credential inheritance, and per-run minted tokens. **Non-negotiable — A's design lets an installed third-party agent run beside the database file.**
- **Deployment (from A).** One Postgres, one object store, one container image with two roles. **Cut Redis** — use `FOR UPDATE SKIP LOCKED` + LISTEN/NOTIFY and add BullMQ only when queue semantics are genuinely needed. **Cut Keycloak** — ship OAuth 2.1 resource-server plus local accounts and buy SSO (WorkOS/Auth0/Clerk) when the first enterprise deal demands it; do not run an identity server for a 20-seat agency. **Use `tenant_id` + Postgres RLS, not schema-per-tenant** — it eliminates the `search_path`-under-pooling leak and the 6,000-table migration problem, and gives the defense in depth that ALS-only tenancy lacks.
- **Runtime: Node 22, not Bun.** Both A and B name Bun's buffered client request bodies as a real problem and then build a Salesforce Bulk 2.0 CSV uploader anyway. The worker fleet, OTel maturity, and vendor SDK compatibility all argue Node. **Keep Hono** (fetch-native, portable) rather than committing to `Bun.serve`.

**Cut ruthlessly:** GraphQL (B's admitted tax), RAPTOR (C's admitted risk — ship flat pgvector hybrid retrieval behind the same interface and revisit), the ACP *wire protocol* (keep the registry UX; host MCP/A2A/stdio agents), `bun build --compile` on-prem binaries (unresolved LGPL relink obligation), and C's twenty-integration catalog.

**Re-sequence — the most important change to all three roadmaps.** Every solution puts email/calendar and data migration *after* the agent platform. **That is backwards and it is how CRM rollouts die.**

| Phase | Content |
|---|---|
| 0 | Contracts + domain + REST/SDK |
| 1 | Booking domain through settlement |
| **2** | **Email + calendar + migration/parallel-run — the adoption gate** |
| 3 | MCP head + web UI |
| 4 | Agent Registry + approvals |
| 5 | Sync connectors — HubSpot first (cleanest contract, journal-pull), Salesforce second, monday third |

**Add as v1 line items what all three omitted:** a migration mode with dedupe, survivorship, and 60-day parallel-run reconciliation; delegated agent authorization (on-behalf-of token exchange, per-user consent, revocation propagation to in-flight runs, and an answer for transitive A2A delegation); a trusted/untrusted context boundary with provenance tagging that **treats agent-authored notes as untrusted input to the next agent**; per-tenant metering designed into the write seam with a stated pricing model; and an agent-behavior eval harness (golden transcripts, refusal regressions on model upgrade, conformance tests against real MCP hosts).

**If forced to pick one unmodified:**

- **Solution A** — but only for a single-territory agency under ~15 seats that accepts read-only offline, no SSO, and an audit ledger with a minutes-long RPO, and only after fixing the synchronous-SQLite-on-the-event-loop defect and **refusing to host any third-party agent process.**
- **Solution C** — defensible only if the buyer is a multi-territory agency group with a platform engineer and a six-month runway, and even then **cut RAPTOR and the third protocol before writing a line.**
- **Solution B should not be built unmodified**: it carries Bun's risk without Bun's payoff, pays for two query heads, and **its generic write head silently voids the invariant guarantees that are its stated reason for existing.**

---


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
