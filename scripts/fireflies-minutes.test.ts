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

// ---------------------------------------------------------------- fakes
type Row = Record<string, any>;
const db = { settings: new Map<string, Row>(), meetings: new Map<string, Row>() };
const sent: Array<{ to: string[]; subject: string; body: string }> = [];
let sendOk = true;
let modelCalls = 0;
let modelReply = "";
const uploads: string[] = [];
let uploadStatus = 201;

mock.module("../src/features/huddle/lib/fireflies/minutes-store.server", () => ({
  getMinutesSettings: async (o: string) => db.settings.get(o.toLowerCase()) ?? null,
  setMinutesSettings: async (o: string, s: Row) => void db.settings.set(o.toLowerCase(), s),
  noteDelivery: async (id: string, owner: string, title: string | null) => {
    const r = db.meetings.get(id) ?? { meeting_id: id, owner_email: owner, deliveries: 0, email_status: null, content_hash: null, emails_sent: 0 };
    r.deliveries++;
    r.title = title ?? r.title;
    db.meetings.set(id, r);
    return { ...r };
  },
  claimEmail: async (id: string, hash: string, allowUpdate: boolean) => {
    const r = db.meetings.get(id)!;
    const ok =
      r.email_status == null || r.email_status === "failed" || (allowUpdate && r.email_status === "sent" && r.content_hash !== hash);
    if (ok) r.email_status = "sending"; // synchronous check-and-set = atomic, like the SQL UPDATE
    return ok;
  },
  recordEmail: async (id: string, x: Row) => {
    const r = db.meetings.get(id)!;
    r.email_status = x.ok ? "sent" : "failed";
    r.summary_kind = x.kind;
    r.email_error = x.ok ? null : x.error;
    if (x.ok) {
      r.content_hash = x.hash;
      r.emails_sent++;
    }
  },
  recordEmailSkipped: async (id: string, _s: string, err: string) => {
    const r = db.meetings.get(id)!;
    r.email_error = err;
    if (r.email_status !== "sent") r.email_status = "failed";
  },
  recordOneDrive: async (id: string, x: Row) => {
    const r = db.meetings.get(id)!;
    r.onedrive_status = x.ok ? "saved" : "failed";
    r.onedrive_path = x.path ?? r.onedrive_path;
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
    { speaker_name: "Sam", text: "Let's ship Friday.", start_time: 65 },
    { speaker_name: "Ana", text: "Agreed.", start_time: 70 },
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
  const ig = (await deliver(evt("m1", "meeting.deleted"))) as Row;
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
  t("E1 Fireflies mode + missing summary -> error and Luna NOT called", [g1, modelCalls], [{ ok: false, error: "fireflies_summary_missing" }, 0]);
  const g2 = await S.generateMinutes("fireflies", baseTranscript() as any);
  t("E2 Fireflies mode never calls Luna", [g2.ok && g2.kind, modelCalls], ["standard", 0]);
  t("E3 standard summary email carries the 'not your custom template' notice", g2.ok && g2.markdown.includes("not your custom summary template"), true);
  const g3 = await S.generateMinutes("luna", baseTranscript() as any);
  t("E4 Luna mode calls Luna once on the luna model with the full transcript", [g3.ok && g3.kind, modelCalls, lastModelInput.startsWith("gpt-5.6-luna"), lastModelInput.includes("[01:05] Sam: Let's ship Friday.")], ["luna", 1, true, true]);
  const g4 = await S.generateMinutes("luna", baseTranscript({ sentences: [] }) as any);
  t("E5 Luna mode + missing transcript -> error, Luna NOT called, NO fallback to Fireflies summary", [g4, modelCalls], [{ ok: false, error: "transcript_missing" }, 1]);
  modelReply = "## Agenda\n- x\n## Summary\nOne line.";
  const g5 = await S.generateMinutes("luna", baseTranscript() as any);
  t("E6 Luna reply missing template sections is not emailed", g5.ok ? "ok" : g5.error, "luna_template_incomplete:Questions|Decisions|Action Items");
}

// ---------------------------------------------------------------- F: delivery decision
t("F1 first delivery -> send", M.decideDelivery(null, "h", false), "send");
t("F2 retry of a sent meeting, same content -> skip", M.decideDelivery({ email_status: "sent", content_hash: "h" }, "h", true), "skip_already_sent");
t("F3 changed content, update emails OFF -> skip", M.decideDelivery({ email_status: "sent", content_hash: "h" }, "h2", false), "skip_already_sent");
t("F4 changed content, update emails ON -> send_update", M.decideDelivery({ email_status: "sent", content_hash: "h" }, "h2", true), "send_update");
t("F5 in flight -> skip", M.decideDelivery({ email_status: "sending", content_hash: null }, "h", false), "skip_in_flight");
t("F6 earlier failure -> send again", M.decideDelivery({ email_status: "failed", content_hash: null }, "h", false), "send");

// ---------------------------------------------------------------- G: end-to-end through the handler
{
  reset();
  ffTranscript = baseTranscript();
  const r1 = (await deliver(evt("m1"))) as Row;
  t("G1 first delivery: one email to the owner's linked addresses + OneDrive saved", [r1.email?.status, sent.length, sent[0]?.to, r1.onedrive?.ok], ["sent", 1, ["owner@example.com", "owner@work.example"], true]);
  t("G2 OneDrive path is stable and meeting-id keyed", uploads[0], "Automation/transcripts/fireflies-m1.md");
  t("G3 subject carries title and date", sent[0]?.subject, "Meeting minutes: Launch sync (Nov 9, 2026)");
  const r2 = (await deliver(evt("m1"))) as Row;
  t("G4 webhook RETRY: no second email, OneDrive updated again", [r2.email?.status, r2.email?.reason, sent.length, uploads.length], ["skipped", "already_sent", 1, 2]);
  const both = await Promise.all([deliver(evt("m2")), deliver(evt("m2"))]);
  t("G5 two CONCURRENT deliveries of a new meeting -> exactly one email", sent.length, 2);
  t("G5b the loser reports skipped, not failed", both.map((x: Row) => x.email?.status).sort(), ["sent", "skipped"]);

  ffTranscript = baseTranscript({ summary: { overview: "Changed summary." } });
  const r3 = (await deliver(evt("m1"))) as Row;
  t("G6 Fireflies resend with changed content, update emails OFF -> no email", [r3.email?.status, sent.length], ["skipped", 2]);
  db.settings.set("owner@example.com", { minutes_source: "fireflies", recipients: ["owner@example.com"], update_emails: true });
  const r4 = (await deliver(evt("m1"))) as Row;
  t("G7 same resend with update emails ON -> one 'Updated meeting minutes' email", [r4.email?.status, r4.email?.update, sent.at(-1)?.subject.startsWith("Updated meeting minutes")], ["sent", true, true]);

  reset();
  ffTranscript = baseTranscript({ summary: null });
  const r5 = (await deliver(evt("m3"))) as Row;
  t("G8 Fireflies mode, no summary: no email, visible error recorded, OneDrive STILL saved, no retry asked", [sent.length, db.meetings.get("m3")?.email_error, r5.onedrive?.ok, r5.retry], [0, "fireflies_summary_missing", true, false]);

  reset();
  ffTranscript = baseTranscript();
  uploadStatus = 403;
  const r6 = (await deliver(evt("m4"))) as Row;
  t("G9 OneDrive fails -> email still sent; retry requested for OneDrive", [r6.email?.status, r6.onedrive?.ok, r6.retry], ["sent", false, true]);
  const r6b = (await deliver(evt("m4"))) as Row;
  t("G10 ...and that retry does NOT send the email again", [r6b.email?.status, sent.length], ["skipped", 1]);

  reset();
  ffTranscript = baseTranscript();
  sendOk = false;
  const r7 = (await deliver(evt("m5"))) as Row;
  t("G11 Graph send failure -> recorded failed, retry requested", [r7.email?.status, db.meetings.get("m5")?.email_status, r7.retry], ["failed", "failed", true]);
  sendOk = true;
  await deliver(evt("m5"));
  t("G12 the retry after a failed send DOES send (once)", [db.meetings.get("m5")?.email_status, db.meetings.get("m5")?.emails_sent], ["sent", 1]);

  reset();
  ffTranscript = baseTranscript();
  db.settings.set("owner@example.com", { minutes_source: "luna", recipients: null, update_emails: false });
  const r8 = (await deliver(evt("m6"))) as Row;
  t("G13 Luna mode end to end: Luna called, email says Luna wrote it", [r8.email?.kind, modelCalls, sent[0]?.body.includes("Minutes written by Luna")], ["luna", 1, true]);
  t("G14 setting is read per delivery (switching to Luna took effect without redeploy)", r8.minutesSource, "luna");
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
  t("H5 meeting ids are sanitised for the file path", [M.safeMeetingId("ab/../c d"), M.safeMeetingId("///")], ["abcd", null]);
  t("H6 timestamps", [M.stamp(65), M.stamp(3725)], ["01:05", "1:02:05"]);
}

if (fail) {
  console.log(`\n${fail} FAILED`);
  process.exit(1);
}
console.log("\nall passed");
