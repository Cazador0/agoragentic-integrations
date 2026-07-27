import { describe, expect, it, vi } from "vitest";
import {
  ApprovalRequiredError, ContentOrigin, Mode, PrincipalKind, Scope, ServiceError,
  crmApproveSettlement, crmPlaceHold, crmSearch, type Principal,
} from "@backline/domain";
import { commit, type RunContext, type SeamTransaction } from "../seam.js";

function fakeTx(overrides: Partial<SeamTransaction> = {}): SeamTransaction {
  return {
    appendEvent: vi.fn(async () => "1"),
    recordProvenance: vi.fn(async () => undefined),
    recordUsage: vi.fn(async () => undefined),
    createApproval: vi.fn(async () => "approval-1"),
    findApproval: vi.fn(async () => ({ approvalId: "approval-1", status: "pending" as const })),
    currentPrincipalVersion: vi.fn(async () => 1),
    isHandCurated: vi.fn(async () => false),
    remainingBudgetMicros: vi.fn(async () => null),
    ...overrides,
  };
}

const user: Principal = {
  id: "u1", kind: PrincipalKind.USER, tenantId: "t1",
  scopes: [Scope.READ, Scope.WRITE, Scope.MONEY], version: 1,
};

const agent: Principal = {
  id: "a1", kind: PrincipalKind.AGENT_SESSION, tenantId: "t1",
  scopes: [Scope.READ, Scope.WRITE], version: 1, onBehalfOf: "u1",
};

const ctx = (principal: Principal, mode: Mode, scopes: readonly Scope[]): RunContext => ({
  tenantId: "t1", principal, mode, scopes, requestId: "r1",
});

describe("write seam", () => {
  it("appends intent to the ledger BEFORE applying the effect", async () => {
    const order: string[] = [];
    const tx = fakeTx({
      appendEvent: vi.fn(async () => { order.push("ledger"); return "1"; }),
    });
    await commit(ctx(user, Mode.INTERACTIVE, [Scope.WRITE]), tx, {
      operation: crmPlaceHold, objectType: "hold", intent: { level: 1 },
      apply: async () => { order.push("apply"); return { ok: true }; },
    });
    expect(order).toEqual(["ledger", "apply"]);
  });

  it("records provenance and usage for every mutation", async () => {
    const tx = fakeTx();
    await commit(ctx(agent, Mode.SUPERVISED, [Scope.WRITE]), tx, {
      operation: crmPlaceHold, objectType: "hold", intent: {},
      contentOrigin: ContentOrigin.AGENT_OUTPUT,
      apply: async () => ({ ok: true }),
    });
    expect(tx.recordProvenance).toHaveBeenCalledWith(
      expect.objectContaining({ authorPrincipalKind: PrincipalKind.AGENT_SESSION }),
    );
    expect(tx.recordUsage).toHaveBeenCalledOnce();
  });

  it("refuses an operation whose scopes the run does not hold", async () => {
    await expect(
      commit(ctx(agent, Mode.SUPERVISED, [Scope.READ]), fakeTx(), {
        operation: crmPlaceHold, objectType: "hold", intent: {},
        apply: async () => ({ ok: true }),
      }),
    ).rejects.toThrow(/requires scopes \[WRITE\]/);
  });

  it("raises APPROVAL_REQUIRED for money instead of applying it", async () => {
    const apply = vi.fn(async () => ({ ok: true }));
    await expect(
      commit(ctx(user, Mode.INTERACTIVE, [Scope.MONEY]), fakeTx(), {
        operation: crmApproveSettlement, objectType: "settlement", intent: {}, apply,
      }),
    ).rejects.toThrow(ApprovalRequiredError);
    expect(apply).not.toHaveBeenCalled();
  });

  it("denies money outright to an unattended agent, with no approval queued", async () => {
    const tx = fakeTx();
    await expect(
      commit(ctx(user, Mode.AUTONOMOUS, [Scope.MONEY]), tx, {
        operation: crmApproveSettlement, objectType: "settlement", intent: {},
        apply: async () => ({ ok: true }),
      }),
    ).rejects.toThrow(/denied in AUTONOMOUS mode/);
    expect(tx.createApproval).not.toHaveBeenCalled();
  });

  it("refuses to proceed on a pending or denied approval", async () => {
    for (const status of ["pending", "denied", "expired"] as const) {
      await expect(
        commit(ctx(user, Mode.INTERACTIVE, [Scope.MONEY]), fakeTx({
          findApproval: vi.fn(async () => ({ approvalId: "approval-1", status })),
        }), {
          operation: crmApproveSettlement, objectType: "settlement", intent: {},
          apply: async () => ({ ok: true }),
        }, { approvalId: "approval-1" }),
      ).rejects.toThrow(new RegExp(`is ${status}, not allowed`));
    }
  });

  it("blocks an agent writing a hand-curated record but allows a human", async () => {
    const tx = fakeTx({ isHandCurated: vi.fn(async () => true) });
    await expect(
      commit(ctx(agent, Mode.SUPERVISED, [Scope.WRITE]), tx, {
        operation: crmPlaceHold, objectType: "venue", recordId: "v1", intent: {},
        apply: async () => ({ ok: true }),
      }),
    ).rejects.toThrow(/hand-curated/);

    await expect(
      commit(ctx(user, Mode.INTERACTIVE, [Scope.WRITE]), tx, {
        operation: crmPlaceHold, objectType: "venue", recordId: "v1", intent: {},
        apply: async () => ({ ok: true }),
      }),
    ).resolves.toBeDefined();
  });

  it("fails visibly when the budget is exhausted rather than half-applying", async () => {
    const apply = vi.fn(async () => ({ ok: true }));
    await expect(
      commit(ctx(user, Mode.INTERACTIVE, [Scope.WRITE]), fakeTx({
        remainingBudgetMicros: vi.fn(async () => 10),
      }), { operation: crmPlaceHold, objectType: "hold", intent: {}, apply }, { costMicros: 500 }),
    ).rejects.toThrow(/budget exhausted/i);
    expect(apply).not.toHaveBeenCalled();
  });

  it("validators block without rewriting the intent", async () => {
    const intent = { level: 9 };
    await expect(
      commit(ctx(user, Mode.INTERACTIVE, [Scope.WRITE]), fakeTx(), {
        operation: crmPlaceHold, objectType: "hold", intent,
        validators: [(candidate) => ((candidate as { level: number }).level > 5 ? "level out of range" : null)],
        apply: async () => ({ ok: true }),
      }),
    ).rejects.toThrow(ServiceError);
    expect(intent).toEqual({ level: 9 });
  });

  it("rejects a principal from another tenant", async () => {
    await expect(
      commit({ ...ctx(user, Mode.INTERACTIVE, [Scope.READ]), tenantId: "t2" }, fakeTx(), {
        operation: crmSearch, objectType: "booking", intent: {}, apply: async () => ({ ok: true }),
      }),
    ).rejects.toThrow(/does not belong to this tenant/);
  });
});
