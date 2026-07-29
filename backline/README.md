# Backline

Scaffold for an agentic CRM for music management and booking agencies.

This implements the **hybrid recommendation** from
[`../deliverables/2026-07-27-agentic-crm-architecture.md`](../deliverables/2026-07-27-agentic-crm-architecture.md):
Solution B's contract mechanism, Solution C's domain and safety model, Solution
A's deployment discipline — on Node rather than Bun, with `tenant_id` + Postgres
RLS rather than schema-per-tenant.

It also closes the twelve cross-cutting gaps the adversarial review found in all
three candidate designs. See [`docs/GAP-CLOSURES.md`](docs/GAP-CLOSURES.md).

## Quick start

```bash
npm install
npm run check          # typecheck + registry drift gate + 56 tests

# Optional: apply the schema to a real Postgres and watch the constraints fire
docker compose up -d postgres
psql "$DATABASE_URL" -f packages/db/migrations/0001_init.sql

npm run emit           # generate all partner-runtime descriptors
```

## The two chokepoints

Everything here rests on two places, and that is deliberate — eleven of the
twelve gaps closed at one of them.

**1. The write seam** (`packages/services/src/seam.ts`). `commit()` is the only
path through which any record changes. Enforced there, once: permission
resolution, live principal-version checks so revocation reaches in-flight agent
runs, human approval as a durable row, provenance capture, metering, and the
record-before-act ledger append. Validators *block but never rewrite*, so what
an agent proposed is byte-for-byte what lands.

**2. The operation registry** (`packages/domain/src/registry.ts`). A capability
is declared once and projected into REST, OpenAPI, MCP, A2A, and seven partner
runtimes. Adding a partner is an emitter function, not a project.

```
                        ┌──────────────────────┐
                        │  operation registry  │  18 crm_* operations
                        └──────────┬───────────┘
             ┌──────────┬──────────┼──────────┬──────────────┐
          REST      OpenAPI       MCP        A2A        emitters/
        (Hono)    (3.1 spec)   (tools)    (skills)   Agentforce, Breeze,
                                                     monday, OpenAI,
                                                     LangChain, AG-UI, Zapier
```

`npm run verify:registry` fails the build if any surface drifts, if a
MONEY/EGRESS operation is missing its approval gate, or if a partner emitter
would expose an operation whose approval UX does not exist over there.

## Layout

| Package | Contents |
|---|---|
| `packages/domain` | Scopes and the permission matrix, delegation, trust labels, money, `crm://` URIs, entity schemas, the operation registry, the operations |
| `packages/db` | SQL migration: RLS, exclusion constraints, immutability triggers, append-only ledger |
| `packages/services` | The write seam, hold-ladder etiquette |
| `packages/api` | REST head + OpenAPI + A2A agent card, projected from the registry |
| `packages/mcp` | MCP head: tools, annotations, server instructions, agent-argument coercion |
| `packages/connectors` | Connector capability interfaces; email association, ICS feed, migration and parallel-run reconciliation |
| `packages/emitters` | Partner-runtime descriptors |
| `evals/adoption` | **The adoption gate** (see below) |

## Three things worth knowing before you change anything

**The adoption gate is load-bearing.** `evals/adoption/timeline.gate.test.ts`
asserts that a booking's activity timeline populates from ingested mail, that
the ICS feed renders, and that parallel-run reconciliation reports drift. The
agent-platform packages are gated on it in CI. The review's most consequential
finding was that all three designs sequenced email, calendar, and migration
*after* the agent platform, which is the classic way CRM rollouts die. Deleting
this gate re-opens that failure mode; treat it like deleting an auth check.

**MONEY and EGRESS are never ALLOW.** `assertNeverAllowInvariant()` runs at
module load and the process refuses to start if the matrix is edited to permit
an autonomous contract send. They are also non-delegable: they cannot appear in
any delegated token at any depth, so a fully compromised downstream agent still
cannot send an offer or approve a settlement.

**RLS is inert for a superuser, silently.** Verified while building this: with
`FORCE ROW LEVEL SECURITY` set and every policy in place, a superuser still
reads across tenants and nothing is raised. The migration therefore creates a
`backline_app` role and `assert_rls_enforced()`, which the connection pool calls
on every checkout and which fails closed. Connecting as the bootstrap role makes
the entire tenancy guarantee fiction.

## What is real and what is a seam

Real and tested: the permission matrix and its invariant, the delegation chain
including the transitive-A2A cycle rejection, trust labelling and the egress
scanner, ISRC/ISWC validation with check digits, integer-minor-unit money, the
hold ladder including venue-local expiry, the write seam's full gate sequence,
the SQL schema and all its constraints (applied and verified against Postgres
17), the registry drift gate, and all seven emitters.

Seams with interfaces but no implementation yet: the actual Salesforce/HubSpot/
monday connectors, the IMAP/Graph/Gmail readers behind `associateMessage`, the
web UI (including the Agent Registry panel and Markdown Preview described in
the architecture doc §2), and the Postgres-backed `SeamTransaction`. The
handlers map in `packages/api` is intentionally empty — the routes project from
the registry, and each operation is wired as its service lands.

## Provenance

Patterns ported from the 16 repositories researched in the architecture
document: the layering rule from `notebooklm-mcp-cli`, the permission matrix
and write seam from `lumen`, the property/association/journal model and
retry discipline from `hubspot-sdk-typescript`, describe-driven schema and
external-ID upsert from `simple-salesforce`, tool annotations, elicitation and
server instructions from `mcp-servers`, `RunContext` and deferred tools from
`pydantic-ai`, connector capability interfaces from `onyx`, and the registry
manifest, canonical tool-ID contract and governance policy packet from
`agoragentic-integrations` itself.

Zed is GPL-3.0. Everything taken from it is pattern-level porting — the Agent
Registry mechanics and Markdown Preview source-offset sync described in the
architecture document. No Zed code is copied here, and that boundary must be
policed in review.
