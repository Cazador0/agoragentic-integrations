/**
 * Canonical `crm_*` operations.
 *
 * Descriptions are written for a model: idempotency, side effects, and error
 * shapes are stated in prose because that is what the LLM actually reads.
 *
 * Note what is NOT here: there is no `crm_update_record` accepting an arbitrary
 * objectType and property bag. The review found that Solution B's generic
 * `/v1/{objectType}` write head let an agent PATCH a booking directly and never
 * touch the lifecycle operation, making its "unbypassable" invariants
 * advisory. Here the generic surface is read-only (`crm_search`, `crm_get_record`,
 * `crm_describe`) plus `crm_set_custom_properties`, which can only write fields
 * declared in `property_def`. Domain state transitions go through domain
 * operations, period.
 */

import { z } from "zod";
import { defineOperation } from "./registry.js";
import { Scope } from "./scopes.js";
import { basisPoints, bookingStatus, currencyCode, dealType, holdLevel, minorUnits } from "./entities.js";

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const CREATE = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const;

const UPSERT = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const EXTERNAL = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
} as const;

const recordRef = z.object({ id: z.string(), uri: z.string() });

/* ------------------------------------------------------------------ read */

export const crmSearch = defineOperation({
  id: "crm_search",
  summary: "Search records of any object type.",
  description:
    "Read-only. Idempotent. One closed query algebra over every object type: filterGroups is " +
    "an OR of AND-groups. Returns a cursor in paging.next.after; pass it back as `after` to " +
    "continue. Never returns records outside the caller's tenant or roster scope. " +
    "Errors: VALIDATION for an unknown propertyName or operator.",
  scopes: [Scope.READ],
  annotations: READ_ONLY,
  rest: { method: "POST", path: "/v1/:objectType/search" },
  a2aSkill: "record-search",
  input: z.object({
    objectType: z.string(),
    filterGroups: z
      .array(
        z.object({
          filters: z.array(
            z.object({
              propertyName: z.string(),
              operator: z.enum([
                "EQ", "NEQ", "LT", "LTE", "GT", "GTE", "BETWEEN", "IN", "NOT_IN",
                "HAS_PROPERTY", "NOT_HAS_PROPERTY", "CONTAINS_TOKEN", "NOT_CONTAINS_TOKEN",
              ]),
              value: z.unknown().optional(),
              values: z.array(z.unknown()).optional(),
              highValue: z.unknown().optional(),
            }),
          ),
        }),
      )
      .max(6)
      .default([]),
    sorts: z.array(z.object({ propertyName: z.string(), direction: z.enum(["ASC", "DESC"]) })).default([]),
    limit: z.number().int().min(1).max(200).default(50),
    after: z.string().optional(),
  }),
  output: z.object({
    results: z.array(z.record(z.unknown())),
    paging: z.object({ next: z.object({ after: z.string() }).optional() }),
  }),
});

export const crmGetRecord = defineOperation({
  id: "crm_get_record",
  summary: "Fetch one record by id.",
  description:
    "Read-only. Idempotent. Errors: NOT_FOUND with a hint naming the crm_search call that lists " +
    "available records of this type.",
  scopes: [Scope.READ],
  annotations: READ_ONLY,
  rest: { method: "GET", path: "/v1/:objectType/:id" },
  input: z.object({ objectType: z.string(), id: z.string() }),
  output: z.object({ record: z.record(z.unknown()), uri: z.string() }),
});

export const crmDescribe = defineOperation({
  id: "crm_describe",
  summary: "Describe object schemas and property definitions at runtime.",
  description:
    "Read-only. Idempotent. Schema is a runtime resource, not compile-time code: use this to " +
    "discover custom fields an agency has added before writing them, and to render forms " +
    "generically. Mirrors the Salesforce describe pattern.",
  scopes: [Scope.INSPECT],
  annotations: READ_ONLY,
  rest: { method: "GET", path: "/v1/describe/:objectType" },
  input: z.object({ objectType: z.string().optional() }),
  output: z.object({
    objectTypes: z.array(
      z.object({
        name: z.string(),
        properties: z.array(
          z.object({
            name: z.string(),
            type: z.string(),
            required: z.boolean(),
            agentWritable: z.boolean(),
            hasUniqueValue: z.boolean(),
          }),
        ),
      }),
    ),
  }),
});

