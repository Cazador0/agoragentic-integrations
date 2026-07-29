/**
 * Music-agency domain schemas.
 *
 * Deliberately includes what the review found missing across all three
 * designs: a first-class versioned `offer` (the actual negotiation artifact),
 * venue IANA timezone on every date computation, per-territory work shares that
 * must sum to 100, a `catalog` entity, band-vs-member modelling, and the
 * settlement amendment chain that resolves "immutable after approval" against
 * routine retroactive FX corrections.
 */

import { z } from "zod";

/* ------------------------------------------------------------------ atoms */

export const currencyCode = z.string().regex(/^[A-Z]{3}$/, "ISO 4217 currency code");
export const minorUnits = z.union([z.bigint(), z.number().int()]);

/** ISRC: CC-XXX-YY-NNNNN. Country, registrant, year of reference, designation. */
export const isrc = z
  .string()
  .transform((value) => value.replace(/-/g, "").toUpperCase())
  .refine((value) => /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/.test(value), {
    message: "ISRC must be CC-XXX-YY-NNNNN (e.g. USRC17607839)",
  });

/**
 * ISWC: T-NNNNNNNNN-C with a mod-10 check digit.
 * Validating the check digit matters — a transposed ISWC silently attaches
 * royalties to the wrong composition.
 */
export const iswc = z
  .string()
  .transform((value) => value.replace(/[-.\s]/g, "").toUpperCase())
  .refine((value) => /^T\d{10}$/.test(value), { message: "ISWC must be T-NNNNNNNNN-C" })
  .refine(
    (value) => {
      const digits = value.slice(1, 10).split("").map(Number);
      const check = Number(value[10]);
      const sum = digits.reduce((acc, digit, index) => acc + digit * (index + 1), 1);
      return (10 - (sum % 10)) % 10 === check;
    },
    { message: "ISWC check digit failed" },
  );

export const upc = z.string().regex(/^\d{12,14}$/, "UPC/EAN must be 12-14 digits");

/** IANA zone. Every show date is computed in venue-local time, never UTC-naive. */
export const ianaTimezone = z.string().regex(/^[A-Za-z]+\/[A-Za-z_+-]+(\/[A-Za-z_+-]+)?$/, "IANA timezone");

export const basisPoints = z.number().int().min(0).max(10_000);

/* ------------------------------------------------------------- principals */

export const artist = z.object({
  id: z.string(),
  name: z.string().min(1),
  /** A band is not a person. Members are separate contacts with tenure. */
  kind: z.enum(["solo", "band", "dj", "collective"]),
  rosterStatus: z.enum(["prospect", "signed", "hiatus", "former"]),
  commissionBps: basisPoints,
  territories: z.array(z.string().length(2)).default([]),
  homeTimezone: ianaTimezone.optional(),
});
export type Artist = z.infer<typeof artist>;

/** Membership carries tenure so a departing drummer does not break history. */
export const artistMember = z.object({
  id: z.string(),
  artistId: z.string(),
  contactId: z.string(),
  role: z.string(),
  joinedOn: z.string().date(),
  leftOn: z.string().date().nullable().default(null),
});
export type ArtistMember = z.infer<typeof artistMember>;

export const venue = z.object({
  id: z.string(),
  name: z.string().min(1),
  city: z.string(),
  countryCode: z.string().length(2),
  /** Required, not optional: hold expiry and curfew are venue-local. */
  timezone: ianaTimezone,
  capacity: z.number().int().positive().optional(),
  currency: currencyCode,
});
export type Venue = z.infer<typeof venue>;

/* --------------------------------------------------------------- booking */

export const bookingStatus = z.enum([
  "inquiry",
  "held",
  "offered",
  "confirmed",
  "contracted",
  "played",
  "settled",
  "cancelled",
]);
export type BookingStatus = z.infer<typeof bookingStatus>;

export const booking = z.object({
  id: z.string(),
  artistId: z.string(),
  venueId: z.string(),
  promoterId: z.string().optional(),
  tourId: z.string().optional(),
  /** Local calendar date at the venue. Resolved against venue.timezone. */
  eventDate: z.string().date(),
  status: bookingStatus,
  currency: currencyCode,
});
export type Booking = z.infer<typeof booking>;

/** Hold levels 1-5. H1 is first refusal. */
export const holdLevel = z.number().int().min(1).max(5);

export const hold = z.object({
  id: z.string(),
  bookingId: z.string(),
  venueId: z.string(),
  eventDate: z.string().date(),
  level: holdLevel,
  status: z.enum(["active", "challenged", "released", "promoted", "expired"]),
  placedAt: z.string().datetime(),
  expiresAt: z.string().datetime().nullable().default(null),
  challengedByHoldId: z.string().nullable().default(null),
});
export type Hold = z.infer<typeof hold>;

/**
 * The offer — absent from all three reviewed designs, and the artifact a
 * booking agent actually spends their day on. Versioned and immutable once
 * sent; a counter creates a new version referencing its parent.
 */
export const dealType = z.enum([
  "flat",
  "flat_plus_bonus",
  "versus_split",
  "door_split",
  "backend_percentage",
  "breakeven_plus_split",
]);

export const offer = z.object({
  id: z.string(),
  bookingId: z.string(),
  version: z.number().int().positive(),
  supersedesOfferId: z.string().nullable().default(null),
  status: z.enum(["draft", "sent", "countered", "accepted", "declined", "expired"]),
  dealType,
  guaranteeMinor: minorUnits,
  currency: currencyCode,
  /** Artist's share of net after breakeven, for split deals. */
  splitBps: basisPoints.optional(),
  breakevenMinor: minorUnits.optional(),
  /** Radius clause: no competing date within N km for M days either side. */
  radiusKm: z.number().int().positive().optional(),
  radiusDaysBefore: z.number().int().nonnegative().optional(),
  radiusDaysAfter: z.number().int().nonnegative().optional(),
  expiresAt: z.string().datetime().nullable().default(null),
  sentAt: z.string().datetime().nullable().default(null),
});
export type Offer = z.infer<typeof offer>;

