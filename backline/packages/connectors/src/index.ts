/**
 * Connector capability interfaces + the email/calendar/migration seams.
 *
 * These live in the FIRST milestone, not after the agent platform. The review's
 * most consequential finding was that all three designs sequenced email,
 * calendar and migration last, which is the classic way CRM rollouts die: with
 * no email ingestion the activity timeline is empty, every touchpoint is manual
 * data entry, and the team goes back to Outlook.
 *
 * `evals/adoption/timeline.gate.test.ts` enforces the sequencing.
 */

import { Trust, type ContentOrigin } from "@backline/domain";

/* -------------------------------------------- connector capability shapes */

/** Onyx's composable capability interfaces, translated. */
export interface Connector {
  readonly id: string;
  readonly displayName: string;
}

export interface ConnectorFailure {
  readonly kind: "failure";
  readonly externalId: string | undefined;
  readonly message: string;
  readonly retriable: boolean;
}

export interface ConnectorRecord<T> {
  readonly kind: "record";
  readonly externalId: string;
  readonly payload: T;
}

export type ConnectorItem<T> = ConnectorRecord<T> | ConnectorFailure;

/**
 * Checkpointed incremental sync. A per-record failure never aborts the run —
 * it is yielded and the generator continues, so one malformed venue does not
 * cost you the other 4,000.
 */
export interface IncrementalSync<T, TCheckpoint> extends Connector {
  sync(checkpoint: TCheckpoint | null): AsyncGenerator<ConnectorItem<T>, TCheckpoint, void>;
}

/** ID-only pass, for detecting deletions upstream. */
export interface SlimIdSync extends Connector {
  listIds(): AsyncGenerator<string, void, void>;
}

export interface RunMetrics {
  success: number;
  failed: number;
  skipped: number;
  messages: string[];
}

/** Rendered identically in the UI and the API. */
export function emptyMetrics(): RunMetrics {
  return { success: 0, failed: 0, skipped: 0, messages: [] };
}

/* ----------------------------------------------------------------- email */

export interface InboundMessage {
  readonly messageId: string;
  readonly threadHeaders: readonly string[];
  readonly from: string;
  readonly to: readonly string[];
  readonly subject: string;
  readonly body: string;
  readonly receivedAt: Date;
}

export type AssociationConfidence = "explicit" | "participant" | "heuristic" | "unmatched";

export interface Association {
  readonly subjectUri: string | null;
  readonly confidence: AssociationConfidence;
  readonly reason: string;
}

const CRM_URI_IN_TEXT = /crm:\/\/[a-z_]+\/[A-Za-z0-9_-]+/;
/** Outbound mail carries a +tag so replies associate deterministically. */
const PLUS_TAG = /\+([a-z_]+)\.([A-Za-z0-9_-]+)@/;

/**
 * Thread to record, in confidence order. Anything unresolved lands in the
 * unmatched queue — which is the SAME human review queue as duplicate
 * resolution and import survivorship. One queue, three producers.
 */
export function associateMessage(
  message: InboundMessage,
  lookupContactUri: (email: string) => string | null,
  lookupThreadSubject: (threadHeader: string) => string | null,
): Association {
  const tagged = PLUS_TAG.exec(message.to.join(","));
  if (tagged?.[1] && tagged[2]) {
    return {
      subjectUri: `crm://${tagged[1]}/${tagged[2]}`,
      confidence: "explicit",
      reason: "reply-to plus-tag emitted on the outbound message",
    };
  }

  const inline = CRM_URI_IN_TEXT.exec(message.body);
  if (inline?.[0]) {
    return { subjectUri: inline[0], confidence: "explicit", reason: "crm:// reference in body" };
  }

  for (const header of message.threadHeaders) {
    const known = lookupThreadSubject(header);
    if (known) return { subjectUri: known, confidence: "heuristic", reason: `References header ${header}` };
  }

  const contact = lookupContactUri(message.from);
  if (contact) {
    return { subjectUri: contact, confidence: "participant", reason: `sender ${message.from} matched a contact` };
  }

  return { subjectUri: null, confidence: "unmatched", reason: "no deterministic or participant match" };
}

/** Inbound mail is always UNTRUSTED, whatever it claims about itself. */
export function messageOrigin(): ContentOrigin {
  return "inbound_email";
}

