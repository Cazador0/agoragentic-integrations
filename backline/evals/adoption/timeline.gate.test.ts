/**
 * THE ADOPTION GATE.
 *
 * The architecture review's most consequential finding was that all three
 * candidate designs sequenced email ingestion, calendar and data migration
 * AFTER the agent platform. That ordering is how CRM rollouts die: with no
 * email ingestion the activity timeline is empty, every touchpoint becomes
 * manual data entry, and the agency goes back to Outlook — no matter how good
 * the agent panel is.
 *
 * Re-ordering a roadmap document does not fix this, because roadmaps slip
 * toward whatever is most interesting to build. So the ordering is enforced
 * here instead:
 *
 *   CI runs this gate, and the agent-platform packages (@backline/mcp and the
 *   agent registry) are gated on it. Until a booking's timeline populates from
 *   ingested mail, the thing everyone wants to build cannot merge.
 *
 * Delete this file only with the same seriousness as deleting an auth check.
 */

import { describe, expect, it } from "vitest";
import {
  associateMessage, renderIcsFeed, reconcile, trigramSimilarity,
  type CalendarEvent, type InboundMessage,
} from "@backline/connectors";
import { ContentOrigin, PrincipalKind, Trust, labelTrust } from "@backline/domain";

const booking = { id: "b-9f2", uri: "crm://booking/b-9f2" };

const message = (over: Partial<InboundMessage> = {}): InboundMessage => ({
  messageId: "<a@promoter.test>",
  threadHeaders: [],
  from: "sam@promoter.test",
  to: ["bookings@agency.test"],
  subject: "Fillmore Sept 14 — holds",
  body: "Can we move the guarantee to 12k?",
  receivedAt: new Date("2026-07-01T09:00:00Z"),
  ...over,
});

describe("adoption gate: a booking's timeline populates from real email", () => {
  const noContact = () => null;
  const noThread = () => null;

  it("associates a reply deterministically via the outbound plus-tag", () => {
    const association = associateMessage(
      message({ to: ["bookings+booking.b-9f2@agency.test"] }),
      noContact, noThread,
    );
    expect(association.subjectUri).toBe(booking.uri);
    expect(association.confidence).toBe("explicit");
  });

  it("associates via an inline crm:// reference", () => {
    const association = associateMessage(
      message({ body: `Re: ${booking.uri} — confirming the date.` }),
      noContact, noThread,
    );
    expect(association.subjectUri).toBe(booking.uri);
    expect(association.confidence).toBe("explicit");
  });

  it("falls back to participant match, then to the unmatched queue", () => {
    const byParticipant = associateMessage(
      message(), (email) => (email === "sam@promoter.test" ? "crm://contact/c-1" : null), noThread,
    );
    expect(byParticipant.confidence).toBe("participant");

    const unmatched = associateMessage(message({ from: "nobody@nowhere.test" }), noContact, noThread);
    expect(unmatched.subjectUri).toBeNull();
    expect(unmatched.confidence).toBe("unmatched");
  });

  it("labels inbound mail UNTRUSTED so a promoter cannot instruct our agents", () => {
    expect(labelTrust({ origin: ContentOrigin.INBOUND_EMAIL })).toBe(Trust.UNTRUSTED);
  });

  it("labels agent-authored notes UNTRUSTED for the NEXT agent", () => {
    expect(
      labelTrust({ origin: ContentOrigin.OPERATOR_INPUT, authorPrincipalKind: PrincipalKind.AGENT_SESSION }),
    ).toBe(Trust.UNTRUSTED);
  });

  it("produces a timeline that is not empty", () => {
    const inbox = [
      message({ to: ["bookings+booking.b-9f2@agency.test"] }),
      message({ messageId: "<b@promoter.test>", body: `Following up on ${booking.uri}` }),
    ];
    const timeline = inbox
      .map((item) => associateMessage(item, noContact, noThread))
      .filter((association) => association.subjectUri === booking.uri);

    // The whole point of the gate.
    expect(timeline.length).toBeGreaterThan(0);
  });
});

describe("adoption gate: calendar ships before the agent platform", () => {
  const events: CalendarEvent[] = [
    { uid: "h-1", summary: "HOLD 1 — Test Band @ Fillmore", date: "2026-09-14",
      timezone: "America/Los_Angeles", tentative: true, location: "San Francisco" },
    { uid: "b-9f2", summary: "CONFIRMED — Test Band @ Fillmore", date: "2026-10-02",
      timezone: "America/Los_Angeles", tentative: false },
  ];

  it("emits a valid ICS feed", () => {
    const ics = renderIcsFeed("Test Band — 2026", events);
    expect(ics.startsWith("BEGIN:VCALENDAR")).toBe(true);
    expect(ics.trimEnd().endsWith("END:VCALENDAR")).toBe(true);
    expect(ics.split("\r\n").filter((line) => line === "BEGIN:VEVENT")).toHaveLength(2);
  });

  it("publishes holds as tentative so they grey a date without blocking it", () => {
    const ics = renderIcsFeed("Test Band", events);
    expect(ics).toContain("STATUS:TENTATIVE");
    expect(ics).toContain("TRANSP:TRANSPARENT");
    expect(ics).toContain("STATUS:CONFIRMED");
    expect(ics).toContain("TRANSP:OPAQUE");
  });

  it("escapes commas and semicolons rather than corrupting the feed", () => {
    const ics = renderIcsFeed("Test", [{ ...events[0]!, summary: "Band; with, punctuation" }]);
    expect(ics).toContain(String.raw`SUMMARY:Band\; with\, punctuation`);
  });
});

describe("adoption gate: migration and parallel-run exist", () => {
  it("scores fuzzy venue duplicates above distinct venues", () => {
    expect(trigramSimilarity("The Fillmore", "Fillmore")).toBeGreaterThan(0.6);
    expect(trigramSimilarity("The Fillmore", "Brooklyn Steel")).toBeLessThan(0.2);
  });

  it("reports drift against the incumbent system, including missing records", () => {
    const drift = reconcile(
      [{ id: "1", guarantee: 1000 }, { id: "2", guarantee: 500 }],
      [{ id: "1", guarantee: 1200 }],
      ["guarantee"],
    );
    expect(drift).toEqual([
      { recordId: "1", field: "guarantee", incumbentValue: 1000, backlineValue: 1200 },
      { recordId: "2", field: "*", incumbentValue: "present", backlineValue: "missing" },
    ]);
  });

  it("reports zero drift when the two systems agree (the cutover condition)", () => {
    const same = [{ id: "1", guarantee: 1000 }];
    expect(reconcile(same, same, ["guarantee"])).toEqual([]);
  });
});
