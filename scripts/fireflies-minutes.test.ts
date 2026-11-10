// WHAT:       Offline checks for the Fireflies -> meeting-minutes pipeline: the webhook signature, both
//             minutes modes (and that neither falls back to the other), missing summary / transcript,
//             duplicate + concurrent delivery (one email), email and OneDrive independence, and safe HTML.
// WHY:        Owner handoff 2026-11-10 lists exactly these as the required tests. The DB, Graph, Fireflies
//             and the model are replaced with in-memory fakes, so this runs with no network and no secrets.
//             Run: bun scripts/fireflies-minutes.test.ts
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   .claude/actions.md ACT:fireflies-minutes.
import { mock } from "bun:test";

let fail = 0;
const t = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : `\n   got:  ${JSON.stringify(got)}\n   want: ${JSON.stringify(want)}`}`);
};

const SECRET = "test-signing-secret";
process.env.FIREFLIES_WEBHOOK_SECRET = SECRET;
process.env.FIREFLIES_API_KEY = "test-api-key";
process.env.FIREFLIES_ONEDRIVE_MAILBOX = "owner@example.com";
process.env.AZURE_PG_URL = "postgres://fake/fake"; // the store is faked below; the worker only checks it is set

// ---------------------------------------------------------------- fakes
type Row = Record<string, any>;
const db = { settings: new Map<string, Row>(), meetings: new Map<string, Row>() };
const sent: Array<{ to: string[]; subject: string; body: string }> = [];
let sendOk = true;
let modelCalls = 0;
let modelReply = "";
const uploads: string[] = [];
let uploadStatus = 201;

let settingsDown = false;
let clock = Date.parse("2026-11-10T15:00:00Z");
const nowIso = () => new Date(clock).toISOString();
// In-memory twin of minutes-store.server's SQL (same queue / lease semantics).
mock.module("../src/features/huddle/lib/fireflies/minutes-store.server", () => ({
  getMinutesSettings: async (o: string) => {
    if (settingsDown) throw new Error("settings_db_down");
    return db.settings.get(o.toLowerCase()) ?? null;
  },
  setMinutesSettings: async (o: string, s: Row) => void db.settings.set(o.toLowerCase(), s),
  recordWebhook: async (id: string, owner: string, event: string, rep: number | null) => {
    const r = db.meetings.get(id);
    if (!r) {
      db.meetings.set(id, {
        meeting_id: id, owner_email: owner, deliveries: 1, last_event: event, last_reprocessed_at: rep,
        pending_email: true, pending_onedrive: true, attempts: 0, next_attempt_at: clock, lease_until: null,
        email_status: null, content_hash: null, emails_sent: 0, onedrive_status: null, created_at: nowIso(),
      });
      return { queued: true };
    }
    const newer = rep != null && rep > (r.last_reprocessed_at ?? 0);
    r.deliveries++;
    r.last_event = event;
    r.last_reprocessed_at = Math.max(r.last_reprocessed_at ?? 0, rep ?? 0) || null;
    r.pending_onedrive = r.pending_onedrive || newer || r.onedrive_status !== "saved" || event === "meeting.summarized";
    r.pending_email = r.pending_email || newer || r.email_status !== "sent";
    r.attempts = 0;
    r.next_attempt_at = clock;
    return { queued: r.pending_email || r.pending_onedrive };
  },
  claimDueMeetings: async (limit: number, max = 12) => {
    const out: Row[] = [];
    for (const r of db.meetings.values()) {
      if (out.length >= limit) break;
      if ((r.pending_email || r.pending_onedrive) && r.next_attempt_at <= clock && (r.lease_until == null || r.lease_until < clock) && r.attempts < max) {
        r.lease_until = clock + 180_000; // synchronous check-and-set == the SQL's SKIP LOCKED + lease
        r.attempts++;
        out.push({ ...r });
      }
    }
    return out;
  },
  releaseMeeting: async (id: string, sec: number) => {
    const r = db.meetings.get(id)!;
    r.lease_until = null;
    r.next_attempt_at = clock + sec * 1000;
  },
  recordMeetingInfo: async (id: string, title: string | null) => void (db.meetings.get(id)!.title = title),
  recordEmailSent: async (id: string, x: Row) => {
    const r = db.meetings.get(id)!;
    Object.assign(r, { email_status: "sent", pending_email: false, summary_kind: x.kind, content_hash: x.hash, email_error: null });
    r.emails_sent++;
  },
  recordEmailNotNeeded: async (id: string) => void (db.meetings.get(id)!.pending_email = false),
  recordEmailProblem: async (id: string, _s: string, err: string, final: boolean) => {
    const r = db.meetings.get(id)!;
    r.email_error = err;
    if (final) r.pending_email = false;
    if (r.email_status !== "sent" && final) r.email_status = "failed";
  },
  recordOneDrive: async (id: string, x: Row) => {
    const r = db.meetings.get(id)!;
    r.onedrive_status = x.ok ? "saved" : "failed";
    r.onedrive_path = x.path ?? r.onedrive_path;
    if (x.ok) r.pending_onedrive = false;
  },
  listRecentMeetings: async () => [...db.meetings.values()],
}));
mock.module("../src/features/huddle/lib/email/graph-email.server", () => ({
  emailFromOptions: () => ["sender@example.com"],
  graphEmailConfigured: () => true,
  getAppToken: async () => "graph-token",
  sendGraphEmail: async (i: { to: string[]; subject: string; body: string }) => {
    await new Promise((r) => setTimeout(r, 15)); // real Graph latency: lets concurrent deliveries overlap
    sent.push({ to: i.to, subject: i.subject, body: i.body });
    return sendOk ? { ok: true, to: i.to } : { ok: false, error: "Graph sendMail failed (500)" };
  },
}));
mock.module("../src/features/huddle/lib/identity/identity.server", () => ({
  getSelfEmailRows: async () => [
    { email: "owner@example.com", source: "entra" },
    { email: "owner@work.example", source: "linked" },
  ],
}));
// The existing send gate's verdict per address: the Entra address auto-sends, the other one would draft.
mock.module("../src/features/huddle/lib/fireflies/recipient-check.server", () => ({
  sendableTiers: async (_o: string, list?: string[]) =>
    (list ?? ["owner@example.com", "owner@work.example"]).map((address) => ({
      address,
      tier: address === "owner@example.com" ? "auto" : "on-request",
      sends: address === "owner@example.com",
    })),
}));
mock.module("../src/features/huddle/lib/openai-responses.server", () => ({
  callOpenAIResponses: async (i: { model: string; transcript: Array<{ content: string }> }) => {
    modelCalls++;
    lastModelInput = `${i.model}\n${i.transcript[0].content}`;
    return { text: modelReply, reasoning: [] };
  },
}));
let lastModelInput = "";

let ffTranscript: Row | null = null;
let ffCalls = 0;
globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
  const u = String(url);
  if (u.includes("api.fireflies.ai")) {
    ffCalls++;
    await new Promise((r) => setTimeout(r, 10)); // both concurrent deliveries are mid-fetch together
    return new Response(JSON.stringify({ data: { transcript: ffTranscript } }), { status: 200 });
  }
  if (u.includes("graph.microsoft.com")) {
    if (init?.method === "PUT") {
      uploads.push(decodeURIComponent(u.split("/root:/")[1] ?? "").replace(/:\/content$/, ""));
      return new Response("{}", { status: uploadStatus });
    }
    return new Response("{}", { status: 200 }); // folder lookup: exists
  }
  throw new Error("unexpected fetch " + u);
}) as typeof fetch;

const M = await import("../src/features/huddle/lib/fireflies/minutes");
const S = await import("../src/features/huddle/lib/fireflies/fireflies.server");

async function sign(body: string, secret = SECRET): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  return [...sig].map((b) => b.toString(16).padStart(2, "0")).join("");
}
const evt = (id: string, event = "meeting.transcribed") => JSON.stringify({ event, meeting_id: id, timestamp: 1 });
async function deliver(body: string, header?: string) {
  return S.handleFirefliesWebhook(body, header ?? `sha256=${await sign(body)}`).catch((e: Error) => ({ thrown: e.message }));
}
const LUNA_OK =
  "## Agenda\n### Align on launch\n- Dates\n## Summary\nThe team aligned on launch.\n### Launch plan\n- Ship Friday\n## Questions\n- When?\n  - Friday\n## Decisions\n### Launch\n- Ship Friday\n## Action Items\n### Next 2 weeks\n- Draft notes — Owner: **Sam** [01:05]\n### Beyond\n- None recorded.";
const baseTranscript = (o: Row = {}) => ({
  id: "m1",
  title: "Launch sync",
  date: Date.parse("2026-11-09T15:00:00Z"),
  sentences: [
    { speaker_name: "Sam", text: "Let's ship Friday.", start_time: "65.2" },
    { speaker_name: "Ana", text: "Agreed.", start_time: "70" },
  ],
  summary: { overview: "Team agreed to ship Friday.", action_items: "Sam: draft notes" },
  ...o,
});
const reset = () => {
  db.settings.clear();
  db.meetings.clear();
  sent.length = 0;
  uploads.length = 0;
  modelCalls = 0;
  ffCalls = 0;
  sendOk = true;
  uploadStatus = 201;
  modelReply = LUNA_OK;
  settingsDown = false;
};

// ---------------------------------------------------------------- A: signature
{
  const b = evt("m1");
  t("A1 valid sha256= signature accepted", await M.verifyFirefliesSignature(b, `sha256=${await sign(b)}`, SECRET), true);
  t("A2 tampered body refused", await M.verifyFirefliesSignature(b + " ", `sha256=${await sign(b)}`, SECRET), false);
  t("A3 bare hex (V1 form) refused", await M.verifyFirefliesSignature(b, await sign(b), SECRET), false);
  t("A4 wrong secret refused", await M.verifyFirefliesSignature(b, `sha256=${await sign(b, "other")}`, SECRET), false);
  t("A5 missing header refused", await M.verifyFirefliesSignature(b, null, SECRET), false);
  t("A6 empty configured secret refuses everything", await M.verifyFirefliesSignature(b, `sha256=${"a".repeat(64)}`, ""), false);
  reset();
  const r = (await deliver(b, `sha256=${"0".repeat(64)}`)) as Row;
  t("A7 handler: bad signature throws BEFORE any Fireflies/Graph call", [r.thrown, ffCalls, sent.length, uploads.length], ["invalid_webhook_signature", 0, 0, 0]);
  const ig = (await deliver(evt("m1", "meeting.bot_joined"))) as Row;
  t("A8 unrelated event ignored safely, nothing fetched", [ig.ignored, ffCalls], [true, 0]);
  const bad = (await deliver(JSON.stringify({ event: "meeting.transcribed" }))) as Row;
  t("A9 missing meeting_id rejected", bad.thrown, "missing_meeting_id");
}

// ---------------------------------------------------------------- B/C: settings parsing
t("B1 unset source -> fireflies (default)", M.parseMinutesSource(null), "fireflies");
t("B2 'luna' -> luna", M.parseMinutesSource("luna"), "luna");
t("B3 garbage -> fireflies", M.parseMinutesSource("gpt"), "fireflies");
t("C1 unset recipients -> owner's own linked addresses", M.parseRecipients(null, ["A@x.io", "b@y.io"]), ["a@x.io", "b@y.io"]);
t("C2 typed list cleaned + de-duplicated", M.parseRecipients("a@x.io, A@x.io; b@y.io"), ["a@x.io", "b@y.io"]);
t("C3 an invalid address rejects the whole list (no silent re-route)", M.parseRecipients(["a@x.io", "nope"]), null);
t("C4 explicit empty list rejected", M.parseRecipients([]), null);

// ---------------------------------------------------------------- D: Fireflies summary formatting
{
  const custom = M.firefliesSummaryMarkdown({ summary: { overview: "std", extended_sections: [{ title: "Decisions", content: "- Ship" }] } });
  t("D1 custom template sections preferred over standard fields", custom, { ok: true, source: "custom", markdown: "## Decisions\n\n- Ship" });
  const std = M.firefliesSummaryMarkdown({ summary: { overview: "Agreed.", action_items: "Sam: notes" } });
  t("D2 no custom sections -> standard summary, labelled standard", std.ok && std.source, "standard");
  t("D3 no summary at all -> error, not an empty email", M.firefliesSummaryMarkdown({ summary: null }), { ok: false, error: "summary_missing" });
}

// ---------------------------------------------------------------- E: generation, no cross-mode fallback
{
  reset();
  const noSummary = baseTranscript({ summary: null });
  const g1 = await S.generateMinutes("fireflies", noSummary as any);
  t("E1 Fireflies mode + missing summary -> error (may still arrive) and Luna NOT called", [g1, modelCalls], [{ ok: false, error: "fireflies_summary_missing", wait: true }, 0]);
  const g2 = await S.generateMinutes("fireflies", baseTranscript() as any);
  t("E2 Fireflies mode never calls Luna", [g2.ok && g2.kind, modelCalls], ["standard", 0]);
  t("E3 standard summary email carries the 'not your custom template' notice", g2.ok && g2.markdown.includes("not your custom summary template"), true);
  const g3 = await S.generateMinutes("luna", baseTranscript() as any);
  t("E4 Luna mode calls Luna once on the luna model with the full transcript", [g3.ok && g3.kind, modelCalls, lastModelInput.startsWith("gpt-5.6-luna"), lastModelInput.includes("[01:05] Sam: Let's ship Friday.")], ["luna", 1, true, true]);
  const g4 = await S.generateMinutes("luna", baseTranscript({ sentences: [] }) as any);
  t("E5 Luna mode + missing transcript -> error, Luna NOT called, NO fallback to Fireflies summary", [g4, modelCalls], [{ ok: false, error: "transcript_missing", wait: true }, 1]);
  modelReply = "## Agenda\n- x\n## Summary\nOne line.";
  const g5 = await S.generateMinutes("luna", baseTranscript() as any);
  t("E6 Luna reply missing template sections is not emailed", g5.ok ? "ok" : g5.error, "luna_template_incomplete:Questions|Decisions|Action Items");
}

// ---------------------------------------------------------------- F: email plan + retry policy
t("F1 never emailed -> send", M.planEmail({ email_status: null, content_hash: null }, "h", false), "send");
t("F2 already sent, same input -> not needed (a retry never re-sends)", M.planEmail({ email_status: "sent", content_hash: "h" }, "h", true), "not_needed");
t("F3 changed input, update emails OFF -> not needed", M.planEmail({ email_status: "sent", content_hash: "h" }, "h2", false), "not_needed");
t("F4 changed input, update emails ON -> send_update", M.planEmail({ email_status: "sent", content_hash: "h" }, "h2", true), "send_update");
t("F5 earlier failure -> send", M.planEmail({ email_status: "failed", content_hash: null }, "h", false), "send");
t("F6 backoff 1,2,4..30 min", [1, 2, 3, 9].map(M.retryDelaySec), [60, 120, 240, 1800]);

// ---------------------------------------------------------------- G: webhook queues, heartbeat works
const tick = () => S.processDueFirefliesMeetings(1, clock);
const drain = async (n = 6) => {
  for (let i = 0; i < n; i++) {
    clock += 31 * 60 * 1000; // past any backoff
    await tick();
  }
};
{
  reset();
  ffTranscript = baseTranscript();
  const w = (await deliver(evt("m1"))) as Row;
  t("G0 webhook only QUEUES: no Fireflies, Graph or model call inside the request (Fireflies allows 30s)", [w.queued, ffCalls, sent.length, uploads.length, modelCalls], [true, 0, 0, 0, 0]);
  await tick();
  t("G1 heartbeat: one email + OneDrive saved; default recipients = only the owner's SENDABLE addresses", [sent.length, sent[0]?.to, db.meetings.get("m1")?.onedrive_status], [1, ["owner@example.com"], "saved"]);
  t("G2 OneDrive path is stable and meeting-id keyed", uploads[0], "Automation/transcripts/fireflies-m1.md");
  t("G3 subject carries title and date", sent[0]?.subject, "Meeting minutes: Launch sync (Nov 9, 2026)");
  await deliver(evt("m1"));
  await drain(2);
  t("G4 webhook RETRY (same delivery again) is a no-op: no second email, no re-upload", [sent.length, uploads.length], [1, 1]);

  // two heartbeats at once on a new meeting: the lease lets exactly one work it
  await deliver(evt("m2"));
  await Promise.all([tick(), tick()]);
  t("G5 two CONCURRENT heartbeats -> exactly one email for the meeting", sent.filter((x) => x.subject.includes("Launch")).length, 2);

  ffTranscript = baseTranscript({ summary: { overview: "Changed summary." } });
  await deliver(JSON.stringify({ event: "meeting.transcribed", meeting_id: "m1", timestamp: 2, reprocessed_at: 1000 }));
  await drain(2);
  t("G6 Fireflies resend (newer reprocessed_at), update emails OFF -> file updated, no email", [sent.length, db.meetings.get("m1")?.pending_email], [2, false]);
  db.settings.set("owner@example.com", { minutes_source: "fireflies", recipients: ["owner@example.com"], update_emails: true });
  await deliver(JSON.stringify({ event: "meeting.transcribed", meeting_id: "m1", timestamp: 3, reprocessed_at: 1000 }));
  await drain(2);
  t("G7 a RETRY of that resend (same reprocessed_at) does not re-queue an email even with update emails ON", sent.length, 2);
  ffTranscript = baseTranscript({ summary: { overview: "Changed again." } });
  await deliver(JSON.stringify({ event: "meeting.transcribed", meeting_id: "m1", timestamp: 4, reprocessed_at: 2000 }));
  await drain(2);
  t("G8 a NEWER resend with update emails ON -> one 'Updated meeting minutes' email", [sent.length, sent.at(-1)?.subject.startsWith("Updated meeting minutes")], [3, true]);
}
{
  // Fireflies-summary mode: transcribed arrives before the summary exists
  reset();
  ffTranscript = baseTranscript({ summary: null });
  await deliver(evt("m3"));
  await tick();
  t("G9 transcribed with no summary yet: no email, WAITING (not failed), OneDrive saved", [sent.length, db.meetings.get("m3")?.email_error, db.meetings.get("m3")?.pending_email, db.meetings.get("m3")?.onedrive_status], [0, "waiting:fireflies_summary_missing", true, "saved"]);
  ffTranscript = baseTranscript();
  await deliver(evt("m3", "meeting.summarized"));
  await tick();
  t("G10 meeting.summarized arrives -> one email from the Fireflies summary", [sent.length, db.meetings.get("m3")?.summary_kind], [1, "standard"]);
  await deliver(evt("m3", "meeting.summarized"));
  await drain(2);
  t("G11 a retry of meeting.summarized does not email again", sent.length, 1);

  reset();
  ffTranscript = baseTranscript({ summary: null });
  await deliver(evt("m4"));
  await tick();
  clock += 3 * 60 * 60 * 1000 + 60_000; // past the 3h summary wait
  await tick();
  t("G12 summary never arrives: after 3h a FINAL visible error, never a fall back to Luna", [sent.length, modelCalls, db.meetings.get("m4")?.email_status, db.meetings.get("m4")?.email_error, db.meetings.get("m4")?.pending_email], [0, 0, "failed", "fireflies_summary_missing", false]);
}
{
  reset();
  ffTranscript = baseTranscript();
  uploadStatus = 403;
  await deliver(evt("m5"));
  await tick();
  t("G13 OneDrive fails -> email still sent; OneDrive stays queued", [sent.length, db.meetings.get("m5")?.pending_onedrive], [1, true]);
  uploadStatus = 201;
  await drain(1);
  t("G14 ...the retry saves OneDrive and does NOT send the email again", [sent.length, db.meetings.get("m5")?.onedrive_status], [1, "saved"]);

  reset();
  ffTranscript = baseTranscript();
  settingsDown = true;
  await deliver(evt("m6"));
  await tick();
  settingsDown = false;
  t("G15 settings DB down -> OneDrive STILL saved (verify loop 1, D3); email retried later", [uploads.length, sent.length, db.meetings.get("m6")?.pending_email], [1, 0, true]);
  await drain(1);
  t("G16 ...and the retry sends the email once", sent.length, 1);

  reset();
  ffTranscript = baseTranscript();
  sendOk = false;
  await deliver(evt("m7"));
  await tick();
  t("G17 Graph send failure -> short code only (no Graph text), still queued", [db.meetings.get("m7")?.email_error, db.meetings.get("m7")?.pending_email], ["graph_send_500", true]);
  sendOk = true;
  await drain(1);
  t("G18 the retry after a failed send sends exactly once", [db.meetings.get("m7")?.email_status, db.meetings.get("m7")?.emails_sent], ["sent", 1]);

  // crashed worker: lease taken, process died before release -> lease lapses, meeting is picked up again
  reset();
  ffTranscript = baseTranscript();
  await deliver(evt("m8"));
  const leaked = await (await import("../src/features/huddle/lib/fireflies/minutes-store.server")).claimDueMeetings(1);
  t("G19 a crashed worker holds the lease: the next tick skips the meeting", [leaked.length, await tick(), sent.length], [1, 0, 0]);
  clock += 4 * 60 * 1000; // lease (3 min) lapsed
  await tick();
  t("G20 ...after the lease lapses the meeting is processed and emailed once (verify loop 1, D1)", sent.length, 1);

  reset();
  ffTranscript = baseTranscript();
  db.settings.set("owner@example.com", { minutes_source: "luna", recipients: null, update_emails: false });
  await deliver(evt("m9"));
  await tick();
  t("G21 Luna mode end to end: Luna called once, email says Luna wrote it", [db.meetings.get("m9")?.summary_kind, modelCalls, sent[0]?.body.includes("Minutes written by Luna")], ["luna", 1, true]);
  t("G22 transcript timestamps arrive as STRINGS in Fireflies' schema and still render", lastModelInput.includes("[01:05] Sam:"), true);
}
{
  reset();
  const bad = (await deliver(evt("ab/../c"))) as Row;
  t("G23 a meeting id with path characters is REJECTED, not cleaned (verify loop 1, C2)", [bad.thrown, db.meetings.size], ["invalid_meeting_id", 0]);
  t("G24 safeSendError never carries Graph's message text", [S.safeSendError("Graph sendMail failed (403): user x@y.io blocked"), S.safeSendError("x", true)], ["graph_send_403", "email_refused_by_send_gate"]);
}

// ---------------------------------------------------------------- H: safe HTML + misc
{
  const html = M.markdownToEmailHtml("## Q&A\n- <script>alert(1)</script> **Sam**\n  - nested <b>x</b>\n1. one");
  t("H1 raw HTML from a transcript is escaped, never rendered", [html.includes("<script>"), html.includes("&lt;script&gt;"), html.includes("&lt;b&gt;x&lt;/b&gt;")], [false, true, true]);
  t("H2 bold kept, nested list rendered", [html.includes("<strong>Sam</strong>"), (html.match(/<ul/g) ?? []).length, html.includes("<ol")], [true, 2, true]);
  t("H3 headings rendered", html.includes("<h3"), true);
  t("H4 input hash is stable and changes with content", [
    M.meetingInputHash(baseTranscript() as any) === M.meetingInputHash(baseTranscript() as any),
    M.meetingInputHash(baseTranscript() as any) === M.meetingInputHash(baseTranscript({ summary: { overview: "x" } }) as any),
  ], [true, false]);
  t("H5 meeting ids are accepted verbatim or rejected", [M.safeMeetingId("ASxwZxCstx"), M.safeMeetingId("01KTXMH9V8RPY1B4DTYKB27WYR"), M.safeMeetingId("ab/../c d"), M.safeMeetingId("")], ["ASxwZxCstx", "01KTXMH9V8RPY1B4DTYKB27WYR", null, null]);
  t("H6 timestamps (number or Fireflies' string form)", [M.stamp(65), M.stamp(3725), M.stamp("65.4"), M.stamp(""), M.stamp("x")], ["01:05", "1:02:05", "01:05", "", ""]);
}

if (fail) {
  console.log(`\n${fail} FAILED`);
  process.exit(1);
}
console.log("\nall passed");
