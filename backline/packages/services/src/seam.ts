/**
 * The write seam.
 *
 * Every mutation in the system passes through `commit()`. That is the whole
 * point: it is the one place where things that must be true of *all* writes are
 * enforced, rather than re-implemented per call site and forgotten in one.
 *
 * Enforced here, once:
 *   - permission resolution against the Mode x Scope matrix       (gap: safety)
 *   - live principal-version check, so revocation reaches         (gap 3)
 *     in-flight agent runs
 *   - human approval as a persisted row, never an in-memory       (Zed port)
 *     oneshot channel
 *   - provenance capture, which is what makes the trust           (gap 4)
 *     labeller able to derive UNTRUSTED for agent-authored content
 *   - metering, because the seam is the only mutation path        (gap 5)
 *   - record-before-act ledger append                             (lumen)
 *
 * Validators BLOCK but never rewrite (lumen's FileSystemTool rule): what the
 * agent proposed is byte-for-byte what lands, which is what makes agent writes
 * reviewable.
 */

import {
  ApprovalRequiredError,
  Decision,
  ErrorCode,
  PrincipalKind,
  ServiceError,
  assertTokenUsable,
  resolveAll,
  type AnyOperation,
  type ContentOrigin,
  type Mode,
  type Principal,
  type DelegatedToken,
  type Scope,
} from "@backline/domain";

export interface RunContext {
  readonly tenantId: string;
  readonly principal: Principal;
  readonly mode: Mode;
  /** Scopes effective for this run: agent policy ∩ delegator ∩ requested. */
  readonly scopes: readonly Scope[];
  readonly requestId: string;
  readonly idempotencyKey?: string;
  /** Present when the caller arrived through delegation. */
  readonly delegatedToken?: DelegatedToken;
  /** Agent session id, when the actor is an agent. Drives provenance. */
  readonly agentSessionId?: string;
  readonly now?: Date;
}

export interface Mutation<TResult> {
  readonly operation: AnyOperation;
  readonly objectType: string;
  readonly recordId?: string;
  /** Serialisable description of intent, written to the ledger BEFORE the act. */
  readonly intent: Record<string, unknown>;
  /** Origin label for anything this mutation writes as free text. */
  readonly contentOrigin?: ContentOrigin;
  /** Pure validators. Return an error string to block; never mutate input. */
  readonly validators?: readonly ((intent: Record<string, unknown>) => string | null)[];
  /** The actual effect. Runs only after every gate has passed. */
  readonly apply: (tx: SeamTransaction) => Promise<TResult>;
}

/** Narrow port so the seam is testable without a database. */
export interface SeamTransaction {
  appendEvent(event: LedgerEvent): Promise<string>;
  recordProvenance(entry: ProvenanceEntry): Promise<void>;
  recordUsage(entry: UsageEvent): Promise<void>;
  createApproval(entry: ApprovalRequest): Promise<string>;
  findApproval(approvalId: string): Promise<ApprovalRecord | null>;
  currentPrincipalVersion(principalId: string): Promise<number>;
  isHandCurated(objectType: string, recordId: string): Promise<boolean>;
  remainingBudgetMicros(tenantId: string): Promise<number | null>;
}

export interface LedgerEvent {
  readonly tenantId: string;
  readonly principalId: string;
  readonly operationId: string;
  readonly objectType: string;
  readonly recordId: string | undefined;
  readonly intent: Record<string, unknown>;
  readonly occurredAt: Date;
}

export interface ProvenanceEntry {
  readonly tenantId: string;
  readonly objectType: string;
  readonly recordId: string | undefined;
  readonly authorPrincipalId: string;
  readonly authorPrincipalKind: PrincipalKind;
  readonly origin: ContentOrigin | undefined;
  readonly agentSessionId: string | undefined;
  readonly occurredAt: Date;
}

export interface UsageEvent {
  readonly tenantId: string;
  readonly principalId: string;
  readonly operationId: string;
  readonly costMicros: number;
  readonly durationMs: number;
  readonly occurredAt: Date;
}

export interface ApprovalRequest {
  readonly tenantId: string;
  readonly operationId: string;
  readonly requestedByPrincipalId: string;
  readonly intent: Record<string, unknown>;
  readonly expiresAt: Date;
}

export interface ApprovalRecord {
  readonly approvalId: string;
  readonly status: "pending" | "allowed" | "denied" | "expired";
}

export interface CommitOptions {
  /** Resolved approval id, when re-entering after a human decided. */
  readonly approvalId?: string;
  readonly approvalTtlSeconds?: number;
  readonly costMicros?: number;
}

/**
 * The single mutation entry point.
 *
 * Ordering is deliberate: cheap refusals first, ledger append before the act,
 * usage recorded after. A budget exhausted mid-run therefore fails the *next*
 * step visibly rather than half-completing.
 */
