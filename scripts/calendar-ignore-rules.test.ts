// WHAT:       Tests the journey settings read (calendar-ignore-rules.server.ts: fallback, partial payloads, cache,
//             isolation, timeout) and the calendar read wiring (graph-email.server.ts: $select, mapping, one
//             decision on both paths, owner switch honoured, EDS failure).
// WHY:        Owner 2026-11-26 option A; .claude/ac-huddle-calendar-ignore.md AC-4..AC-22, AC-30, AC-31.
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   .claude/BUILD-huddle-calendar-ignore.md (counts, mutation results).
// Run: bun scripts/calendar-ignore-rules.test.ts
import assert from "node:assert/strict";
import { runTests, test } from "./lib/mini-test";
import {
  clearIgnoreRulesCache,
  IGNORE_RULES_TTL_MS,
  loadCalendarIgnoreRules,
} from "../src/features/huddle/lib/calendar/calendar-ignore-rules.server";
import { fallbackIgnoreRules, type CalendarIgnoreRules } from "../src/features/huddle/lib/calendar/calendar-ignore";
import { mapFeedAppointments } from "../src/features/huddle/lib/external-feeds/onedrive-feed";

const OWNER_RULES: CalendarIgnoreRules = { phrases: ["work block"], tentative: false, categories: ["purple category"], ownerEmails: ["dev@example.io"] };
const A = { entra_object_id: "oid-a", entra_email: "a@example.io" };
const B = { entra_object_id: "oid-b", entra_email: "b@example.io" };
const okOut = (o: unknown) => async () => ({ ok: true, output: JSON.stringify(o) });

async function captureErrors<T>(fn: () => Promise<T>): Promise<{ value: T; lines: string[] }> {
  const orig = console.error;
  const lines: string[] = [];
  console.error = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
  try {
    return { value: await fn(), lines };
  } finally {
    console.error = orig;
  }
}

test("AC-4 every journey failure takes the fallback, never throws, logs the KIND (no response text)", async () => {
  const failures: Array<[string, () => Promise<{ ok: boolean; output?: unknown; error?: string }>, RegExp]> = [
    ["http 502", async () => ({ ok: false, output: "{}", error: "journey /tool 502: SECRET-BODY" }), /\(http_502\)/],
    ["ok:false", async () => ({ ok: false, output: "{}", error: "tool failed SECRET-BODY" }), /\(ok_false\)/],
    ["throw", async () => { throw new TypeError("fetch failed SECRET-BODY"); }, /\(TypeError\)/],
    ["non-JSON output", async () => ({ ok: true, output: "<html>SECRET-BODY" }), /\(non_json_output\)/],
    ["wrong shape", async () => ({ ok: true, output: JSON.stringify(["SECRET-BODY"]) }), /\(bad_shape\)/],
  ];
  for (const [name, invoke, kind] of failures) {
    clearIgnoreRulesCache();
    const { value, lines } = await captureErrors(() => loadCalendarIgnoreRules(A, { invoke }));
    assert.deepEqual(value, { rules: fallbackIgnoreRules(), from: "fallback" }, name);
    assert.equal(lines.length, 1, `${name}: one log line`);
    assert.match(lines[0], kind, name);
    assert.doesNotMatch(lines[0], /SECRET-BODY/, `${name}: no response text`);
  }
});

test("AC-5 each field is validated independently; a bad categories value can only keep meetings", async () => {
  clearIgnoreRulesCache();
  const { value } = await captureErrors(() =>
    loadCalendarIgnoreRules(A, { invoke: okOut({ phrases: ["focus"], tentative: false, categories: "Purple category", ownerEmails: ["x@y.z"] }) }),
  );
  assert.deepEqual(value.rules, { phrases: ["focus"], tentative: false, categories: [], ownerEmails: ["x@y.z"] });
  clearIgnoreRulesCache();
  const v2 = await captureErrors(() => loadCalendarIgnoreRules(A, { invoke: okOut({ phrases: 3, tentative: "no", categories: ["Purple category"], ownerEmails: null }) }));
  assert.deepEqual(v2.value.rules, { phrases: ["work block"], tentative: true, categories: ["purple category"], ownerEmails: [] });
  assert.match(v2.lines[0], /phrases,tentative,ownerEmails/);
});