export const crmJournalRead = defineOperation({
  id: "crm_journal_read",
  summary: "Read the durable change journal from an offset.",
  description:
    "Read-only. Idempotent. Offset-cursored, ordered and replayable — the source of truth for " +
    "change propagation. Push webhooks are a convenience layered on top of this, so prefer " +
    "polling the journal when correctness matters.",
  scopes: [Scope.READ],
  annotations: READ_ONLY,
  rest: { method: "GET", path: "/v1/journal" },
  input: z.object({ after: z.string().optional(), limit: z.number().int().min(1).max(500).default(100) }),
  output: z.object({
    events: z.array(
      z.object({
        offset: z.string(),
        occurredAt: z.string(),
        objectType: z.string(),
        recordId: z.string(),
        action: z.enum(["CREATE", "UPDATE", "DELETE", "MERGE", "RESTORE", "ASSOCIATION_CHANGED"]),
      }),
    ),
    paging: z.object({ next: z.object({ after: z.string() }).optional() }),
  }),
});

/* --------------------------------------------------------- hold ladder */

export const crmPlaceHold = defineOperation({
  id: "crm_place_hold",
  summary: "Place a hold at a given level on a venue date.",
  description:
    "NOT idempotent — calling twice creates two holds. Enforced by a database exclusion " +
    "constraint: only one active hold per (venue, date, level). Placing H1 when H1 is taken " +
    "returns CONFLICT with the current holder; request the next free level instead. " +
    "Dates are venue-local; the venue's IANA timezone governs expiry.",
  scopes: [Scope.WRITE],
  annotations: CREATE,
  rest: { method: "POST", path: "/v1/bookings/:bookingId/holds" },
  a2aSkill: "booking-hold",
  input: z.object({
    bookingId: z.string(),
    level: holdLevel,
    expiresAt: z.string().datetime().optional(),
  }),
  output: z.object({ hold: recordRef, level: holdLevel }),
});

export const crmChallengeHold = defineOperation({
  id: "crm_challenge_hold",
  summary: "Challenge the hold above yours, starting the release clock.",
  description:
    "NOT idempotent. Notifies the senior hold holder and starts a deadline by which they must " +
    "confirm or release. Does not itself promote you — promotion happens via crm_promote_hold " +
    "once the senior hold releases or expires. Errors: CONFLICT if no senior hold exists.",
  scopes: [Scope.WRITE],
  annotations: CREATE,
  rest: { method: "POST", path: "/v1/holds/:holdId/challenge" },
  input: z.object({ holdId: z.string(), deadlineHours: z.number().int().min(1).max(336).default(48) }),
  output: z.object({ hold: recordRef, challengedHold: recordRef, deadline: z.string() }),
});

export const crmPromoteHold = defineOperation({
  id: "crm_promote_hold",
  summary: "Promote a hold to a higher level after the senior hold cleared.",
  description:
    "Idempotent: promoting an already-promoted hold returns the current state unchanged. " +
    "Refuses with CONFLICT while a senior hold at the target level is still active — the " +
    "ladder etiquette is enforced in the service, not left to the caller.",
  scopes: [Scope.WRITE],
  annotations: UPSERT,
  rest: { method: "POST", path: "/v1/holds/:holdId/promote" },
  input: z.object({ holdId: z.string(), toLevel: holdLevel }),
  output: z.object({ hold: recordRef, level: holdLevel }),
});

export const crmReleaseHold = defineOperation({
  id: "crm_release_hold",
  summary: "Release a hold, cascading promotion to the next level down.",
  description:
    "Idempotent. Releasing cascades: the next active hold below is eligible for promotion and " +
    "its holder is notified. Releasing a hold on a confirmed booking is refused with CONFLICT.",
  scopes: [Scope.WRITE],
  annotations: UPSERT,
  rest: { method: "POST", path: "/v1/holds/:holdId/release" },
  input: z.object({ holdId: z.string(), reason: z.string().optional() }),
  output: z.object({ hold: recordRef, promotedHold: recordRef.nullable() }),
});

/* ---------------------------------------------------------------- offers */

export const crmDraftOffer = defineOperation({
  id: "crm_draft_offer",
  summary: "Draft a new offer version for a booking.",
  description:
    "NOT idempotent — each call creates a new version. Drafts are mutable; once sent, an offer " +
    "is immutable and a counter creates version n+1 referencing it. Money is integer minor " +
    "units plus an explicit currency; never send a decimal.",
  scopes: [Scope.WRITE],
  annotations: CREATE,
  rest: { method: "POST", path: "/v1/bookings/:bookingId/offers" },
  input: z.object({
    bookingId: z.string(),
    dealType,
    guaranteeMinor: minorUnits,
    currency: currencyCode,
    splitBps: basisPoints.optional(),
    breakevenMinor: minorUnits.optional(),
    radiusKm: z.number().int().positive().optional(),
    supersedesOfferId: z.string().optional(),
  }),
  output: z.object({ offer: recordRef, version: z.number().int() }),
});