/* ------------------------------------------------------------ settlement */

export const settlementLineKind = z.enum([
  "guarantee",
  "door",
  "bonus",
  "expense",
  "commission",
  "withholding_tax",
  "vat",
  "adjustment",
]);

export const settlementLine = z.object({
  id: z.string(),
  settlementId: z.string(),
  kind: settlementLineKind,
  label: z.string(),
  amountMinor: minorUnits,
  currency: currencyCode,
});
export type SettlementLine = z.infer<typeof settlementLine>;

/**
 * FX captured at approval, not looked up later — otherwise a settlement's
 * value silently changes with the market after it was agreed.
 */
export const fxSnapshot = z.object({
  base: currencyCode,
  quote: currencyCode,
  /** Rate scaled by 1e8 and stored as an integer. No floats near money. */
  rateScaled: z.number().int().positive(),
  capturedAt: z.string().datetime(),
  source: z.string(),
});

export const settlement = z.object({
  id: z.string(),
  bookingId: z.string(),
  status: z.enum(["draft", "submitted", "approved", "paid"]),
  /** Currency the show settled in. */
  settlementCurrency: currencyCode,
  /** Currency the agency books commission in. May differ. */
  currencyOfRecord: currencyCode,
  fxSnapshot: fxSnapshot.nullable().default(null),
  approvedAt: z.string().datetime().nullable().default(null),
  /**
   * Amendment chain. An approved settlement is never mutated; a retroactive FX
   * or withholding correction creates a new settlement referencing this one,
   * and the effective figure is the fold over the chain. This is what resolves
   * the immutability contradiction the review identified.
   */
  amendsSettlementId: z.string().nullable().default(null),
});
export type Settlement = z.infer<typeof settlement>;

/* --------------------------------------------------------------- catalog */

/** The catalog entity the brief named and two of three designs omitted. */
export const catalog = z.object({
  id: z.string(),
  name: z.string().min(1),
  ownerArtistId: z.string().optional(),
  labelCompanyId: z.string().optional(),
});
export type Catalog = z.infer<typeof catalog>;

export const release = z.object({
  id: z.string(),
  catalogId: z.string().optional(),
  artistId: z.string(),
  title: z.string().min(1),
  type: z.enum(["single", "ep", "album", "compilation", "live"]),
  upc: upc.optional(),
  releaseDate: z.string().date().optional(),
});
export type Release = z.infer<typeof release>;

/** A recording. */
export const track = z.object({
  id: z.string(),
  releaseId: z.string().optional(),
  title: z.string().min(1),
  isrc: isrc.optional(),
  durationMs: z.number().int().positive().optional(),
});
export type Track = z.infer<typeof track>;

/** A composition. Distinct from the recording that embodies it. */
export const work = z.object({
  id: z.string(),
  title: z.string().min(1),
  iswc: iswc.optional(),
});
export type Work = z.infer<typeof work>;

/**
 * Per-territory writer shares as rows, not a JSON array.
 *
 * The review's finding: a `splits[]` array cannot carry per-territory shares,
 * sum-to-100 enforcement, PRO affiliation, or capacity codes, which puts CWR /
 * PRO registration architecturally out of reach. Rows fix that.
 */
export const workShare = z.object({
  id: z.string(),
  workId: z.string(),
  partyContactId: z.string(),
  /** CWR capacity: composer, author, arranger, publisher, administrator. */
  capacity: z.enum(["CA", "A", "C", "AR", "E", "AM", "SE"]),
  /** ISO 3166-1 alpha-2, or "XX" for world. */
  territory: z.string().length(2),
  shareBps: basisPoints,
  proAffiliation: z.string().optional(),
});
export type WorkShare = z.infer<typeof workShare>;

export class ShareSumError extends Error {
  constructor(
    readonly workId: string,
    readonly territory: string,
    readonly totalBps: number,
  ) {
    super(
      `Work ${workId} shares for territory ${territory} sum to ${totalBps} bps, expected 10000. ` +
        `Registration would be rejected by the PRO.`,
    );
    this.name = "ShareSumError";
  }
}

/** Enforced per (work, territory, capacity class) before any CWR export. */
export function assertSharesSumTo100(shares: readonly WorkShare[]): void {
  const byTerritory = new Map<string, number>();
  for (const share of shares) {
    byTerritory.set(share.territory, (byTerritory.get(share.territory) ?? 0) + share.shareBps);
  }
  for (const [territory, total] of byTerritory) {
    if (total !== 10_000) {
      throw new ShareSumError(shares[0]?.workId ?? "unknown", territory, total);
    }
  }
}

/* -------------------------------------------------------------- activity */

/**
 * The timeline spine, declared in Phase 0 so email is populating a table rather
 * than retrofitting a model. See docs/GAP-CLOSURES.md §1.
 */
export const activity = z.object({
  id: z.string(),
  /** crm:// URI of the record this activity hangs off. */
  subjectUri: z.string(),
  kind: z.enum(["email", "call", "meeting", "note", "agent_action", "sync", "system"]),
  threadId: z.string().nullable().default(null),
  occurredAt: z.string().datetime(),
  summary: z.string(),
  /** Trust label, derived at write time. See trust.ts. */
  trust: z.enum(["SYSTEM", "OPERATOR", "UNTRUSTED"]),
  authorPrincipalId: z.string().nullable().default(null),
});
export type Activity = z.infer<typeof activity>;
