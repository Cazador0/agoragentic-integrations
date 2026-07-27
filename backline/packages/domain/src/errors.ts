/**
 * Service error taxonomy.
 *
 * Shape from notebooklm-mcp-cli's `services/errors.py`: every error carries a
 * stable machine-readable code AND a `hint` naming the next call an agent
 * should make. Agents recover far better from "not found, try crm_search" than
 * from a 404.
 */

export const ErrorCode = {
  VALIDATION: "VALIDATION",
  NOT_FOUND: "NOT_FOUND",
  CONFLICT: "CONFLICT",
  PERMISSION_DENIED: "PERMISSION_DENIED",
  APPROVAL_REQUIRED: "APPROVAL_REQUIRED",
  IMMUTABLE: "IMMUTABLE",
  RATE_LIMITED: "RATE_LIMITED",
  BUDGET_EXHAUSTED: "BUDGET_EXHAUSTED",
  DELEGATION: "DELEGATION",
  UPSTREAM: "UPSTREAM",
  INTERNAL: "INTERNAL",
} as const;
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

const HTTP_STATUS: Record<ErrorCode, number> = {
  VALIDATION: 400,
  NOT_FOUND: 404,
  CONFLICT: 409,
  PERMISSION_DENIED: 403,
  APPROVAL_REQUIRED: 202,
  IMMUTABLE: 409,
  RATE_LIMITED: 429,
  BUDGET_EXHAUSTED: 402,
  DELEGATION: 403,
  UPSTREAM: 502,
  INTERNAL: 500,
};

export interface ServiceErrorPayload {
  readonly error_code: ErrorCode;
  readonly detail: string;
  readonly hint?: string;
  readonly retriable: boolean;
}

export class ServiceError extends Error {
  readonly code: ErrorCode;
  readonly hint: string | undefined;
  readonly retriable: boolean;

  constructor(code: ErrorCode, detail: string, options: { hint?: string; retriable?: boolean } = {}) {
    super(detail);
    this.name = "ServiceError";
    this.code = code;
    this.hint = options.hint;
    this.retriable = options.retriable ?? (code === ErrorCode.RATE_LIMITED || code === ErrorCode.UPSTREAM);
  }

  get httpStatus(): number {
    return HTTP_STATUS[this.code];
  }

  toPayload(): ServiceErrorPayload {
    return {
      error_code: this.code,
      detail: this.message,
      ...(this.hint ? { hint: this.hint } : {}),
      retriable: this.retriable,
    };
  }
}

export class NotFoundError extends ServiceError {
  constructor(objectType: string, id: string) {
    super(ErrorCode.NOT_FOUND, `No ${objectType} with id ${id}.`, {
      // The hint is the affordance: it names the exact recovery call.
      hint: `Call crm_search with {"objectType":"${objectType}"} to list available records.`,
    });
    this.name = "NotFoundError";
  }
}

export class ValidationError extends ServiceError {
  constructor(detail: string, hint?: string) {
    super(ErrorCode.VALIDATION, detail, hint ? { hint } : {});
    this.name = "ValidationError";
  }
}

export class ApprovalRequiredError extends ServiceError {
  constructor(readonly approvalId: string, operationId: string) {
    super(ErrorCode.APPROVAL_REQUIRED, `Operation ${operationId} requires human approval.`, {
      hint: `Poll crm_get_approval with {"approvalId":"${approvalId}"} until it resolves.`,
    });
    this.name = "ApprovalRequiredError";
  }
}

export class ImmutableRecordError extends ServiceError {
  constructor(objectType: string, id: string, amendHint: string) {
    super(ErrorCode.IMMUTABLE, `${objectType} ${id} is immutable in its current state.`, {
      hint: amendHint,
    });
    this.name = "ImmutableRecordError";
  }
}