test("AC-6 no caller identity: fallback rule, zero journey calls", async () => {
  clearIgnoreRulesCache();
  let calls = 0;
  const invoke = async () => { calls++; return { ok: true, output: JSON.stringify(OWNER_RULES) }; };
  for (const c of [undefined, {}, { entra_email: "  " }]) assert.deepEqual((await loadCalendarIgnoreRules(c, { invoke })).rules, fallbackIgnoreRules());
  assert.equal(calls, 0);
});

test("AC-8 / AC-9 / AC-10 cache: 1 call per owner per 60 s, owners isolated, failures not cached", async () => {
  clearIgnoreRulesCache();
  let now = 1_000_000;
  const calls: string[] = [];
  const invoke = async (req: { caller: { entra_object_id?: string } }) => {
    calls.push(String(req.caller.entra_object_id));
    return { ok: true, output: JSON.stringify(req.caller.entra_object_id === "oid-b" ? { ...OWNER_RULES, phrases: ["b only"] } : OWNER_RULES) };
  };
  for (let i = 0; i < 3; i++) await loadCalendarIgnoreRules(A, { invoke, now: () => now });
  assert.equal(calls.length, 1, "3 reads, 1 call");
  const b = await loadCalendarIgnoreRules(B, { invoke, now: () => now });
  assert.deepEqual(b.rules.phrases, ["b only"], "B never gets A's rules");
  assert.equal(calls.length, 2);
  now += IGNORE_RULES_TTL_MS + 1_000;
  await loadCalendarIgnoreRules(A, { invoke, now: () => now });
  assert.equal(calls.length, 3, "after 61 s A is asked again");
  clearIgnoreRulesCache();
  let fail = true;
  const flaky = async () => (fail ? { ok: false, output: "{}", error: "x" } : { ok: true, output: JSON.stringify(OWNER_RULES) });
  const r1 = await captureErrors(() => loadCalendarIgnoreRules(A, { invoke: flaky }));
  assert.equal(r1.value.from, "fallback");
  fail = false;
  const r2 = await loadCalendarIgnoreRules(A, { invoke: flaky });
  assert.deepEqual(r2, { rules: OWNER_RULES, from: "owner" }, "the failure was not cached");
});

test("AC-12 a slow journey is bounded at 5 s and takes the fallback", async () => {
  clearIgnoreRulesCache();
  const t0 = Date.now();
  const { value, lines } = await captureErrors(() =>
    loadCalendarIgnoreRules(A, { invoke: () => new Promise((res) => setTimeout(() => res({ ok: true, output: JSON.stringify(OWNER_RULES) }), 10_000)) }),
  );
  const ms = Date.now() - t0;
  assert.ok(ms < 6_000 && ms >= 4_900, `waited ${ms} ms`);
  assert.equal(value.from, "fallback");
  assert.match(lines[0], /\(timeout\)/);
});

