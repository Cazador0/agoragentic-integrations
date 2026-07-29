/**
 * Delegated agent authorization (gap 3).
 *
 * The review found that none of the three designs answered whether an agent
 * acts *as* a user or *as itself*, and that all three therefore enabled a
 * transitive-A2A confused deputy: Backline delegates to external agent X, X
 * calls back into Backline, and nobody decides whose scopes apply.
 *
 * This module makes the answer explicit and mechanical:
 *   - effective scope is an INTERSECTION, never a union
 *   - every hop must narrow (RFC 8693 `act` chain, monotonically decreasing)
 *   - MONEY and EGRESS are non-delegable at any depth
 *   - a chain that re-enters its own issuer is rejected (the confused deputy)
 */

import { NON_DELEGABLE_SCOPES, Scope } from "./scopes.js";

export type PrincipalId = string;

export const PrincipalKind = {
  USER: "user",
  API_KEY: "api_key",
  AGENT_SESSION: "agent_session",
  SERVICE: "service",
} as const;
export type PrincipalKind = (typeof PrincipalKind)[keyof typeof PrincipalKind];

export interface Principal {
  readonly id: PrincipalId;
  readonly kind: PrincipalKind;
  readonly tenantId: string;
  readonly scopes: readonly Scope[];
  /**
   * Bumped on any permission change. A session minted against an older version
   * is rejected by the write seam, so revocation reaches in-flight agent runs
   * instead of taking effect only at the next login.
   */
  readonly version: number;
  /**
   * An agent session always names the user it acts for, or is explicitly a
   * SERVICE principal with independently granted scopes. There is no third,
   * ambiguous state — which is precisely what the reviewed designs left open.
   */
  readonly onBehalfOf?: PrincipalId;
}

/** RFC 8693-style actor chain entry. */
export interface ActorChainEntry {
  readonly principalId: PrincipalId;
  readonly kind: PrincipalKind;
}

export interface DelegatedToken {
  readonly subject: PrincipalId;
  readonly tenantId: string;
  readonly scopes: readonly Scope[];
  /** Ordered issuer chain, oldest first. RFC 8693 `act`. */
  readonly chain: readonly ActorChainEntry[];
  readonly delegationDepth: number;
  /** Version of the delegating principal this token was minted against. */
  readonly delegatorVersion: number;
  readonly expiresAt: Date;
}

export const DEFAULT_MAX_DELEGATION_DEPTH = 1;
export const HARD_MAX_DELEGATION_DEPTH = 3;

export class DelegationError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "DelegationError";
  }
}

export class DelegationCycleError extends DelegationError {
  constructor(
    readonly chain: readonly ActorChainEntry[],
    readonly self: PrincipalId,
  ) {
    super(
      `Delegation cycle: principal ${self} already appears in the actor chain ` +
        `[${chain.map((c) => c.principalId).join(" -> ")}]. Refusing to act as ` +
        `deputy for a chain that re-enters this issuer.`,
      "DELEGATION_CYCLE",
    );
    this.name = "DelegationCycleError";
  }
}

/**
 * The confused-deputy check. Called on every inbound request that presents a
 * delegated token, before any scope is honoured.
 */
export function assertNoCycle(chain: readonly ActorChainEntry[], self: PrincipalId): void {
  if (chain.some((entry) => entry.principalId === self)) {
    throw new DelegationCycleError(chain, self);
  }
}

/** Set intersection preserving the canonical scope order. */
export function intersectScopes(...sets: readonly (readonly Scope[])[]): Scope[] {
  if (sets.length === 0) return [];
  const [first, ...rest] = sets;
  return (first ?? []).filter((scope) => rest.every((set) => set.includes(scope)));
}

/**
 * Effective scope for an agent run.
 *
 *   effective = agent policy ∩ delegator ∩ requested
 *
 * An intersection can only shrink, so no combination of a permissive agent
 * policy and a permissive request can exceed what the delegating human holds.
 */
export function effectiveScopes(input: {
  agentPolicyScopes: readonly Scope[];
  delegatorScopes: readonly Scope[];
  requestedScopes: readonly Scope[];
}): Scope[] {
  return intersectScopes(input.agentPolicyScopes, input.delegatorScopes, input.requestedScopes);
}

export interface MintOptions {
  readonly issuer: Principal;
  readonly subject: PrincipalId;
  readonly requestedScopes: readonly Scope[];
  readonly parent?: DelegatedToken;
  readonly maxDepth?: number;
  readonly ttlSeconds?: number;
  readonly now?: Date;
}

/**
 * Mint a downscoped delegated token.
 *
 * Rejects at mint time (not at use time) if the request would widen scope,
 * exceed depth, include a non-delegable scope, or create a cycle.
 */
export function mintDelegatedToken(options: MintOptions): DelegatedToken {
  const {
    issuer,
    subject,
    requestedScopes,
    parent,
    maxDepth = DEFAULT_MAX_DELEGATION_DEPTH,
    ttlSeconds = 900,
    now = new Date(),
  } = options;

  const effectiveMaxDepth = Math.min(maxDepth, HARD_MAX_DELEGATION_DEPTH);
  const parentChain = parent?.chain ?? [];

  assertNoCycle(parentChain, issuer.id);

  const depth = (parent?.delegationDepth ?? 0) + 1;
  if (depth > effectiveMaxDepth) {
    throw new DelegationError(
      `Delegation depth ${depth} exceeds maximum ${effectiveMaxDepth}.`,
      "DELEGATION_DEPTH_EXCEEDED",
    );
  }

  const ceiling = parent ? parent.scopes : issuer.scopes;
  const widened = requestedScopes.filter((scope) => !ceiling.includes(scope));
  if (widened.length > 0) {
    throw new DelegationError(
      `Delegation may not widen scope. Requested [${widened.join(", ")}] not held by issuer.`,
      "DELEGATION_WIDENS_SCOPE",
    );
  }

  // MONEY and EGRESS never ride in a token. They require an interactive human
  // approval row, so a fully compromised downstream agent still cannot send a
  // contract or approve a settlement with a stolen token.
  const forbidden = requestedScopes.filter((scope) => NON_DELEGABLE_SCOPES.includes(scope));
  if (forbidden.length > 0) {
    throw new DelegationError(
      `Scopes [${forbidden.join(", ")}] are non-delegable and cannot appear in a delegated token.`,
      "DELEGATION_NON_DELEGABLE_SCOPE",
    );
  }

  return {
    subject,
    tenantId: issuer.tenantId,
    scopes: [...requestedScopes],
    chain: [...parentChain, { principalId: issuer.id, kind: issuer.kind }],
    delegationDepth: depth,
    delegatorVersion: issuer.version,
    expiresAt: new Date(now.getTime() + ttlSeconds * 1000),
  };
}

/**
 * Validate a presented token against live principal state.
 *
 * `currentDelegatorVersion` comes from the database at request time, so a
 * permission change or offboarding invalidates tokens already in flight.
 */
export function assertTokenUsable(
  token: DelegatedToken,
  self: PrincipalId,
  currentDelegatorVersion: number,
  now: Date = new Date(),
): void {
  assertNoCycle(token.chain, self);
  if (token.expiresAt.getTime() <= now.getTime()) {
    throw new DelegationError("Delegated token has expired.", "DELEGATION_EXPIRED");
  }
  if (token.delegatorVersion !== currentDelegatorVersion) {
    throw new DelegationError(
      `Delegating principal's permissions changed (token v${token.delegatorVersion}, ` +
        `current v${currentDelegatorVersion}). Re-consent required.`,
      "DELEGATION_STALE_PRINCIPAL",
    );
  }
}