export const crmSendOffer = defineOperation({
  id: "crm_send_offer",
  summary: "Send an offer to the promoter. MAY SEND EXTERNAL EMAIL.",
  description:
    "EGRESS. NOT idempotent. ALWAYS requires human approval — this scope can never be granted " +
    "to an autonomous agent or carried in a delegated token, so a compromised downstream agent " +
    "cannot send an offer. Freezes the offer version as immutable. Returns APPROVAL_REQUIRED " +
    "with an approvalId to poll.",
  scopes: [Scope.EGRESS, Scope.WRITE],
  annotations: EXTERNAL,
  rest: { method: "POST", path: "/v1/offers/:offerId/send" },
  confirmRequired: true,
  input: z.object({
    offerId: z.string(),
    recipientContactIds: z.array(z.string()).min(1),
    message: z.string().optional(),
  }),
  output: z.object({ offer: recordRef, approvalId: z.string(), sentAt: z.string().nullable() }),
});

/* --------------------------------------------------------- booking state */

export const crmAdvanceBooking = defineOperation({
  id: "crm_advance_booking",
  summary: "Advance a booking to the next lifecycle state.",
  description:
    "Idempotent per target state. The only way a booking's status changes — there is no generic " +
    "property write for it. Refuses illegal transitions with CONFLICT, and refuses to confirm a " +
    "date where the venue already has a confirmed show (database exclusion constraint). Stages " +
    "marked READ_ONLY in the pipeline reject agent writes entirely.",
  scopes: [Scope.WRITE],
  annotations: UPSERT,
  rest: { method: "POST", path: "/v1/bookings/:bookingId/advance" },
  a2aSkill: "booking-advance",
  input: z.object({ bookingId: z.string(), toStatus: bookingStatus }),
  output: z.object({ booking: recordRef, status: bookingStatus }),
});

/* ----------------------------------------------------------- settlement */

export const crmCreateSettlement = defineOperation({
  id: "crm_create_settlement",
  summary: "Create a draft settlement for a played booking.",
  description:
    "NOT idempotent. Requires the booking to be in `played`. All line amounts are integer minor " +
    "units; withholding tax and VAT are line kinds, not scalar fields, so treaty reductions and " +
    "reverse-charge carry their own provenance.",
  scopes: [Scope.WRITE],
  annotations: CREATE,
  rest: { method: "POST", path: "/v1/bookings/:bookingId/settlement" },
  input: z.object({
    bookingId: z.string(),
    settlementCurrency: currencyCode,
    currencyOfRecord: currencyCode,
    lines: z
      .array(
        z.object({
          kind: z.enum([
            "guarantee", "door", "bonus", "expense", "commission", "withholding_tax", "vat", "adjustment",
          ]),
          label: z.string(),
          amountMinor: minorUnits,
        }),
      )
      .min(1),
  }),
  output: z.object({ settlement: recordRef, netMinor: z.string() }),
});

export const crmApproveSettlement = defineOperation({
  id: "crm_approve_settlement",
  summary: "Approve a settlement, freezing it and capturing FX.",
  description:
    "MONEY. Requires human approval and can never be granted to an autonomous agent. Captures " +
    "an FX snapshot at approval time so the settled value cannot drift with the market. After " +
    "approval the settlement is IMMUTABLE — a later correction must use crm_amend_settlement, " +
    "which creates a linked amendment rather than mutating history.",
  scopes: [Scope.MONEY],
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  rest: { method: "POST", path: "/v1/settlements/:settlementId/approve" },
  a2aSkill: "settlement-status",
  confirmRequired: true,
  input: z.object({ settlementId: z.string() }),
  output: z.object({ settlement: recordRef, approvalId: z.string() }),
});