// ---- wiring through graph-email.server.ts ----
process.env.AZURE_TENANT_ID = "t";
process.env.AZURE_CLIENT_ID = "c";
process.env.AZURE_CLIENT_SECRET = "s";
const GROUP = [{ emailAddress: { address: "dev@example.io" } }, { emailAddress: { address: "dana@example.org" } }, { emailAddress: { address: "pat@example.org" } }];
const graphEvents = [
  { id: "ord", subject: "1:1 Andrew and Von", start: { dateTime: "2026-11-09T09:00:00.0000000" }, end: { dateTime: "2026-11-09T09:30:00.0000000" }, location: { displayName: "Room 1" }, isAllDay: false, organizer: { emailAddress: { name: "Andrew" } }, showAs: "busy" },
  { id: "tgrp", subject: "Platform Weekly", start: { dateTime: "2026-11-09T10:00:00.0000000" }, end: { dateTime: "2026-11-09T11:00:00.0000000" }, isAllDay: false, showAs: "Tentative", attendees: GROUP },
  { id: "purple", subject: "Story Point Poker", start: { dateTime: "2026-11-09T12:00:00.0000000" }, end: { dateTime: "2026-11-09T13:00:00.0000000" }, isAllDay: false, showAs: "busy", categories: ["Purple category"] },
  { id: "wb", subject: "Work Block 1", start: { dateTime: "2026-11-09T14:00:00.0000000" }, end: { dateTime: "2026-11-09T15:00:00.0000000" }, isAllDay: false, showAs: "busy" },
];
let lastUrl = "";
const stubGraph = (status = 200) => {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("login.microsoftonline.com")) return new Response(JSON.stringify({ access_token: "APP" }), { status: 200 });
    if (url.includes("/calendarView")) {
      lastUrl = url;
      return status === 200 ? new Response(JSON.stringify({ value: graphEvents }), { status: 200 }) : new Response(JSON.stringify({ error: { message: "denied" } }), { status });
    }
    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;
};
const ARGS = { caller: { entra_email: "dev@example.io" }, mailbox: "dev@example.io", startISO: "2026-11-09T00:00:00Z", endISO: "2026-11-10T00:00:00Z", timeZone: "America/New_York" };
const feedRecs = [
  { id: "F-T", subject: "Work group invite", startWithTimeZone: "2026-11-09T16:00:00-05:00", endWithTimeZone: "2026-11-09T17:00:00-05:00", showAs: "Tentative", requiredAttendees: "work@example.org; dana@example.org; pat@example.org" },
  { id: "F-P", subject: "Purple work thing", startWithTimeZone: "2026-11-09T17:00:00-05:00", endWithTimeZone: "2026-11-09T17:30:00-05:00", showAs: "Busy", categories: ["Purple category"] },
];
const feedStub = async (_m: unknown, s: string, e: string, tz: string) => ({ events: mapFeedAppointments(feedRecs, "work@example.org", s, e, tz), warnings: [] as string[] });

test("AC-13 Graph $select asks for categories and attendees; the raw mapping carries them", async () => {
  stubGraph();
  const ge = await import("../src/features/huddle/lib/email/graph-email.server");
  await ge.getGraphCalendarEvents({ mailbox: "dev@example.io", startISO: ARGS.startISO, endISO: ARGS.endISO });
  const select = decodeURIComponent(/\$select=([^&]+)/.exec(lastUrl)![1]).split(",");
  for (const f of ["id", "subject", "start", "end", "location", "isAllDay", "organizer", "showAs", "categories", "attendees"]) assert.ok(select.includes(f), f);
});

test("AC-14 the feed mapper carries journey feedCategories / feedAttendees exactly", () => {
  const recs = [
    { id: "SOLO", subject: "s", startWithTimeZone: "2026-11-09T09:00:00-05:00", endWithTimeZone: "2026-11-09T09:30:00-05:00", requiredAttendees: "Von <work@example.org>", optionalAttendees: "", resourceAttendees: "", categories: ["Purple category", 7, ""] },
    { id: "ONE", subject: "o", startWithTimeZone: "2026-11-09T09:00:00-05:00", endWithTimeZone: "2026-11-09T09:30:00-05:00", requiredAttendees: "work@example.org; dana@example.org", optionalAttendees: "", resourceAttendees: "room4@example.org" },
    { id: "GRP", subject: "g", startWithTimeZone: "2026-11-09T09:00:00-05:00", endWithTimeZone: "2026-11-09T09:30:00-05:00", requiredAttendees: "work@example.org; dana@example.org; pat@example.org", optionalAttendees: "Opt Person <opt@example.org>, dana@example.org", categories: "Purple category" },
  ];
  const out = mapFeedAppointments(recs, "work@example.org", ARGS.startISO, ARGS.endISO, "UTC");
  // Expected values pasted from journey: node -e import("./supabase/functions/_shared/onedrive-feed.ts") feedAttendees/feedCategories on the same records (2026-11-26).
  assert.deepEqual(out.map((e) => e.attendees), [
    [{ email: "work@example.org" }],
    [{ email: "work@example.org" }, { email: "dana@example.org" }, { email: "room4@example.org", resource: true }],
    [{ email: "work@example.org" }, { email: "dana@example.org" }, { email: "pat@example.org" }, { email: "opt@example.org", optional: true }],
  ]);
  assert.deepEqual(out.map((e) => e.categories), [["Purple category"], [], []]);
});