export async function commit<TResult>(
  ctx: RunContext,
  tx: SeamTransaction,
  mutation: Mutation<TResult>,
  options: CommitOptions = {},
): Promise<TResult> {
  const now = ctx.now ?? new Date();
  const startedAt = Date.now();
  const { operation } = mutation;

  // 1. Tenant isolation. Belt and braces alongside Postgres RLS.
  if (ctx.principal.tenantId !== ctx.tenantId) {
    throw new ServiceError(ErrorCode.PERMISSION_DENIED, "Principal does not belong to this tenant.");
  }

  // 2. Delegation: cycle, expiry, and staleness against live principal state.
  //    This is what makes revocation reach a run that is already in flight.
  if (ctx.delegatedToken) {
    const currentVersion = await tx.currentPrincipalVersion(ctx.delegatedToken.subject);
    assertTokenUsable(ctx.delegatedToken, ctx.principal.id, currentVersion, now);
  }

  // 3. The operation's declared scopes must all be held by this run.
  const missing = operation.scopes.filter((scope) => !ctx.scopes.includes(scope));
  if (missing.length > 0) {
    throw new ServiceError(
      ErrorCode.PERMISSION_DENIED,
      `Operation ${operation.id} requires scopes [${missing.join(", ")}] not held by this run.`,
      { hint: "Request a session with the required scopes, or ask a human operator to run it." },
    );
  }

  // 4. Mode x Scope. AUTONOMOUS + MONEY/EGRESS resolves to DENY, so an
  //    unattended agent cannot even queue a contract send for later approval.
  const decision = resolveAll(ctx.mode, operation.scopes);
  if (decision === Decision.DENY) {
    throw new ServiceError(
      ErrorCode.PERMISSION_DENIED,
      `Operation ${operation.id} is denied in ${ctx.mode} mode.`,
      { hint: "Re-run this operation in a supervised session where a human can approve it." },
    );
  }

  // 5. Consent gate: agents never overwrite hand-curated records.
  if (mutation.recordId && (await tx.isHandCurated(mutation.objectType, mutation.recordId))) {
    if (ctx.principal.kind === PrincipalKind.AGENT_SESSION) {
      throw new ServiceError(
        ErrorCode.PERMISSION_DENIED,
        `${mutation.objectType} ${mutation.recordId} is hand-curated and not agent-writable.`,
        { hint: "Propose the change as a note for a human to apply." },
      );
    }
  }

  // 6. Budget, checked before the spend rather than discovered after it.
  const remaining = await tx.remainingBudgetMicros(ctx.tenantId);
  const cost = options.costMicros ?? 0;
  if (remaining !== null && remaining < cost) {
    throw new ServiceError(
      ErrorCode.BUDGET_EXHAUSTED,
      `Tenant budget exhausted: ${remaining} micros remaining, ${cost} required.`,
      { hint: "Raise the tenant budget or wait for the next billing period." },
    );
  }

  // 7. Pure validators: block, never rewrite.
  for (const validate of mutation.validators ?? []) {
    const failure = validate(mutation.intent);
    if (failure) throw new ServiceError(ErrorCode.VALIDATION, failure);
  }

  // 8. Approval, as a durable row. GATE and confirmRequired both land here.
  const needsApproval = decision === Decision.GATE || operation.confirmRequired === true;
  if (needsApproval) {
    if (!options.approvalId) {
      const approvalId = await tx.createApproval({
        tenantId: ctx.tenantId,
        operationId: operation.id,
        requestedByPrincipalId: ctx.principal.id,
        intent: mutation.intent,
        expiresAt: new Date(now.getTime() + (options.approvalTtlSeconds ?? 86_400) * 1000),
      });
      throw new ApprovalRequiredError(approvalId, operation.id);
    }
    const approval = await tx.findApproval(options.approvalId);
    if (!approval) {
      throw new ServiceError(ErrorCode.NOT_FOUND, `Approval ${options.approvalId} not found.`);
    }
    // A timed-out approval resolves to denied. Silence is never consent.
    if (approval.status !== "allowed") {
      throw new ServiceError(
        ErrorCode.PERMISSION_DENIED,
        `Approval ${options.approvalId} is ${approval.status}, not allowed.`,
      );
    }
  }

  // 9. Record before act. A crash between here and the apply leaves an intent
  //    with no effect, which is recoverable; the reverse is not.
  await tx.appendEvent({
    tenantId: ctx.tenantId,
    principalId: ctx.principal.id,
    operationId: operation.id,
    objectType: mutation.objectType,
    recordId: mutation.recordId,
    intent: mutation.intent,
    occurredAt: now,
  });

  const result = await mutation.apply(tx);

  // 10. Provenance. Captured here so the trust labeller can later derive
  //     UNTRUSTED for anything an agent authored, closing stored injection.
  await tx.recordProvenance({
    tenantId: ctx.tenantId,
    objectType: mutation.objectType,
    recordId: mutation.recordId,
    authorPrincipalId: ctx.principal.id,
    authorPrincipalKind: ctx.principal.kind,
    origin: mutation.contentOrigin,
    agentSessionId: ctx.agentSessionId,
    occurredAt: now,
  });

  // 11. Metering, at the only place every mutation passes through.
  await tx.recordUsage({
    tenantId: ctx.tenantId,
    principalId: ctx.principal.id,
    operationId: operation.id,
    costMicros: cost,
    durationMs: Date.now() - startedAt,
    occurredAt: now,
  });

  return result;
}
