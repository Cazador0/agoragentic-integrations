# Closing the twelve cross-cutting gaps

The adversarial review (see `../../deliverables/2026-07-27-agentic-crm-architecture.md` §7.2) found twelve requirements that **all three** proposed architectures underserved. This document is the design answer, and the scaffold in `backline/` implements the load-bearing parts.

## The unifying insight

Eleven of the twelve gaps close at **two chokepoints the hybrid already has**:

1. **The write seam** — `commit()` is the only path through which any record changes. Anything that must be true of every mutation (provenance, metering, trust labelling, revocation checks, audit) is enforced there once, not at N call sites.
2. **The operation registry** — every capability is declared once and *projected*. Anything that must be true of every capability surface (partner runtimes, webhooks, SDKs, tool definitions) is an emitter, not an integration project.

The gaps were not twelve independent omissions. They were the predictable consequence of designs that had those two chokepoints available and did not push enough through them.

The twelfth gap — email/calendar/migration sequencing — is not a code problem and cannot be closed by architecture. It is closed by a **failing CI test that blocks the agent platform** (§1).

---

## 1. Email, calendar, and migration — sequencing enforced by a red test

Moving them earlier in a roadmap document does nothing; roadmaps slip in the direction of whatever is most interesting to build. The closure is to make deferral *mechanically impossible*.

**The empty-timeline gate.** `evals/adoption/timeline.gate.test.ts` seeds an artist, a venue, and a booking, ingests a fixture mailbox, and asserts the booking's activity timeline is non-empty and correctly threaded. **It is committed red on day one.** The agent-platform packages (`packages/mcp`, agent registry) carry a CI dependency on that gate passing. You cannot merge the thing everyone wants to build until the thing that determines adoption works.

**Activity is the spine, declared in Phase 0.** Every touchpoint — email, call, meeting, agent action, sync write — is an `activity` row carrying `thread_id`, `source`, and `trust` (§3). The timeline exists as a domain concept before any connector does, so wiring email later is populating a table, not retrofitting a model.

**Thread → entity association**, in confidence order:
1. An explicit `crm://booking/{id}` reference in the message body or a `+tag` in the reply-to address (deterministic; emitted on every outbound message).
2. Participant email → contact match.
3. Subject/`References` header threading against known threads.
4. **Everything else lands in an unmatched queue** — which is the same human review queue as duplicate resolution (§12) and import survivorship (§1 below). One queue, three producers.

**Calendar in two directions, cheap side first.** An **ICS feed** per user, artist, and tour ships in Phase 1: read-only, zero-auth (signed opaque URL), works in every calendar client that exists, ~200 lines. Holds publish as `STATUS:TENTATIVE` / `TRANSP:TRANSPARENT` so a held date greys the agent's calendar without blocking it. Bidirectional Google/Graph sync comes later and is a connector, not a foundation.

**Migration is a product feature, not a script.** `packages/connectors/migration` defines a `SourceAdapter` (CSV/XLSX, Prism, Master Tour, Muzeek, Overture, Gigwell, Outlook PST). Records land in a `staging` schema, an entity-resolution pass emits `match_candidate` rows, a human resolves survivorship field-by-field, and the commit flows **through the same write seam** so every migrated field carries `source_type: IMPORT` provenance and can be traced back to its source row.

**Parallel-run mode** is the actual switching gate: `reconciliation_run` re-imports the incumbent export on a schedule and diffs it against Backline, producing a per-entity drift report. Sixty days of green reconciliation is what an agency will actually require before cutting over, so it is a first-class object with a UI, not an ops afterthought.

---

## 2. Delegated agent authorization — closing the transitive-A2A confused deputy

Every principal is a `user`, an `api_key`, or an `agent_session`. **An `agent_session` always names an `on_behalf_of` user** or is explicitly a service principal with independently granted scopes. There is no third, ambiguous state — which is what all three original designs left open.

**Effective scope is an intersection, never a union:**

```
effective = agent.policy_scopes ∩ delegator.scopes ∩ run.requested_scopes
```

Computed at session start, **re-validated on every call**, and checked against live principal state so revocation propagates into in-flight runs: each principal carries a `principal_version` bumped on any permission change, sessions record the version they were minted against, and the write seam rejects a commit whose session version is stale. An in-flight agent run therefore fails at its next write rather than completing with revoked authority.

**The delegation chain is explicit and monotonically narrowing.** Every issued token carries an RFC 8693 `act` actor chain and a `delegation_depth` (default max 1, hard cap 3). Each hop must satisfy `child.scopes ⊆ parent.scopes` — widening is rejected at mint time, not at use time.

**The confused deputy is closed by cycle detection.** When Backline delegates to external agent X, the minted token records the chain `[backline:tenant-42]`. If X calls back into Backline presenting a token whose chain already contains Backline's own principal, the request is **rejected**. That is the exact attack the review named, and it is four lines:

```ts
export function assertNoCycle(chain: PrincipalId[], self: PrincipalId): void {
  if (chain.includes(self)) throw new DelegationCycleError(chain, self);
}
```

**EGRESS and MONEY scopes are non-delegable.** They cannot appear in *any* downscoped token, at any depth. A fully compromised external agent holding a valid Backline token still cannot send a contract or approve a settlement — those require an interactive human approval row (§ below), and no token grants them.

**Consent is a row, not an assumption.** `agent_consent (user, agent, scopes, granted_at, revoked_at)`. No consent row → the agent cannot act on that user's behalf. Revocation is a write, so it propagates through the same `principal_version` mechanism.

---

## 3. Stored prompt injection — a trust label that survives the round trip

Every string that can enter an agent's context carries a `trust` label:

