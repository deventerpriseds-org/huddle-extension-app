// WHAT:          Runs scripts/proposals-preview.ts end to end with Graph stubbed (scripts/fixtures/preview-fetch-stub.ts)
//                and checks what it PRINTS: a non-JSON feed file logs "<file>: not JSON" and never any of its content;
//                and what it DOES: one OneDrive file write, plus a sendMail only with PREVIEW_EMAIL=1.
// WHY:           Verifier loop 4 (8.3): an uncaught JSON.parse quoted ~10 characters of a feed file into the public
//                workflow log; the header also said "sends nothing" while the script writes a file and can email.
// SUPERSEDES:    nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:      docs/qc-evidence/IMPL-task-proposals.md "Verifier loop-4 fix pass".
//
// Run: bun scripts/proposals-preview.test.ts      All data synthetic (.example).
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let pass = 0;
let fail = 0;
const t = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : `\n   got:  ${JSON.stringify(got)}\n   want: ${JSON.stringify(want)}`}`);
};

const root = new URL("..", import.meta.url).pathname;
const feeds = { enabled: true, ownerLogins: ["owner@eds.example"], driveUser: "drive@eds.example", mailbox: "work@corp.example", synthetic: true, subjectPrefix: "[TEST]" };
const SECRET = "Secret merger with Example Corp closes Friday";
const run = (extra: Record<string, string>) => {
  const log = join(mkdtempSync(join(tmpdir(), "preview-")), "calls.log");
  const r = spawnSync("bun", ["--preload", join(root, "scripts/fixtures/preview-fetch-stub.ts"), join(root, "scripts/proposals-preview.ts")], {
    cwd: root,
    encoding: "utf8",
    timeout: 120_000,
    env: { ...process.env, TOKEN: "token.example", HUDDLE_ONEDRIVE_FEEDS: JSON.stringify(feeds), OPENAI_API_KEY: "", STUB_LOG: log, ...extra },
  });
  const calls = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [];
  return { out: `${r.stdout}\n${r.stderr}`, status: r.status, calls };
};

const bad = run({ STUB_EMAIL: SECRET, STUB_SENT: `${SECRET} (sent)`, STUB_TEAMS: `${SECRET} (teams)` });
t("PV-1 non-JSON email / sent files print 'not JSON' and NONE of their content", [
  /email: not JSON/.test(bad.out),
  /sent: not JSON/.test(bad.out),
  /Secret|merger|Example Corp|Unexpected token/i.test(bad.out),
], [true, true, false]);
t("PV-2 the run still completes (counts + file write), exit 0", [bad.status, bad.calls.filter((c) => c === "PUT preview-file").length], [0, 1]);
t("PV-3 without PREVIEW_EMAIL nothing is emailed", bad.calls.some((c) => c.includes("sendMail")), false);
const mailed = run({ STUB_EMAIL: SECRET, PREVIEW_EMAIL: "1" });
t("PV-4 with PREVIEW_EMAIL=1 the report is emailed once (the header now says so)", mailed.calls.filter((c) => c === "POST sendMail").length, 1);
t("PV-6 every run also writes the HTML report file to OneDrive, with or without PREVIEW_EMAIL (owner 2026-11-14)", [bad.calls.filter((c) => c === "PUT preview-html").length, mailed.calls.filter((c) => c === "PUT preview-html").length], [1, 1]);
const header = readFileSync(join(root, "scripts/proposals-preview.ts"), "utf8").split("\n").slice(0, 25).join("\n");
t("PV-5 the header states the OneDrive write and the PREVIEW_EMAIL email, and no longer says 'sends nothing'", [
  /WRITES one Markdown file to the owner's OWN OneDrive/.test(header),
  /PREVIEW_EMAIL=1, EMAILS the same report/.test(header),
  /sends nothing/i.test(header),
], [true, true, false]);

// ── Needs-you JUDGE (owner redirect 2026-11-14; AC-R7): three lists from the judge's verdicts, EMAIL only, everything
// else counts only. The model is STUBBED in preview-fetch-stub.ts (STUB_JUDGE): never a live model.
{
  const now = new Date();
  const iso = (h: number) => new Date(now.getTime() - h * 3_600_000).toISOString();
  const W = "work@corp.example";
  const rec = (id: string, conv: string, h: number, over: Record<string, unknown> = {}) => ({
    id,
    conversationId: conv,
    receivedDateTime: iso(h),
    subject: `[TEST] Zebra subject ${id}`,
    from: `Quokka Sender ${id} <sender-${id}@corp.example>`,
    toRecipients: W,
    body: `Can you send the walrus numbers ${id}?`,
    internetMessageHeaders: [],
    ...over,
  });
  const records = [
    rec("a1", "conv-open", 5),
    rec("a2", "conv-open", 4, { subject: "[TEST] Re: Zebra subject a1", body: "Following up: can you send the walrus numbers?" }),
    rec("b1", "conv-replied", 6),
    rec("c1", "conv-list", 6, { toRecipients: "dl-everyone@corp.example", body: "MARK-C1 can you fill the survey?" }),
    rec("d1", "conv-invite", 6, { body: "MARK-D1", internetMessageHeaders: [{ name: "x-ms-exchange-calendar-originator-id", value: "x" }] }),
    rec("e1", "conv-minutes", 6, { subject: "[TEST] Meeting notes: Zebra sync", body: "MARK-E1 Notes below." }),
    rec("f1", "conv-bulk", 6, { body: "MARK-F1", internetMessageHeaders: [{ name: "List-Unsubscribe", value: "<x>" }] }),
    rec("g1", "conv-cc", 6, { toRecipients: "pat@corp.example", ccRecipients: W, body: "MARK-G1 Pat, can you send it?" }),
    rec("h1", "conv-fabricated", 6, { body: "MARK-H1 Thanks for the update." }),
  ];
  const J = (category: string, addressed: string, ask: unknown, owner_todos: unknown[] = []) => ({ category, addressed, ask, owner_todos, reason: "stub" });
  const STUB_JUDGE = JSON.stringify([
    ["Following up", J("needs_reply", "direct", { quote: "can you send the walrus numbers?", summary: "send numbers" }, [
      { title: "Send the walrus numbers", quote: "Following up: can you send the walrus numbers", doer: null, due_text: null },
      { title: "Send the walrus numbers to finance", quote: "Following up: can you send the walrus numbers", doer: "Pat", due_text: null },
    ])],
    ["MARK-C1", J("needs_reply", "not_addressed", { quote: "can you fill the survey?", summary: "survey" })],
    ["MARK-D1", J("calendar", "direct", null)],
    ["MARK-E1", J("meeting_minutes", "group_including_owner", null)],
    ["MARK-F1", J("automated_or_broadcast", "not_addressed", null)],
    ["MARK-H1", J("needs_reply", "direct", { quote: "Can you approve the budget today?", summary: "invented" })],
  ]);
  const env = (feed: string, recs: unknown[]) => JSON.stringify({ schema_version: "1.0", feed_type: feed, source: "power-automate-outlook", mailbox: W, synthetic: true, complete: true, published_utc: iso(1), window_start_utc: iso(240), snapshot: { value: recs } });
  const sent = [{ id: "s1", conversationId: "conv-replied", sentDateTime: iso(2), subject: "[TEST] Re: Zebra subject b1" }];
  const dir = mkdtempSync(join(tmpdir(), "preview-body-"));
  const r = run({ STUB_EMAIL: env("email_snapshot", records), STUB_SENT: env("sent_snapshot", sent), STUB_BODY_DIR: dir, PREVIEW_DAYS: "30", OPENAI_API_KEY: "key.example", STUB_JUDGE });
  const html = existsSync(join(dir, "report.html")) ? readFileSync(join(dir, "report.html"), "utf8") : "";
  const md = existsSync(join(dir, "report.md")) ? readFileSync(join(dir, "report.md"), "utf8") : "";
  const h2s = [...html.matchAll(/<h2[^>]*>([^<(]+?)\s*\(/g)].map((m) => m[1].trim());
  t("PV-7 AC-R7.1 exactly three <h2> lists, in order", h2s, ["Needs your reply", "Action items for you", "Meeting action items for you"]);
  const replyBlock = html.slice(html.indexOf("Needs your reply"), html.indexOf("Action items for you"));
  t("PV-8 AC-R7.2 'Needs your reply' holds ONE row for the 2-message open conversation; the fabricated-quote and not-addressed ones are NOT listed", [(replyBlock.match(/<tr>/g) ?? []).length, /Zebra subject a1/.test(replyBlock), /b1|c1|d1|e1|f1|g1|h1/.test(replyBlock)], [1, true, false]);
  t("PV-9 AC-R7.4 meeting list renders 'none triaged yet' until part B stores items", /Meeting action items for you \(0\)<\/h2>\s*<p[^>]*>none triaged yet</.test(html), true);
  const counts = /<p[^>]*data-counts="1">([\s\S]*?)<\/p>/.exec(html)?.[1] ?? "";
  t("PV-10 AC-R7.5 counts: settled 1, calendar 1, meeting_minutes 1, automated 1, fyi 3, downgraded 2, assigned_to_other 1; no subject/sender", [/settled 1/.test(counts), /calendar 1/.test(counts), /meeting_minutes 1/.test(counts), /automated_or_broadcast 1/.test(counts), /fyi 3/.test(counts), /downgraded 2/.test(counts), /assigned_to_other 1/.test(counts), /Zebra|Quokka|walrus|corp\.example/.test(counts)], [true, true, true, true, true, true, true, false]);
  const todoBlock = html.slice(html.indexOf("Action items for you"), html.indexOf("Meeting action items for you"));
  t("PV-14 'Action items for you' holds the owner's validated to-do and NOT the one for someone else", [/Send the walrus numbers</.test(todoBlock), /to finance/.test(todoBlock)], [true, false]);
  t("PV-15 a settled conversation is never sent to the model: 7 model calls for 9 conversations (b1 settled; a1+a2 one call)", r.calls.filter((c) => c === "POST model").length, 7);
  const src = readFileSync(join(root, "scripts/proposals-preview.ts"), "utf8").replace(/\/\/.*$/gm, "");
  t("PV-11 owner scope 2026-11-14: EMAIL only -- the script reads no Teams log; no Teams row, label or count in the report", [/parseTeamsLog|teams\.path|TEAMS_LOG_PATH/.test(src), /teams/i.test(html + md)], [false, false]);
  t("PV-12 AC-R7.7 the public log carries no subject, sender, address, body word or id from the fixture", /Zebra|Quokka|walrus|corp\.example|conv-|sender-|MARK-/.test(r.out), false);
  t("PV-13 the Markdown file has the same three lists", [...md.matchAll(/^## (.+?) \(/gm)].map((m) => m[1]), ["Needs your reply", "Action items for you", "Meeting action items for you"]);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