test("AC-7 / AC-15 / AC-16 / AC-22 one rules load per read; Purple dropped and owner's tentative-OFF honoured on BOTH paths", async () => {
  stubGraph();
  clearIgnoreRulesCache();
  const ge = await import("../src/features/huddle/lib/email/graph-email.server");
  let calls = 0;
  const loadRules = async (c: typeof ARGS.caller | undefined) => {
    return loadCalendarIgnoreRules(c, { invoke: async () => { calls++; return { ok: true, output: JSON.stringify(OWNER_RULES) }; } });
  };
  const r = await ge.getOwnerCalendarEvents(ARGS, { loadRules, feed: feedStub });
  assert.equal(calls, 1, "journey asked once for EDS + feed");
  const ids = (r.events ?? []).map((e) => e.id.replace(/^feed:[^:]+:/, "feed:"));
  assert.deepEqual(ids.sort(), ["feed:F-T", "ord", "tgrp"], "Purple + Work Block gone; tentative groups kept (switch off)");
  // The same read under the fallback rule (journey down): tentative groups dropped, Purple back -- G-1 trade-off.
  clearIgnoreRulesCache();
  const fb = await captureErrors(() =>
    ge.getOwnerCalendarEvents(ARGS, { loadRules: (c) => loadCalendarIgnoreRules(c, { invoke: async () => ({ ok: false, output: "{}", error: "journey /tool 503: x" }) }), feed: feedStub }),
  );
  assert.deepEqual((fb.value.events ?? []).map((e) => e.id.replace(/^feed:[^:]+:/, "feed:")).sort(), ["feed:F-P", "ord", "purple"]);
  assert.ok((fb.value.events ?? []).length > 0, "never an empty calendar on failure");
});

test("AC-30 an ordinary meeting keeps exactly the fields it had before (no new keys leak)", async () => {
  stubGraph();
  const ge = await import("../src/features/huddle/lib/email/graph-email.server");
  const r = await ge.getOwnerCalendarEvents(ARGS, { loadRules: async () => ({ rules: OWNER_RULES }), feed: async () => ({ events: [], warnings: [] }) });
  assert.deepEqual(r.events?.find((e) => e.id === "ord"), {
    id: "ord", subject: "1:1 Andrew and Von", start: "2026-11-09T09:00:00.0000000", end: "2026-11-09T09:30:00.0000000",
    location: "Room 1", isAllDay: false, organizer: "Andrew", showAs: "busy",
  });
});

test("AC-31 EDS Graph fails: ok:false + error, loaded feed events still returned and filtered by the owner rules", async () => {
  stubGraph(403);
  const ge = await import("../src/features/huddle/lib/email/graph-email.server");
  const r = await ge.getOwnerCalendarEvents(ARGS, { loadRules: async () => ({ rules: OWNER_RULES }), feed: feedStub });
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /403/);
  assert.deepEqual((r.events ?? []).map((e) => e.id), ["feed:work@example.org:F-T"]);
});

test("AC-6 (wiring) getGraphCalendarEvents with no rules uses journey's default (tentative group dropped, Purple kept)", async () => {
  stubGraph();
  const ge = await import("../src/features/huddle/lib/email/graph-email.server");
  const r = await ge.getGraphCalendarEvents({ mailbox: "dev@example.io", startISO: ARGS.startISO, endISO: ARGS.endISO });
  assert.deepEqual((r.events ?? []).map((e) => e.id), ["ord", "purple"]);
});

await runTests();
