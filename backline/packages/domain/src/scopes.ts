/**
 * Mode x Scope permission matrix.
 *
 * Ported from lumen's `scrum/permissions.ts`. The load-bearing property is the
 * invariant at the bottom of this file: EGRESS and MONEY never resolve to ALLOW
 * in any mode. It is asserted at module load so a future edit to the table
 * cannot silently open the hole, and re-asserted by a unit test.
 */

export const Scope = {
  /** Read records. */
  READ: "READ",
  /** Read schema, describe, registry metadata. */
  INSPECT: "INSPECT",
  /** Mutate non-money CRM records. */
  WRITE: "WRITE",
  /** Run a tool that executes local computation (routing, enrichment). */
  EXEC: "EXEC",
  /** Move money or change a money-bearing record's approved state. */
  MONEY: "MONEY",
  /** Send anything outside the tenant boundary: email, contract, third-party write. */
  EGRESS: "EGRESS",
} as const;
export type Scope = (typeof Scope)[keyof typeof Scope];

export const ALL_SCOPES: readonly Scope[] = Object.values(Scope);

/**
 * Scopes that may never be granted to a non-interactive principal, at any
 * delegation depth. See `delegation.ts`.
 */
export const NON_DELEGABLE_SCOPES: readonly Scope[] = [Scope.MONEY, Scope.EGRESS];

export const Mode = {
  /** Human operator driving the UI. */
  INTERACTIVE: "INTERACTIVE",
  /** Agent running with a human watching the thread. */
  SUPERVISED: "SUPERVISED",
  /** Agent running unattended (scheduled job, background sweep). */
  AUTONOMOUS: "AUTONOMOUS",
} as const;
export type Mode = (typeof Mode)[keyof typeof Mode];

export const Decision = {
  ALLOW: "ALLOW",
  /** Permitted, but blocked pending a persisted human approval row. */
  GATE: "GATE",
  DENY: "DENY",
} as const;
export type Decision = (typeof Decision)[keyof typeof Decision];

type Matrix = Readonly<Record<Mode, Readonly<Record<Scope, Decision>>>>;

/**
 * The single source of truth. Read it as: "in this mode, an action needing this
 * scope is allowed outright / needs a human / is refused".
 */
const MATRIX: Matrix = {
  INTERACTIVE: {
    READ: Decision.ALLOW,
    INSPECT: Decision.ALLOW,
    WRITE: Decision.ALLOW,
    EXEC: Decision.ALLOW,
    // Even a human operator confirms money and egress explicitly. The gate is
    // what produces the audit row; without it there is no record of intent.
    MONEY: Decision.GATE,
    EGRESS: Decision.GATE,
  },
  SUPERVISED: {
    READ: Decision.ALLOW,
    INSPECT: Decision.ALLOW,
    WRITE: Decision.ALLOW,
    EXEC: Decision.ALLOW,
    MONEY: Decision.GATE,
    EGRESS: Decision.GATE,
  },
  AUTONOMOUS: {
    READ: Decision.ALLOW,
    INSPECT: Decision.ALLOW,
    WRITE: Decision.ALLOW,
    EXEC: Decision.ALLOW,
    // An unattended agent cannot queue a money/egress action for later approval
    // either: there is no one in the loop to approve it in-band.
    MONEY: Decision.DENY,
    EGRESS: Decision.DENY,
  },
} as const;

/** Pure resolution. Unknown mode or scope fails closed. */
export function resolve(mode: Mode, scope: Scope): Decision {
  const row = MATRIX[mode];
  if (!row) return Decision.DENY;
  return row[scope] ?? Decision.DENY;
}

/** Resolve a set of scopes to the most restrictive decision among them. */
export function resolveAll(mode: Mode, scopes: readonly Scope[]): Decision {
  let worst: Decision = Decision.ALLOW;
  for (const scope of scopes) {
    const decision = resolve(mode, scope);
    if (decision === Decision.DENY) return Decision.DENY;
    if (decision === Decision.GATE) worst = Decision.GATE;
  }
  return worst;
}

export class PermissionMatrixViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermissionMatrixViolation";
  }
}

/**
 * Defensive assertion, run at import time.
 *
 * The review's finding was that application-layer invariants are advisory
 * unless something structurally prevents their edit. This is that something:
 * if anyone ever sets MONEY or EGRESS to ALLOW in any mode, the process refuses
 * to start rather than quietly permitting an autonomous contract send.
 */
export function assertNeverAllowInvariant(matrix: Matrix = MATRIX): void {
  for (const mode of Object.values(Mode)) {
    for (const scope of NON_DELEGABLE_SCOPES) {
      if (matrix[mode][scope] === Decision.ALLOW) {
        throw new PermissionMatrixViolation(
          `Permission matrix invariant violated: ${mode} x ${scope} resolves to ALLOW. ` +
            `MONEY and EGRESS must always be GATE or DENY.`,
        );
      }
    }
  }
}

assertNeverAllowInvariant();
