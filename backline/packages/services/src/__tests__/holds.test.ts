import { describe, expect, it } from "vitest";
import {
  assertCanChallenge, assertCanPromote, assertLevelAvailable, cascadeCandidate,
  isExpired, nextFreeLevel, seniorHold, type HoldRow,
} from "../holds.js";

const hold = (id: string, level: number, status: HoldRow["status"] = "active"): HoldRow => ({
  id, bookingId: "b1", venueId: "v1", eventDate: "2026-09-14", level, status,
  expiresAt: null, challengedByHoldId: null,
});

describe("hold ladder etiquette", () => {
  it("refuses an occupied rung and names the next free one", () => {
    const ladder = [hold("h1", 1), hold("h2", 2)];
    expect(() => assertLevelAvailable(ladder, 1)).toThrow(/already held/);
    try {
      assertLevelAvailable(ladder, 1);
    } catch (error) {
      expect((error as { hint?: string }).hint).toContain('"level": 3');
    }
  });

  it("treats released and expired holds as free rungs", () => {
    const ladder = [hold("h1", 1, "released"), hold("h2", 2, "expired")];
    expect(nextFreeLevel(ladder)).toBe(1);
    expect(() => assertLevelAvailable(ladder, 1)).not.toThrow();
  });

  it("reports no free level when the ladder is full", () => {
    expect(nextFreeLevel([1, 2, 3, 4, 5].map((l) => hold(`h${l}`, l)))).toBeNull();
  });

  it("challenges the hold immediately above, not the top of the ladder", () => {
    const ladder = [hold("h1", 1), hold("h2", 2), hold("h3", 3)];
    expect(seniorHold(ladder, hold("h3", 3))?.id).toBe("h2");
    expect(assertCanChallenge(ladder, hold("h3", 3)).id).toBe("h2");
  });

  it("refuses to challenge from first refusal", () => {
    expect(() => assertCanChallenge([hold("h1", 1)], hold("h1", 1))).toThrow(/no senior hold/);
  });

  it("does NOT promote as a side effect of challenging", () => {
    // The classic modelling error: conflating challenge with promotion produces
    // double bookings when two agents challenge concurrently.
    const ladder = [hold("h1", 1), hold("h2", 2)];
    assertCanChallenge(ladder, ladder[1]!);
    expect(() => assertCanPromote(ladder, ladder[1]!, 1)).toThrow(/still occupies level 1/);
  });

  it("promotes only once the senior rung actually clears", () => {
    const cleared = [hold("h1", 1, "released"), hold("h2", 2)];
    expect(() => assertCanPromote(cleared, cleared[1]!, 1)).not.toThrow();
  });

  it("is idempotent when promoting to the level already held", () => {
    expect(() => assertCanPromote([hold("h2", 2)], hold("h2", 2), 2)).not.toThrow();
  });

  it("refuses promotion to a more junior level", () => {
    expect(() => assertCanPromote([hold("h1", 1)], hold("h1", 1), 3)).toThrow(/more senior/);
  });

  it("cascades to the most senior hold below on release", () => {
    const ladder = [hold("h1", 1), hold("h3", 3), hold("h4", 4)];
    expect(cascadeCandidate(ladder, ladder[0]!)?.id).toBe("h3");
    expect(cascadeCandidate([hold("h1", 1)], hold("h1", 1))).toBeNull();
  });
});

describe("hold expiry is venue-local", () => {
  it("has not expired when it is still the deadline hour at the venue", () => {
    // 2026-09-15T05:00Z is 22:00 on the 14th in Los Angeles: not yet expired,
    // even though UTC has already rolled past the date.
    const expiring: HoldRow = { ...hold("h1", 1), expiresAt: "2026-09-15T06:00:00.000Z" };
    expect(isExpired(expiring, "America/Los_Angeles", new Date("2026-09-15T05:00:00.000Z"))).toBe(false);
  });

  it("expires for a European venue before it expires for a US one", () => {
    const expiring: HoldRow = { ...hold("h1", 1), expiresAt: "2026-09-14T23:30:00.000Z" };
    const now = new Date("2026-09-15T00:30:00.000Z");
    expect(isExpired(expiring, "Europe/Berlin", now)).toBe(true);
    expect(isExpired(expiring, "America/Los_Angeles", now)).toBe(true);
  });

  it("never expires a hold with no deadline", () => {
    expect(isExpired(hold("h1", 1), "Europe/London")).toBe(false);
  });
});
