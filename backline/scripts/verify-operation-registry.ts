/**
 * Registry hygiene gate.
 *
 * Modelled on agoragentic-integrations' verify-integrations-json.js. The
 * canonical-tool-ID contract is only worth having if something enforces it, so
 * this runs in CI and fails the build on drift.
 */

import {
  listOperations,
  Scope,
  type AnyOperation,
} from "../packages/domain/dist/index.js";
import { emitAll } from "../packages/emitters/dist/index.js";
import { toolFor } from "../packages/mcp/dist/index.js";
import { buildAgentCard, buildOpenApi } from "../packages/api/dist/index.js";

const failures: string[] = [];
const fail = (message: string): void => void failures.push(message);

const operations = listOperations();
if (operations.length === 0) fail("Registry is empty.");

const seenRestBindings = new Map<string, string>();

for (const operation of operations) {
  const where = `operation ${operation.id}`;

  if (!/^crm_[a-z0-9_]+$/.test(operation.id)) fail(`${where}: id must match crm_[a-z0-9_]+`);
  if (operation.scopes.length === 0) fail(`${where}: declares no scopes (fail-closed requires one)`);

  // Descriptions are read by models, not humans. A one-liner is a defect.
  if (operation.description.length < 80) {
    fail(`${where}: description is ${operation.description.length} chars; agents need idempotency, side effects and error shapes stated.`);
  }

  // Money and egress must never be reachable without a persisted approval.
  const sensitive = operation.scopes.some((scope) => scope === Scope.MONEY || scope === Scope.EGRESS);
  if (sensitive && operation.confirmRequired !== true) {
    fail(`${where}: declares ${operation.scopes.join("/")} but confirmRequired is not true.`);
  }

  // Annotation coherence.
  if (operation.annotations.readOnlyHint && !operation.scopes.every((s) => s === Scope.READ || s === Scope.INSPECT)) {
    fail(`${where}: readOnlyHint is true but it requests write-capable scopes.`);
  }
  if (!operation.annotations.readOnlyHint && operation.scopes.every((s) => s === Scope.READ || s === Scope.INSPECT)) {
    fail(`${where}: requests only read scopes but is not marked readOnlyHint.`);
  }

  const binding = `${operation.rest.method} ${operation.rest.path}`;
  const existing = seenRestBindings.get(binding);
  if (existing) fail(`${where}: REST binding "${binding}" collides with ${existing}.`);
  else seenRestBindings.set(binding, operation.id);
}

/* --------- every surface must project every operation, or explain itself --- */

const openApi = buildOpenApi() as { paths: Record<string, Record<string, unknown>> };
const openApiOperationIds = new Set<string>();
for (const methods of Object.values(openApi.paths)) {
  for (const entry of Object.values(methods)) {
    openApiOperationIds.add((entry as { operationId: string }).operationId);
  }
}
for (const operation of operations) {
  if (!openApiOperationIds.has(operation.id)) fail(`${operation.id} is missing from the OpenAPI projection.`);
}

const mcpNames = new Set(operations.map((operation: AnyOperation) => toolFor(operation).name));
for (const operation of operations) {
  if (!mcpNames.has(operation.id)) fail(`${operation.id} is missing from the MCP projection.`);
}

const card = buildAgentCard() as { skills: { id: string }[] };
const declaredSkills = operations.filter((operation) => operation.a2aSkill).map((operation) => operation.a2aSkill);
if (card.skills.length !== declaredSkills.length) {
  fail(`A2A card advertises ${card.skills.length} skills but ${declaredSkills.length} are declared.`);
}

// Partner emitters must never leak a MONEY or EGRESS operation into a
// third-party runtime, where our approval UX does not exist.
const sensitiveIds = new Set(
  operations
    .filter((operation) => operation.scopes.some((s) => s === Scope.MONEY || s === Scope.EGRESS))
    .map((operation) => operation.id),
);
for (const output of emitAll("https://example.test")) {
  // First-party surfaces (our own UI render hints) legitimately reference
  // sensitive operations — that is how the approval modal gets wired.
  if (output.surface !== "partner") continue;
  const serialized = JSON.stringify(output.body);
  for (const id of sensitiveIds) {
    if (serialized.includes(id)) {
      fail(`Emitter ${output.filename} exposes ${id}, which requires an in-product human approval.`);
    }
  }
}

if (failures.length > 0) {
  console.error(`Registry verification FAILED with ${failures.length} problem(s):`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(`Registry OK: ${operations.length} operations project cleanly to REST, OpenAPI, MCP, A2A and 7 partner runtimes.`);
