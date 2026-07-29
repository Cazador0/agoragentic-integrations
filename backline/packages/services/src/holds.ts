/**
 * Hold-ladder etiquette.
 *
 * Encoded as service invariants AND backed by database constraints (see
 * `packages/db/migrations/0001_init.sql`). The review's finding was that
 * application-layer invariants are advisory when a generic write head exists;
 * here there is no generic write path to a hold's level or status, and the
 * database refuses the illegal state independently.
 *
 * Real-world etiquette this implements:
 *   - one active hold per (venue, date, level)
 *   - a challenge starts a clock on the hold ABOVE you; it does not promote you
 *   - promotion only once the senior hold releases or expires
 *   - releasing cascades: the next hold down becomes eligible
 *   - expiry is computed in the VENUE's timezone, not the agent's
 */

import { ErrorCode, ServiceError } from "@backline/domain";

export interface HoldRow {
  readonly id: string;
  readonly bookingId: string;
  readonly venueId: string;
  readonly eventDate: string;
  readonly level: number;
  readonly status: "active" | "challenged" | "released" | "promoted" | "expired";
  readonly expiresAt: string | null;
  readonly challengedByHoldId: string | null;
}

export const MAX_HOLD_LEVEL = 5;

/** Holds still occupying a rung. */
export function isOccupying(hold: HoldRow): boolean {
  return hold.status === "active" || hold.status === "challenged";
}

export function assertLevelInRange(level: number): void {
  if (!Number.isInteger(level) || level < 1 || level > MAX_HOLD_LEVEL) {
    throw new ServiceError(ErrorCode.VALIDATION, `Hold level must be an integer 1-${MAX_HOLD_LEVEL}.`);
  }
}

/**
 * Placing a hold. Refuses an occupied rung and names the free one, so an agent
 * recovers in one step instead of guessing.
 */
export function assertLevelAvailable(existing: readonly HoldRow[], level: number): void {
  assertLevelInRange(level);
  const occupant = existing.find((hold) => hold.level === level && isOccupying(hold));
  if (occupant) {
    const free = nextFreeLevel(existing);
    throw new ServiceError(
      ErrorCode.CONFLICT,
      `Hold level ${level} on this date is already held (hold ${occupant.id}).`,
      {
        hint:
          free === null
            ? `All ${MAX_HOLD_LEVEL} levels are held. Ask the venue about a release, or pick another date.`
            : `Call crm_place_hold again with {"level": ${free}}.`,
      },
    );
  }
}

export function nextFreeLevel(existing: readonly HoldRow[]): number | null {
  for (let level = 1; level <= MAX_HOLD_LEVEL; level += 1) {
    if (!existing.some((hold) => hold.level === level && isOccupying(hold))) return level;
  }
  return null;
}

/** The hold immediately senior to this one, if any. */
export function seniorHold(existing: readonly HoldRow[], hold: HoldRow): HoldRow | null {
  const seniors = existing
    .filter((candidate) => candidate.level < hold.level && isOccupying(candidate))
    .sort((a, b) => b.level - a.level);
  return seniors[0] ?? null;
}

/**
 * A challenge targets the hold above yours and starts their clock. It does not
 * promote the challenger — conflating the two is the classic modelling error,
 * and it produces double-bookings when two agents challenge concurrently.
 */
export function assertCanChallenge(existing: readonly HoldRow[], hold: HoldRow): HoldRow {
  const senior = seniorHold(existing, hold);
  if (!senior) {
    throw new ServiceError(
      ErrorCode.CONFLICT,
      `Hold ${hold.id} is at level ${hold.level} with no senior hold to challenge.`,
      { hint: hold.level === 1 ? "You already hold first refusal; advance the booking instead." : undefined },
    );
  }
  return senior;
}

/**
 * Promotion is legal only when every rung between here and the target is clear.
 * Idempotent: promoting to the level already held is a no-op, not an error.
 */
export function assertCanPromote(existing: readonly HoldRow[], hold: HoldRow, toLevel: number): void {
  assertLevelInRange(toLevel);
  if (toLevel === hold.level) return;
  if (toLevel > hold.level) {
    throw new ServiceError(ErrorCode.VALIDATION, `Promotion must move to a more senior level (lower number).`);
  }
  const blocking = existing.filter(
    (candidate) => candidate.id !== hold.id && candidate.level >= toLevel && candidate.level < hold.level && isOccupying(candidate),
  );
  if (blocking.length > 0) {
    const highest = blocking.sort((a, b) => a.level - b.level)[0];
    throw new ServiceError(
      ErrorCode.CONFLICT,
      `Cannot promote to level ${toLevel}: hold ${highest?.id} still occupies level ${highest?.level}.`,
      { hint: `Call crm_challenge_hold on ${hold.id} to start the release clock on the senior hold.` },
    );
  }
}

/** Releasing cascades: the most senior hold below becomes eligible. */
export function cascadeCandidate(existing: readonly HoldRow[], released: HoldRow): HoldRow | null {
  const below = existing
    .filter((candidate) => candidate.level > released.level && isOccupying(candidate))
    .sort((a, b) => a.level - b.level);
  return below[0] ?? null;
}

/**
 * Expiry in venue-local time.
 *
 * A hold placed "until Friday" means Friday at the venue, not Friday UTC. The
 * review flagged the absence of venue timezone in two designs; getting this
 * wrong silently releases holds a day early for European venues held by a US
 * agency, which is a real and expensive bug.
 */
export function isExpired(hold: HoldRow, venueTimezone: string, now: Date = new Date()): boolean {
  if (!hold.expiresAt) return false;
  const expiry = new Date(hold.expiresAt);
  if (Number.isNaN(expiry.getTime())) {
    throw new ServiceError(ErrorCode.VALIDATION, `Hold ${hold.id} has an unparseable expiresAt.`);
  }
  // Resolve both instants in the venue's zone so a DST transition between now
  // and expiry cannot shift the boundary.
  const inZone = (date: Date): string =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone: venueTimezone,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
      hour12: false,
    }).format(date);
  return inZone(now) >= inZone(expiry);
}
