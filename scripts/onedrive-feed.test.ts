// WHAT:       Offline tests for the work-mailbox OneDrive file feed (config, validation, mapping,
//             screening, calendar time zones/windows) and the "feed off = unchanged" regression guard.
// WHY:        The feed decides which work emails reach Iris and which work meetings the owner hears
//             about; a wrong verdict either floods him or hides a meeting. Synthetic fixtures only.
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   .claude/actions.md ACT:trinnex-onedrive-feed.
// Run: bun scripts/onedrive-feed.test.ts
import {
  coversWindow,
  eligibleFeedMessages,
  feedBelongsTo,
  isFeedId,
  mapFeedAppointments,
  mapFeedMessage,
  parseFeedsConfig,
  validateAppointmentSnapshot,
  validateEmailSnapshot,
  zonedGraphDateTime,
} from "../src/features/huddle/lib/external-feeds/onedrive-feed";
import { INBOUND_EMAIL_MODE_DEFAULT, screenMessage } from "../src/features/huddle/lib/email/inbound-email";

let fail = 0;
const t = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : `\n   got:  ${JSON.stringify(got)}\n   want: ${JSON.stringify(want)}`}`);
};

// Placeholder identities only (public repo).
const WORK = "owner@work.example";
const EDS = "owner@eds.example";
const cfgJson = {
  enabled: true,
  ownerLogins: ["login@eds.example", EDS],
  driveUser: EDS,
  mailbox: WORK,
  sourceLogin: "login@work.example",
  synthetic: true,
  subjectPrefix: "HUDDLE-PA-SBX-",
};
const cfg = parseFeedsConfig(JSON.stringify(cfgJson))!;

console.log("A. CONFIG — fail closed");
t("A1 absent -> off", parseFeedsConfig(undefined), null);
t("A2 not JSON -> off", parseFeedsConfig("{nope"), null);
t("A3 enabled:false -> off", parseFeedsConfig(JSON.stringify({ ...cfgJson, enabled: false })), null);
t("A4 synthetic without its subject prefix -> off", parseFeedsConfig(JSON.stringify({ ...cfgJson, subjectPrefix: "" })), null);
t("A5 missing mailbox binding -> off", parseFeedsConfig(JSON.stringify({ ...cfgJson, mailbox: "" })), null);
t("A6 default paths + default synthetic", [cfg.email.path, cfg.appointments.path, cfg.synthetic], [
  "/automation/email/emails.json",
  "/automation/appointments/appointments.json",
  true,
]);
t("A7 a path with .. is disabled", parseFeedsConfig(JSON.stringify({ ...cfgJson, email: { path: "/a/../b.json" } }))!.email.enabled, false);
t("A8 bound owner matches either identity, others do not", [feedBelongsTo(cfg, "LOGIN@eds.example"), feedBelongsTo(cfg, "x@eds.example", null)], [true, false]);

console.log("B. VALIDATION — partial or foreign is never 'empty'");
const msg = (over: Record<string, unknown> = {}) => ({
  id: "AAMk-1",
  receivedDateTime: "2026-11-08T14:00:00Z",
  subject: "HUDDLE-PA-SBX- can we meet Tuesday?",
  bodyPreview: "Hi Von, can we meet Tuesday?",
  body: "<p>Hi Von,</p><p>Can we meet Tuesday?</p>",
  isHtml: true,
  from: "colleague@partner.example",
  conversationId: "conv-1",
  internetMessageHeaders: [{ name: "From", value: '"Pat Colleague" <colleague@partner.example>' }],
  ...over,
});
const env = (over: Record<string, unknown> = {}, records: unknown[] = [msg()]) => ({
  schema_version: "1.0",
  feed_type: "email_snapshot",
  source: "power-automate-outlook",
  mailbox: WORK,
  source_login: "login@work.example",
  synthetic: true,
  subject_prefix: "HUDDLE-PA-SBX-",
  published_utc: "2026-11-08T14:01:00Z",
  window_start_utc: "2026-11-01T00:00:00Z",
  snapshot: { value: records },
  complete: true,
  ...over,
});
const NOW = Date.parse("2026-11-08T15:00:00Z"); // fixtures are dated this day
t("B1 good snapshot passes", validateEmailSnapshot(env(), cfg, NOW).ok, true);
const reason = (j: unknown) => {
  const v = validateEmailSnapshot(j, cfg, NOW);
  return v.ok ? "ok" : v.reason;
};
t("B2 not an object", reason([1]), "not_json");
t("B3 schema 2.x refused", reason(env({ schema_version: "2.0" })), "wrong_schema");
t("B4 appointments file as email refused", reason(env({ feed_type: "appointments_snapshot" })), "wrong_feed_type");
t("B5 another mailbox refused", reason(env({ mailbox: "someone@else.example" })), "wrong_mailbox");
t("B6 another source login refused", reason(env({ source_login: "x@work.example" })), "wrong_source_login");
t("B7 live data while configured synthetic refused", reason(env({ synthetic: false })), "synthetic_mismatch");
t("B8 complete=false is partial, refused", reason(env({ complete: false })), "incomplete");
t("B9 bad published_utc refused", reason(env({ published_utc: "yesterday" })), "bad_timestamps");
t("B10 1000 records refused (cap)", reason(env({}, Array.from({ length: 1000 }, (_, i) => msg({ id: `m${i}` })))), "too_many_records");
t("B11 a record without id is SKIPPED, the rest still used", (() => {
  const v = validateEmailSnapshot(env({}, [msg({ id: "" }), msg({ id: "ok" })]), cfg, NOW);
  return v.ok ? [v.snapshot.records.length, v.snapshot.skipped] : v.reason;
})(), [1, 1]);
t("B15 a different source refused", reason(env({ source: "something-else" })), "wrong_source");
t("B16 published in the future refused", reason(env({ published_utc: "2030-01-01T00:00:00Z" })), "bad_timestamps");
t("B17 email window starting after publication refused", reason(env({ window_start_utc: "2026-11-09T00:00:00Z" })), "bad_timestamps");
t("B18 live config refuses a file still marked synthetic", (() => {
  const live = parseFeedsConfig(JSON.stringify({ ...cfgJson, synthetic: false, subjectPrefix: "" }))!;
  const v = validateEmailSnapshot(env(), live, NOW);
  return v.ok ? "ok" : v.reason;
})(), "synthetic_mismatch");
t("B12 empty but complete is a valid EMPTY inbox", reason(env({}, [])), "ok");
const apptEnv = (over: Record<string, unknown> = {}) => ({
  ...env({ feed_type: "appointments_snapshot", window_end_utc: "2027-01-07T00:00:00Z", calendar_name: "cal" }, []),
  ...over,
});
t("B13 appointments: missing window_end refused", (() => {
  const v = validateAppointmentSnapshot(apptEnv({ window_end_utc: undefined }), cfg, NOW);
  return v.ok ? "ok" : v.reason;
})(), "bad_timestamps");
t("B14 appointments: good passes", validateAppointmentSnapshot(apptEnv(), cfg, NOW).ok, true);

console.log("C. MAPPING — the ORIGINAL message, with a feed id");
const verdict0 = (over: Record<string, unknown>) =>
  screenMessage(mapFeedMessage(msg({ bodyPreview: "", isHtml: true, internetMessageHeaders: [], ...over }), WORK), INBOUND_EMAIL_MODE_DEFAULT, WORK).reason;
const m1 = mapFeedMessage(msg(), WORK);
t("C1 feed id, never an EDS Graph id", [m1.id, isFeedId(m1.id), isFeedId("AAMkAGUw")], [`feed:${WORK}:AAMk-1`, true, false]);
t("C2 sender from the record, display name from the original From header", [m1.fromAddress, m1.fromName], ["colleague@partner.example", "Pat Colleague"]);
t("C3 HTML body becomes words", m1.bodyText, "Hi Von,\n Can we meet Tuesday?");
t("C4 inferenceClassification left undefined, not invented", m1.inferenceClassification, undefined);
t("C6 capitalised header items {Name,Value} are read too", screenMessage(mapFeedMessage(msg({ internetMessageHeaders: [{ Name: "List-Unsubscribe", Value: "<x>" }] }), WORK), INBOUND_EMAIL_MODE_DEFAULT, WORK).reason, "bulk-header");
t("C7 quoted <blockquote> history is not this email's ask", verdict0({ body: "<div>Thanks!</div><blockquote>Can we meet Tuesday?</blockquote>", subject: "HUDDLE-PA-SBX- Re: meeting" }), "no-ask");
t("C8 Outlook reply header block and everything after it dropped", verdict0({ body: '<p>Sounds good.</p><div id="divRplyFwdMsg">From: x Sent: y</div><p>Can you send it?</p>', subject: "HUDDLE-PA-SBX- Re: files" }), "no-ask");
t("C10 nested quote: the outer quote's tail does not leak", verdict0({ body: "<div>Thanks!</div><blockquote>a<blockquote>b?</blockquote>Can we meet Tuesday?</blockquote>", subject: "HUDDLE-PA-SBX- Re: q" }), "no-ask");
t("C11 unclosed quote swallows the rest; text before it is kept", verdict0({ body: "<p>Can you send it?</p><blockquote>old words", subject: "HUDDLE-PA-SBX- Re: q2" }) !== "no-ask", true);
t("C9 a link's ? is not a question", verdict0({ body: "<p>Notes at https://x.example/a?b=1 for you.</p>", subject: "HUDDLE-PA-SBX- notes" }), "no-ask");
t("C5 object-shaped from also works", mapFeedMessage(msg({ from: { emailAddress: { name: "A B", address: "A@B.example" } } }), WORK).fromAddress, "a@b.example");

console.log("D. SCREENING — the SAME screenMessage on the original (spelling table)");
// Exactly what the inbox watch does for feed mail: screenMessage against the work mailbox, nothing else.
const verdict = (over: Record<string, unknown>) =>
  screenMessage(mapFeedMessage(msg(over), WORK), INBOUND_EMAIL_MODE_DEFAULT, WORK).reason;
t("D1 a real person asking something -> kept", verdict({}), "from a person and asks something");
t("D2 noreply@ -> automated", verdict({ from: "noreply@partner.example", internetMessageHeaders: [] }), "automated-sender");
t("D3 notifications@ -> automated", verdict({ from: "notifications@partner.example", internetMessageHeaders: [] }), "automated-sender");
t("D4 List-Unsubscribe header -> bulk", verdict({ internetMessageHeaders: [{ name: "List-Unsubscribe", value: "<mailto:x>" }] }), "bulk-header");
t("D5 Auto-Submitted: auto-generated -> bulk", verdict({ internetMessageHeaders: [{ name: "Auto-Submitted", value: "auto-generated" }] }), "bulk-header");
t("D6 from the WORK address itself -> self (screenMessage's own rule)", verdict({ from: WORK, internetMessageHeaders: [] }), "self");
t("D7 from his EDS address INTO the work mailbox -> screened like any sender (owner: no extra self rule)", verdict({ from: EDS, internetMessageHeaders: [] }), "from a person and asks something");
t("D8 a person with no ask -> no-ask (needs-reply mode)", verdict({ subject: "HUDDLE-PA-SBX- fyi", bodyPreview: "Notes attached.", body: "Notes attached.", isHtml: false }), "no-ask");

console.log("E. ELIGIBILITY — lookback, notBefore, synthetic prefix, dedupe");
{
  const a = mapFeedMessage(msg({ id: "a" }), WORK);
  const old = mapFeedMessage(msg({ id: "old", receivedDateTime: "2026-11-01T00:00:00Z" }), WORK);
  const real = mapFeedMessage(msg({ id: "real", subject: "Quarterly numbers?" }), WORK);
  const dup = mapFeedMessage(msg({ id: "a" }), WORK);
  t("E1 only in-window, prefixed, once each", eligibleFeedMessages([a, old, real, dup], cfg, "2026-11-08T00:00:00Z").map((m) => m.id), [`feed:${WORK}:a`]);
  const live = parseFeedsConfig(JSON.stringify({ ...cfgJson, synthetic: false, subjectPrefix: "" }))!;
  t("E2 live config drops the prefix rule", eligibleFeedMessages([a, real], live, "2026-11-08T00:00:00Z").length, 2);
  const nb = parseFeedsConfig(JSON.stringify({ ...cfgJson, notBeforeUtc: "2026-11-08T15:00:00Z" }))!;
  t("E3 notBefore stops replaying old test mail", eligibleFeedMessages([a], nb, "2026-11-08T00:00:00Z").length, 0);
}

console.log("F. CALENDAR — Graph-identical times, windows, all-day, coverage");
{
  const ev = (over: Record<string, unknown>) => ({
    id: "E1",
    subject: "Standup",
    startWithTimeZone: "2026-11-09T09:00:00-05:00",
    endWithTimeZone: "2026-11-09T09:30:00-05:00",
    isAllDay: false,
    organizer: "lead@work.example",
    location: "Room 1",
    ...over,
  });
  const read = (recs: Record<string, unknown>[], s: string, e: string, tz: string) => mapFeedAppointments(recs, WORK, s, e, tz);
  const ny = read([ev({})], "2026-11-09T00:00:00", "2026-11-10T00:00:00", "America/New_York")[0];
  t("F1 9:00 New York read in New York", [ny.start, ny.end], ["2026-11-09T09:00:00.0000000", "2026-11-09T09:30:00.0000000"]);
  t("F2 same event read in UTC (EST, -5)", read([ev({})], "2026-11-09T00:00:00", "2026-11-10T00:00:00", "UTC")[0].start, "2026-11-09T14:00:00.0000000");
  t("F3 summer (EDT, -4) in UTC", read([ev({ startWithTimeZone: "2026-07-09T09:00:00-04:00", endWithTimeZone: "2026-07-09T09:30:00-04:00" })], "2026-07-09T00:00:00", "2026-07-10T00:00:00", "UTC")[0].start, "2026-07-09T13:00:00.0000000");
  t("F4 feed id + source + organizer", [ny.id, ny.source, ny.organizer, ny.location], [`feed:${WORK}:E1`, WORK, "lead@work.example", "Room 1"]);
  t("F5 an event ending exactly at the window start is excluded", read([ev({})], "2026-11-09T14:30:00Z", "2026-11-09T20:00:00Z", "UTC").length, 0);
  t("F6 an event straddling the window start is included", read([ev({})], "2026-11-09T14:15:00Z", "2026-11-09T20:00:00Z", "UTC").length, 1);
  t("F7 a window bound with no offset is UTC (like Graph)", read([ev({})], "2026-11-09T14:00:00", "2026-11-09T14:10:00", "UTC").length, 1);
  const allDay = read([ev({ isAllDay: true, startWithTimeZone: "2026-11-10T00:00:00+05:00", endWithTimeZone: "2026-11-11T00:00:00+05:00" })], "2026-11-09T00:00:00Z", "2026-11-12T00:00:00Z", "UTC")[0];
  t("F8 all-day keeps its own date (no zone shift)", [allDay.start, allDay.isAllDay], ["2026-11-10T00:00:00.0000000", true]);
  t("F9 coverage", [
    coversWindow({ windowStartUtc: "2026-11-01T00:00:00Z", windowEndUtc: "2027-01-07T00:00:00Z" }, "2026-11-09T00:00:00Z", "2026-11-10T00:00:00Z"),
    coversWindow({ windowStartUtc: "2026-11-01T00:00:00Z", windowEndUtc: "2027-01-07T00:00:00Z" }, "2027-02-01T00:00:00Z", "2027-02-02T00:00:00Z"),
  ], [true, false]);
  t("F10 unknown time zone -> null, never a wrong time", zonedGraphDateTime("2026-11-09T14:00:00Z", "Not/AZone"), null);
}

console.log("G. BRIEF COMPAT — the brief's parser reads feed times back to the same instant");
{
  process.env.AZURE_PG_URL = process.env.AZURE_PG_URL ?? "";
  const { graphUtcToIso } = await import("../src/features/huddle/lib/tasks/schedule-brief.server");
  const iso = "2026-11-09T14:00:00.000Z";
  t("G1 graphUtcToIso(zonedGraphDateTime(x, 'UTC')) === x", graphUtcToIso(zonedGraphDateTime(iso, "UTC")), iso);
}

console.log("H. FEED OFF — the calendar answer is exactly the Graph answer");
{
  delete process.env.HUDDLE_ONEDRIVE_FEEDS;
  process.env.AZURE_TENANT_ID = "t";
  process.env.AZURE_CLIENT_ID = "c";
  process.env.AZURE_CLIENT_SECRET = "s";
  const graphEvent = { id: "g1", subject: "EDS sync", start: { dateTime: "2026-11-09T10:00:00.0000000" }, end: { dateTime: "2026-11-09T10:30:00.0000000" }, isAllDay: false };
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("login.microsoftonline.com")) return new Response(JSON.stringify({ access_token: "APP" }), { status: 200 });
    if (url.includes("/calendarView")) return new Response(JSON.stringify({ value: [graphEvent] }), { status: 200 });
    return new Response("unexpected " + url, { status: 500 });
  }) as typeof fetch;
  const ge = await import("../src/features/huddle/lib/email/graph-email.server");
  const args = { mailbox: EDS, startISO: "2026-11-09T00:00:00", endISO: "2026-11-10T00:00:00", timeZone: "America/New_York" };
  const plain = await ge.getGraphCalendarEvents(args);
  const owner = await ge.getOwnerCalendarEvents({ ...args, caller: { entra_email: "login@eds.example" } });
  t("H1 identical result with the feed unconfigured", owner, plain);
}

console.log("I. EDS FAILS, FEED LOADS — the error is reported AND the work meetings are kept");
{
  delete process.env.AZURE_PG_URL; // state store unavailable: the read must still work (logged, not fatal)
  process.env.HUDDLE_ONEDRIVE_FEEDS = JSON.stringify(cfgJson);
  const appt = {
    schema_version: "1.0",
    feed_type: "appointments_snapshot",
    source: "power-automate-outlook",
    mailbox: WORK,
    source_login: "login@work.example",
    synthetic: true,
    published_utc: new Date(Date.now() - 3_600_000).toISOString(),
    window_start_utc: "2026-11-01T00:00:00Z",
    window_end_utc: "2027-01-07T00:00:00Z",
    snapshot: { value: [{ id: "W1", subject: "Work standup", startWithTimeZone: "2026-11-09T09:00:00-05:00", endWithTimeZone: "2026-11-09T09:30:00-05:00", isAllDay: false }] },
    complete: true,
  };
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("login.microsoftonline.com")) return new Response(JSON.stringify({ access_token: "APP" }), { status: 200 });
    if (url.includes("/calendarView")) return new Response(JSON.stringify({ error: { message: "denied" } }), { status: 403 });
    if (url.includes("/drive/root:") && url.endsWith(":/content")) return new Response(JSON.stringify(appt), { status: 200 });
    if (url.includes("/drive/root:")) return new Response(JSON.stringify({ eTag: "e1", size: 500 }), { status: 200 });
    return new Response("unexpected " + url, { status: 500 });
  }) as typeof fetch;
  const ge = await import("../src/features/huddle/lib/email/graph-email.server");
  const r = await ge.getOwnerCalendarEvents({ caller: { entra_email: "login@eds.example" }, mailbox: EDS, startISO: "2026-11-09T00:00:00Z", endISO: "2026-11-10T00:00:00Z", timeZone: "America/New_York" });
  t("I1 ok:false with the EDS error, work meeting still returned", [r.ok, /403/.test(r.error ?? ""), (r.events ?? []).map((e) => e.subject)], [false, true, ["Work standup"]]);
  delete process.env.HUDDLE_ONEDRIVE_FEEDS;
}

if (fail) {
  console.log(`\n${fail} FAILED`);
  process.exit(1);
}
console.log("\nall passed");
