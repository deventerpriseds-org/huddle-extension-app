// WHAT:       Huddle half of the TaskOS<->Huddle calendar-ignore parity check: the shared fixture (verdicts produced
//             by journey's isIgnoredCalendarEvent) through Huddle's pure decision AND through the full calendar read
//             (getOwnerCalendarEvents with Graph fetch + the work feed stubbed) on BOTH paths.
// WHY:        Owner 2026-11-26 option A: Huddle applies the same decision TaskOS makes (AC-23, AC-24, AC-25).
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   journey-voice scripts/calendar-ignore-parity-gen.ts generated scripts/fixtures/calendar-ignore-parity.fixture.json.
// Run: bun scripts/calendar-ignore-parity.test.ts   (plain-script form like onedrive-feed.test.ts: `bun test` cannot
//      resolve parse5 here without node_modules, while `bun <file>` auto-installs it)
import assert from "node:assert/strict";
import { runTests, test } from "./lib/mini-test";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  fallbackIgnoreRules,
  isIgnoredByRules,
  parseIgnoreRules,
  type CalendarIgnoreRules,
} from "../src/features/huddle/lib/calendar/calendar-ignore";
import { mapFeedAppointments } from "../src/features/huddle/lib/external-feeds/onedrive-feed";

/** The SAME value is pinned in journey-voice supabase/functions/_shared/calendar-ignore-parity.test.ts. */
export const PARITY_FIXTURE_SHA256 = "18c15b8fadcadccc32435af37242b32aa5b231df46d903b9de96ab2c5cc11360";
const bytes = readFileSync(new URL("./fixtures/calendar-ignore-parity.fixture.json", import.meta.url));
type Row = { id: string; fallback: boolean; rules: CalendarIgnoreRules; event: Record<string, unknown>; expected: "IGNORE" | "KEEP" };
const rows: Row[] = JSON.parse(bytes.toString("utf8")).rows;
const huddleEvent = (e: Record<string, unknown>) => ({ subject: e.title, showAs: e.show_as, attendees: e.attendees, categories: e.categories });

test("PAR-H1 the fixture copy is byte-identical to journey's (sha256)", () => {
  assert.equal(createHash("sha256").update(bytes).digest("hex"), PARITY_FIXTURE_SHA256);
});

test("PAR-H2 (AC-23) Huddle's decision equals journey's verdict on every row", () => {
  assert.ok(rows.length >= 40);
  let n = 0;
  for (const r of rows) {
    // Fallback rows: Huddle's built-in fallback must BE journey's default rule resolveIgnoreRules({}).
    const rules = r.fallback ? fallbackIgnoreRules() : parseIgnoreRules(r.rules).rules;
    if (r.fallback) assert.deepEqual(rules, r.rules, `${r.id}: fallback equals journey default`);
    else assert.deepEqual(parseIgnoreRules(r.rules).bad, [], `${r.id}: journey's rules parse cleanly`);
    assert.equal(isIgnoredByRules(huddleEvent(r.event), rules) ? "IGNORE" : "KEEP", r.expected, r.id);
    n++;
  }
  console.log(`${n}/${rows.length} parity`);
});

// ---- AC-25: the full read, both paths ----
// Rows whose attendees carry `self` or an empty address cannot be expressed by Graph or by the feed's address
// strings (neither source has a self flag), so they are covered by PAR-H2 only.
const expressible = (r: Row) =>
  !r.fallback && !(Array.isArray(r.event.attendees) && (r.event.attendees as Array<Record<string, unknown>>).some((a) => a.self || !a.email));
const toGraph = (r: Row) => ({
  id: r.id,
  subject: r.event.title,
  start: { dateTime: "2026-11-09T10:00:00.0000000" },
  end: { dateTime: "2026-11-09T10:30:00.0000000" },
  isAllDay: false,
  showAs: r.event.show_as,
  categories: r.event.categories,
  attendees: Array.isArray(r.event.attendees)
    ? (r.event.attendees as Array<Record<string, unknown>>).map((a) => ({
        emailAddress: { address: a.email },
        type: a.resource ? "resource" : a.optional ? "optional" : "required",
      }))
    : r.event.attendees,
});
const toFeedRecord = (r: Row) => {
  const list = Array.isArray(r.event.attendees) ? (r.event.attendees as Array<Record<string, unknown>>) : [];
  return {
    id: r.id,
    subject: r.event.title,
    startWithTimeZone: "2026-11-09T10:00:00-05:00",
    endWithTimeZone: "2026-11-09T10:30:00-05:00",
    isAllDay: false,
    showAs: r.event.show_as,
    categories: r.event.categories,
    requiredAttendees: list.filter((a) => !a.resource).map((a) => a.email).join("; "),
    resourceAttendees: list.filter((a) => a.resource).map((a) => a.email).join("; "),
  };
};

test("PAR-H3 (AC-25) the FULL read keeps exactly the fixture's KEEP rows, EDS path and feed path", async () => {
  process.env.AZURE_TENANT_ID = "t";
  process.env.AZURE_CLIENT_ID = "c";
  process.env.AZURE_CLIENT_SECRET = "s";
  const ge = await import("../src/features/huddle/lib/email/graph-email.server");
  const groups = new Map<string, Row[]>();
  for (const r of rows.filter(expressible)) {
    const k = JSON.stringify(r.rules);
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  let checked = 0;
  for (const [k, group] of groups) {
    const rules = JSON.parse(k) as CalendarIgnoreRules;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("login.microsoftonline.com")) return new Response(JSON.stringify({ access_token: "APP" }), { status: 200 });
      if (url.includes("/calendarView")) return new Response(JSON.stringify({ value: group.map(toGraph) }), { status: 200 });
      return new Response("unexpected", { status: 500 });
    }) as typeof fetch;
    const r = await ge.getOwnerCalendarEvents(
      { caller: { entra_email: "owner@example.org" }, mailbox: "owner@example.org", startISO: "2026-11-09T00:00:00Z", endISO: "2026-11-10T00:00:00Z", timeZone: "America/New_York" },
      {
        loadRules: async () => ({ rules }),
        feed: async (_m, s, e, tz) => ({ events: mapFeedAppointments(group.map(toFeedRecord), "owner@example.org", s, e, tz), warnings: [] }),
      },
    );
    assert.equal(r.ok, true);
    const keep = group.filter((x) => x.expected === "KEEP").map((x) => x.id).sort();
    const eds = (r.events ?? []).filter((e) => !e.source).map((e) => e.id).sort();
    const feed = (r.events ?? []).filter((e) => e.source).map((e) => e.id.split(":").pop()).sort();
    assert.deepEqual(eds, keep, `EDS path, rules ${k}`);
    assert.deepEqual(feed, keep, `feed path, rules ${k}`);
    for (const e of r.events ?? []) assert.ok(!("attendees" in e) && !("categories" in e), "decision-only fields stripped");
    checked += group.length;
  }
  console.log(`${checked} rows through the full read on both paths`);
  assert.ok(checked >= 35);
});
await runTests();
