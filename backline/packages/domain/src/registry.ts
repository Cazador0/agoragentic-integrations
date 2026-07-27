/**
 * The canonical operation registry.
 *
 * This is Solution B's one genuinely load-bearing idea, kept intact: a
 * capability is declared exactly once, and every surface — REST route, OpenAPI
 * path, MCP tool, A2A skill, SDK method, CLI subcommand, Agentforce action,
 * Breeze action, monday block, Zapier hook — is a *projection* of this
 * declaration.
 *
 * Two consequences worth being explicit about:
 *
 *   1. The headless requirement becomes free rather than a parallel
 *      implementation that drifts.
 *   2. "Interoperable with all agentic frameworks" becomes an emitter per
 *      partner (~1 file), not an integration project per partner. That is the
 *      gap-11 closure.
 *
 * `scripts/verify-operation-registry.ts` asserts the surfaces never drift.
 */

import type { z } from "zod";
import type { Scope } from "./scopes.js";

/** MCP tool annotations (mcp-servers' four-hint discipline, applied to all). */
export interface ToolAnnotations {
  /** No observable side effects. */
  readonly readOnlyHint: boolean;
  /** May overwrite or remove existing data. */
  readonly destructiveHint: boolean;
  /** Repeating with identical args has no additional effect. */
  readonly idempotentHint: boolean;
  /** Touches systems outside this database. */
  readonly openWorldHint: boolean;
}

export type HttpMethod = "GET" | "POST" | "PATCH" | "DELETE";

export interface RestBinding {
  readonly method: HttpMethod;
  /** Hono-style path with `:param` segments. */
  readonly path: string;
}

export interface OperationDefinition<TInput extends z.ZodTypeAny, TOutput extends z.ZodTypeAny> {
  /** Canonical id. Must match `crm_[a-z0-9_]+`. */
  readonly id: string;
  readonly summary: string;
  /**
   * Written for a model, not a human: state idempotency, side effects, and the
   * error shapes explicitly. agoragentic's fallback-tool descriptions are the
   * reference for this discipline.
   */
  readonly description: string;
  readonly input: TInput;
  readonly output: TOutput;
  readonly scopes: readonly Scope[];
  readonly annotations: ToolAnnotations;
  readonly rest: RestBinding;
  /** Exposed as an A2A skill under this name, when set. */
  readonly a2aSkill?: string;
  /** Long-running: projected as a pollable task rather than a blocking call. */
  readonly longRunning?: boolean;
  /**
   * Requires a persisted human approval row before the effect lands. Enforced
   * in the services layer, never per head — notebooklm's SKILL.md rule 4
   * documents the drift bug you get otherwise.
   */
  readonly confirmRequired?: boolean;
}

export type AnyOperation = OperationDefinition<z.ZodTypeAny, z.ZodTypeAny>;

const OPERATION_ID_PATTERN = /^crm_[a-z0-9_]+$/;

export class RegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegistryError";
  }
}

const registry = new Map<string, AnyOperation>();

/**
 * Declare an operation. Validates the declaration itself, because a registry
 * whose entries can be malformed is not a contract.
 */
export function defineOperation<TInput extends z.ZodTypeAny, TOutput extends z.ZodTypeAny>(
  definition: OperationDefinition<TInput, TOutput>,
): OperationDefinition<TInput, TOutput> {
  if (!OPERATION_ID_PATTERN.test(definition.id)) {
    throw new RegistryError(
      `Operation id "${definition.id}" must match ${OPERATION_ID_PATTERN} (canonical crm_* prefix).`,
    );
  }
  if (registry.has(definition.id)) {
    throw new RegistryError(`Duplicate operation id "${definition.id}".`);
  }
  if (definition.scopes.length === 0) {
    throw new RegistryError(`Operation "${definition.id}" declares no scopes; fail-closed requires at least one.`);
  }
  if (definition.annotations.readOnlyHint && definition.annotations.destructiveHint) {
    throw new RegistryError(`Operation "${definition.id}" cannot be both readOnly and destructive.`);
  }
  if (definition.annotations.readOnlyHint && definition.confirmRequired) {
    throw new RegistryError(`Operation "${definition.id}" is readOnly but requires confirmation.`);
  }
  registry.set(definition.id, definition as AnyOperation);
  return definition;
}

export function getOperation(id: string): AnyOperation {
  const operation = registry.get(id);
  if (!operation) throw new RegistryError(`Unknown operation "${id}".`);
  return operation;
}

export function listOperations(): AnyOperation[] {
  return [...registry.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function hasOperation(id: string): boolean {
  return registry.has(id);
}

/** Test-only. Never call from application code. */
export function __resetRegistryForTests(): void {
  registry.clear();
}