export function messageTrust(): Trust {
  return Trust.UNTRUSTED;
}

/* -------------------------------------------------------------- calendar */

export interface CalendarEvent {
  readonly uid: string;
  readonly summary: string;
  readonly date: string;
  readonly timezone: string;
  /** A hold is tentative: it greys the date without blocking it. */
  readonly tentative: boolean;
  readonly location?: string;
}

function escapeIcs(value: string): string {
  return value.replace(/([,;\\])/g, "\\$1").replace(/\n/g, "\\n");
}

/**
 * ICS feed, shipped in the first milestone.
 *
 * Read-only, signed opaque URL, no OAuth, works in every calendar client that
 * exists — roughly 80% of the calendar value for ~40 lines. Bidirectional
 * Google/Graph sync is a later connector, not a prerequisite.
 */
export function renderIcsFeed(calendarName: string, events: readonly CalendarEvent[]): string {
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Backline//CRM//EN",
    "CALSCALE:GREGORIAN",
    `X-WR-CALNAME:${escapeIcs(calendarName)}`,
  ];
  for (const event of events) {
    const stamp = event.date.replace(/-/g, "");
    lines.push(
      "BEGIN:VEVENT",
      `UID:${event.uid}`,
      `DTSTART;VALUE=DATE:${stamp}`,
      `SUMMARY:${escapeIcs(event.summary)}`,
      event.location ? `LOCATION:${escapeIcs(event.location)}` : "",
      // Tentative holds must not block the agent's availability.
      `STATUS:${event.tentative ? "TENTATIVE" : "CONFIRMED"}`,
      `TRANSP:${event.tentative ? "TRANSPARENT" : "OPAQUE"}`,
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return lines.filter(Boolean).join("\r\n");
}

/* ------------------------------------------------------------- migration */

export interface SourceAdapter<T> extends Connector {
  readonly sourceSystem: "csv" | "xlsx" | "prism" | "master_tour" | "muzeek" | "overture" | "gigwell" | "outlook";
  read(): AsyncGenerator<ConnectorItem<T>, void, void>;
}

export interface MatchCandidate {
  readonly leftId: string;
  readonly rightId: string;
  readonly score: number;
  readonly reasons: readonly string[];
}

/** Normalised comparison key for venue/promoter/contact dedupe. */
export function normalizeName(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\b(the|le|la|el)\b/g, "")
    .replace(/[^a-z0-9]/g, "");
}

/** Cheap deterministic prefilter; the expensive scorer runs on survivors. */
export function trigramSimilarity(left: string, right: string): number {
  const grams = (value: string): Set<string> => {
    const padded = `  ${value} `;
    const out = new Set<string>();
    for (let i = 0; i < padded.length - 2; i += 1) out.add(padded.slice(i, i + 3));
    return out;
  };
  const a = grams(normalizeName(left));
  const b = grams(normalizeName(right));
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const gram of a) if (b.has(gram)) shared += 1;
  return shared / (a.size + b.size - shared);
}

export interface ReconciliationDrift {
  readonly recordId: string;
  readonly field: string;
  readonly incumbentValue: unknown;
  readonly backlineValue: unknown;
}

/**
 * Parallel-run reconciliation.
 *
 * The actual switching gate: sixty days of green diffs against the incumbent
 * is what an agency requires before cutting over. Modelled as a first-class run
 * with a stored report, not an ops script.
 */
export function reconcile<T extends Record<string, unknown>>(
  incumbent: readonly (T & { id: string })[],
  backline: readonly (T & { id: string })[],
  fields: readonly (keyof T & string)[],
): ReconciliationDrift[] {
  const byId = new Map(backline.map((record) => [record.id, record]));
  const drift: ReconciliationDrift[] = [];
  for (const source of incumbent) {
    const target = byId.get(source.id);
    if (!target) {
      drift.push({ recordId: source.id, field: "*", incumbentValue: "present", backlineValue: "missing" });
      continue;
    }
    for (const field of fields) {
      if (source[field] !== target[field]) {
        drift.push({
          recordId: source.id,
          field,
          incumbentValue: source[field],
          backlineValue: target[field],
        });
      }
    }
  }
  return drift;
}
