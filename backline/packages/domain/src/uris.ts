/**
 * The `crm://` URI scheme.
 *
 * Ported from Zed's MentionUri (crates/acp_thread/src/mention.rs). One scheme
 * serves three jobs at once, which is why it is worth having:
 *   1. @-mentions in markdown notes, embedded as ordinary links so references
 *      survive serialization;
 *   2. the MCP resource namespace, so a mention in a note IS an addressable
 *      resource;
 *   3. the exfiltration canary in the egress scanner (trust.ts).
 */

import { ValidationError } from "./errors.js";

export const ObjectType = {
  CONTACT: "contact",
  COMPANY: "company",
  ARTIST: "artist",
  VENUE: "venue",
  PROMOTER: "promoter",
  BOOKING: "booking",
  HOLD: "hold",
  OFFER: "offer",
  CONTRACT: "contract",
  SETTLEMENT: "settlement",
  TOUR: "tour",
  RELEASE: "release",
  TRACK: "track",
  WORK: "work",
  NOTE: "note",
  ACTIVITY: "activity",
  TASK: "task",
  DEAL: "deal",
} as const;
export type ObjectType = (typeof ObjectType)[keyof typeof ObjectType];

const OBJECT_TYPES = new Set<string>(Object.values(ObjectType));
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export interface CrmUri {
  readonly objectType: ObjectType;
  readonly id: string;
}

export function crmUri(objectType: ObjectType, id: string): string {
  if (!ID_PATTERN.test(id)) {
    throw new ValidationError(`Invalid record id for crm:// URI: ${id}`);
  }
  return `crm://${objectType}/${id}`;
}

export function parseCrmUri(uri: string): CrmUri {
  const match = /^crm:\/\/([a-z_]+)\/([A-Za-z0-9_-]{1,64})$/.exec(uri);
  if (!match) throw new ValidationError(`Malformed crm:// URI: ${uri}`);
  const [, objectType, id] = match;
  if (!objectType || !id || !OBJECT_TYPES.has(objectType)) {
    throw new ValidationError(`Unknown object type in crm:// URI: ${uri}`);
  }
  return { objectType: objectType as ObjectType, id };
}

export function isCrmUri(value: string): boolean {
  try {
    parseCrmUri(value);
    return true;
  } catch {
    return false;
  }
}