| Label | Sources |
|---|---|
| `SYSTEM` | Our own instructions and templates |
| `OPERATOR` | Text typed by an authenticated staff user |
| `UNTRUSTED` | Email bodies, web fetches, MusicBrainz, counterparty contract text, **and agent-authored content** |

**The critical line is the last one.** Because the write seam records the authoring principal on every write, the labeller can derive it mechanically:

```ts
// An agent's own note is untrusted input to the next agent.
if (record.author_principal_kind === "agent_session") return Trust.UNTRUSTED;
```

That single derivation closes the stored-injection path the review identified — an agent writing a note containing instructions that a later agent reads as context — and it is only possible because provenance is captured at write time rather than reconstructed.

**The context assembler cannot emit untrusted text unfenced.** `buildContext()` is the only way text reaches a model. Untrusted content is wrapped with a provenance header and an explicit data-not-instructions framing; the assembler refuses to emit an untrusted chunk that has not been through the fencer. Trust labels ride along with retrieval results so the UI can show, and the agent can cite, where a claim came from.

**Output side.** Before any EGRESS operation the payload is scanned for credential-shaped strings, for `crm://` references the run had no read scope for (an exfiltration canary), and for recipients outside the run's declared recipient set. EGRESS already requires human approval; this check makes the approval *informed* — the human sees a diff and the canary findings rather than a yes/no button.

---

## 4. Partner-runtime interop — emitters, not integrations

"Interoperable with all agentic frameworks" collapsed to "we ship MCP" in all three designs. The fix is structural: because every capability is already a registry entry with input/output schemas, scopes, and annotations, **each partner runtime is one emitter file**, not a project.

| Target | Emitter output |
|---|---|
| **Salesforce Agentforce** | OpenAPI 3.0 + External Service / Named Credential descriptor (Agentforce builds actions from OpenAPI) |
| **HubSpot Breeze** | Custom-action manifest + the OpenAPI subset it consumes |
| **monday AI blocks** | App manifest with action definitions pointing at the same routes |
| **AG-UI** | Event-stream adapter (the workspace already carries `ag-ui/` in this repo) |
| **LangChain / LlamaIndex** | Generated tool packages |
| **OpenAI Responses** | Tool definitions in Responses format |
| **Zapier / Make** | One generic `POST /v1/hooks/{operationId}` with HMAC verification and flat-body mapping |

Adding a partner is `emitters/<partner>.ts` plus a CI drift assertion. **The direction that matters commercially — being callable *inside* Agentforce, Breeze, and monday's runtimes rather than only syncing records outward — becomes near-free**, which is precisely why it should never have been omitted.

---

## 5. Metering and unit economics — at the seam, not bolted on

The write seam is the only mutation path, so it is the only place metering has to exist. Every `commit()` and every model call emits a `usage_event (tenant, principal, operation, tokens_in, tokens_out, cost_micros, duration_ms)`. Budget is checked **before** the operation and recorded **after**, so a budget exhausted mid-settlement fails the *next* step visibly rather than half-completing — the lumen degrade-visibly rule.

Stated pricing model: per-seat base plus metered agent-run units, with registry-agent compute attributed to the tenant that installed the agent. This has to be decided now because it determines who pays for a runaway agent — and that answer must be in the schema before the first customer, not after.

---

## 6. Offline — bounded honestly

No CRDT. The mobile client caches reads and queues **operation invocations** (not row mutations) with idempotency keys. On reconnect they replay through the same seam; anything that no longer applies surfaces as a conflict in the existing approval queue. A tour manager settling a show in a basement at 1am gets their work queued and reconciled — not silently merged.

## 7. Multi-currency, withholding, and the immutability contradiction

`fx_snapshot` captured at settlement approval; `currency_of_record` distinct from `settlement_currency`; withholding and VAT as `settlement_line` kinds rather than scalar fields, so treaty reductions and reverse-charge are line items with their own provenance.

The review caught a real contradiction: *settlements are immutable after approval*, yet retroactive FX and withholding corrections are routine. The resolution is an **amendment chain** — an approved settlement is never mutated; a correction creates a linked `settlement_amendment` referencing the original, and the effective figure is the fold over the chain. History stays intact and corrections are possible.

## 8. Markdown Preview as a workspace item, not a panel

All three designs modelled the preview as a side panel and silently dropped Zed's tab semantics. The router models it as a real workspace item: `activateOrAddPreview` (reuse an existing preview rather than opening a second), open-to-the-side, close-and-return-to-editor, keyboard scroll actions, `maxContentWidth`, and the **coexistence rule** that a singleton Follow-mode view lives alongside per-document Default previews.

## 9. Registry credential capture — the split-state UX

`agent_credential (agent_id, scope: tenant|user, principal_id, status)`. OAuth callbacks route on `state = {tenant, agent, user}`. Because status is per (agent, principal), the panel can render the state that actually occurs in a team — **"installed and healthy for Alice, unauthenticated for Bob"** — which no design described.

## 10. Agent-behaviour evaluation harness

`evals/` holds golden transcripts, **refusal regressions** (assert the agent still declines to auto-approve a settlement after a prompt or model change), and MCP client-conformance fixtures replaying the real parameter manglings of Claude Desktop, Cursor, and Copilot. Code tests prove the code works; these prove the *product* works, and they gate model upgrades.

## 12. Dedupe as a first-class workflow

`match_candidate` + `merge_log` with field-level survivorship, exposed as `crm_find_duplicates` (read) and `crm_merge_records` (destructive, approval-gated), feeding the **same human review queue** as unmatched email and import survivorship. This is the highest-value obvious agent task in any CRM and all three designs left it out.