export const crmAmendSettlement = defineOperation({
  id: "crm_amend_settlement",
  summary: "Amend an approved settlement via a linked amendment.",
  description:
    "MONEY. Requires human approval. Never mutates the original: creates a new settlement whose " +
    "amendsSettlementId points at it, so the effective figure is the fold over the chain and " +
    "the audit history stays intact. This is how retroactive FX and withholding corrections " +
    "happen without violating post-approval immutability.",
  scopes: [Scope.MONEY],
  annotations: CREATE,
  rest: { method: "POST", path: "/v1/settlements/:settlementId/amend" },
  confirmRequired: true,
  input: z.object({
    settlementId: z.string(),
    reason: z.string().min(1),
    lines: z.array(z.object({ kind: z.string(), label: z.string(), amountMinor: minorUnits })).min(1),
  }),
  output: z.object({ amendment: recordRef, approvalId: z.string() }),
});

/* ------------------------------------------------------------ hygiene */

export const crmFindDuplicates = defineOperation({
  id: "crm_find_duplicates",
  summary: "Find probable duplicate records for human review.",
  description:
    "Read-only. Idempotent. Fuzzy match over name, address and email domain; returns scored " +
    "candidate pairs, never merges. The highest-value routine agent task in a CRM — feed the " +
    "results to crm_merge_records only after a human resolves survivorship.",
  scopes: [Scope.READ],
  annotations: READ_ONLY,
  rest: { method: "POST", path: "/v1/:objectType/duplicates" },
  input: z.object({
    objectType: z.string(),
    threshold: z.number().min(0).max(1).default(0.85),
    limit: z.number().int().min(1).max(200).default(50),
  }),
  output: z.object({
    candidates: z.array(
      z.object({ leftId: z.string(), rightId: z.string(), score: z.number(), reasons: z.array(z.string()) }),
    ),
  }),
});

export const crmMergeRecords = defineOperation({
  id: "crm_merge_records",
  summary: "Merge a duplicate record into a primary. DESTRUCTIVE.",
  description:
    "DESTRUCTIVE and requires human approval. Field-level survivorship must be supplied " +
    "explicitly — there is no automatic winner. Writes a merge_log entry so the merge can be " +
    "explained and, within the retention window, reversed.",
  scopes: [Scope.WRITE],
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  rest: { method: "POST", path: "/v1/:objectType/merge" },
  confirmRequired: true,
  input: z.object({
    objectType: z.string(),
    primaryId: z.string(),
    mergeId: z.string(),
    survivorship: z.record(z.enum(["primary", "merge"])).default({}),
  }),
  output: z.object({ record: recordRef, mergeLogId: z.string() }),
});

/* --------------------------------------------------------------- agents */

export const crmGetApproval = defineOperation({
  id: "crm_get_approval",
  summary: "Poll a pending approval.",
  description:
    "Read-only. Idempotent. Approvals are database rows, not in-memory promises, so they survive " +
    "restarts and render on a phone. A timed-out approval resolves to `denied`, never to allowed.",
  scopes: [Scope.READ],
  annotations: READ_ONLY,
  rest: { method: "GET", path: "/v1/approvals/:approvalId" },
  input: z.object({ approvalId: z.string() }),
  output: z.object({
    approvalId: z.string(),
    status: z.enum(["pending", "allowed", "denied", "expired"]),
    operationId: z.string(),
    egressFindings: z.array(z.object({ kind: z.string(), detail: z.string() })).default([]),
  }),
});

export const crmSetCustomProperties = defineOperation({
  id: "crm_set_custom_properties",
  summary: "Write agency-defined custom properties on a record.",
  description:
    "Idempotent. The ONLY generic write path, and deliberately narrow: it can write only " +
    "properties declared in property_def with agentWritable=true, and never a domain field " +
    "governed by a lifecycle operation. Refuses with PERMISSION_DENIED on a hand_curated record.",
  scopes: [Scope.WRITE],
  annotations: UPSERT,
  rest: { method: "PATCH", path: "/v1/:objectType/:id/custom" },
  input: z.object({
    objectType: z.string(),
    id: z.string(),
    properties: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])),
  }),
  output: z.object({ record: recordRef, updated: z.array(z.string()) }),
});

/** Import so the module's side-effectful registrations run. */
export const ALL_OPERATION_IDS = [
  crmSearch, crmGetRecord, crmDescribe, crmJournalRead,
  crmPlaceHold, crmChallengeHold, crmPromoteHold, crmReleaseHold,
  crmDraftOffer, crmSendOffer, crmAdvanceBooking,
  crmCreateSettlement, crmApproveSettlement, crmAmendSettlement,
  crmFindDuplicates, crmMergeRecords, crmGetApproval, crmSetCustomProperties,
].map((operation) => operation.id);
