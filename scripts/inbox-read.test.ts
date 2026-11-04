// WHAT:       Offline guard suite for the READ-ONLY inbox tools `search_email` / `read_email`: the Graph
//             query builder, body cleaner, owner-time-zone formatter, 403 -> needsConsent mapping, the
//             caller-scoped mailbox resolution, GET-only network behaviour, and the wiring on both text
//             paths and voice (inside the graphEmailConfigured() gate, OUTSIDE the send_email gate).
// WHY:        "Did Professor Lee email me about the 702 deadline?" had no tool. The tools read real
//             mail, so the guards that matter are: the model can never choose the mailbox, nothing but
//             a GET is ever issued, a missing Mail.Read grant is actionable rather than a crash, and the
//             tools never appear when Graph is not configured.
// SUPERSEDES: nothing
// SUPERSEDED-BY: nothing -- current
// EVIDENCE:   docs/qc-evidence/BUILD-inbox-read.md (mutation table)
//
// Run:  npm run test:inbox-read     (bun scripts/inbox-read.test.ts)
// No network (fetch is replaced), no database (journey identity is mocked), no mail can be sent.

import { mock } from "bun:test";
import { readFileSync } from "node:fs";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}${detail ? ` -- ${detail}` : ""}`);
  }
}

// ---- mocks: Graph credentials present, identity resolver controlled, fetch recorded ----------------
process.env.AZURE_TENANT_ID = "tenant-test";
process.env.AZURE_CLIENT_ID = "client-test";
process.env.AZURE_CLIENT_SECRET = "secret-test";

let resolvedMailbox: string | undefined = "owner@enterpriseds.io";
let resolvedTz = "America/New_York";
let resolverThrows = false;
mock.module("../src/features/huddle/lib/journey/identity.ts", () => ({
  resolveCalendarMailbox: async () => {
    if (resolverThrows) throw new Error("journey down");
    return resolvedMailbox;
  },
  resolveTimeZone: async (_c: unknown, browser?: string) => resolvedTz || browser || "UTC",
  resolveTaskEmail: async (c: { entra_email?: string } | undefined) => c?.entra_email,
}));

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
}
let calls: Call[] = [];
let graphResponder: (url: string) => { status: number; body: unknown } = () => ({
  status: 200,
  body: { value: [] },
});
globalThis.fetch = (async (input: unknown, init?: { method?: string; headers?: Record<string, string> }) => {
  const url = String(input);
  const method = (init?.method ?? "GET").toUpperCase();
  calls.push({ url, method, headers: init?.headers ?? {} });
  if (url.startsWith("https://login.microsoftonline.com/")) {
    return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), { status: 200 });
  }
  if (url.startsWith("https://graph.microsoft.com/")) {
    const r = graphResponder(url);
    return new Response(typeof r.body === "string" ? r.body : JSON.stringify(r.body), { status: r.status });
  }
  throw new Error(`unexpected network call in offline test: ${url}`);
}) as typeof fetch;

const IR = await import("../src/features/huddle/lib/email/inbox-read.ts");
const GE = await import("../src/features/huddle/lib/email/graph-email.server.ts");
const graphCalls = () => calls.filter((c) => c.url.startsWith("https://graph.microsoft.com/"));

const NOW = Date.parse("2026-11-04T12:00:00Z");
const dq = (qs: string) => decodeURIComponent(qs);

console.log("\n--- 1. Query builder ---");
{
  const b = IR.buildInboxSearchQuery({ query: "702 deadline" }, NOW);
  check("1a free text -> $search mode", b.mode === "search", b.qs);
  check("1b $search param written literally (not %24search)", b.qs.startsWith("$search="), b.qs);
  check("1c KQL wraps the text in double quotes", dq(b.qs).includes('$search="702 deadline"'), dq(b.qs));
  check("1d $search carries no $orderby (Graph rejects it)", !b.qs.includes("$orderby"), b.qs);

  const n = IR.buildInboxSearchQuery({ from: "Professor Lee" }, NOW);
  check("1e sender NAME -> $search with from:'name'", n.mode === "search" && dq(n.qs).includes("from:'Professor Lee'"), dq(n.qs));

  const a = IR.buildInboxSearchQuery({ from: "Lee@School.EDU" }, NOW);
  check("1f sender ADDRESS -> $filter mode", a.mode === "filter", a.qs);
  check("1g address is lower-cased and OData-quoted", dq(a.qs).includes("from/emailAddress/address eq 'lee@school.edu'"), dq(a.qs));
  check("1h $filter leads with receivedDateTime ge (Graph $orderby rule)", dq(a.qs).startsWith("$filter=receivedDateTime ge "), dq(a.qs));
  check("1i default 90-day lookback", dq(a.qs).includes("receivedDateTime ge 2026-08-06T12:00:00Z"), dq(a.qs));
  check("1j orderby receivedDateTime desc", dq(a.qs).includes("$orderby=receivedDateTime desc"), dq(a.qs));

  const inj = IR.buildInboxSearchQuery({ from: "o'brien@x.com" }, NOW);
  check("1k single quote doubled (no OData injection)", dq(inj.qs).includes("eq 'o''brien@x.com'"), dq(inj.qs));

  const kq = IR.buildInboxSearchQuery({ query: 'a" OR from:evil' }, NOW);
  check("1l inner double quote stripped from $search", !dq(kq.qs).slice('$search="'.length).split("&")[0].slice(0, -1).includes('"'), dq(kq.qs));

  const d = IR.buildInboxSearchQuery({ since: "2026-11-01", until: "2026-11-03", unreadOnly: true }, NOW);
  check("1m since used as lower bound", dq(d.qs).includes("receivedDateTime ge 2026-11-01T00:00:00Z"), dq(d.qs));
  check("1n bare until widened to end of day", dq(d.qs).includes("receivedDateTime le 2026-11-03T23:59:59Z"), dq(d.qs));
  check("1o unread in $filter mode is a server clause", dq(d.qs).includes("isRead eq false") && !d.postFilter.unreadOnly, dq(d.qs));

  const bad = IR.buildInboxSearchQuery({ since: "next tuesday" }, NOW);
  check("1p unparseable date dropped, not sent raw", !dq(bad.qs).includes("tuesday") && dq(bad.qs).includes("ge 2026-08-06"), dq(bad.qs));

  const u = IR.buildInboxSearchQuery({ query: "x", unreadOnly: true, top: 5 }, NOW);
  check("1q unread with $search is post-filtered and over-fetches 3x", u.postFilter.unreadOnly && u.qs.includes("$top=15") && u.top === 5, u.qs);

  check("1r top clamps to 1..25", IR.clampTop(0) === 1 && IR.clampTop(99) === 25 && IR.clampTop(undefined) === 10);
  const na = IR.normalizeSearchArgs({ unread_only: "true", top: "7", query: "  " });
  check("1s loose args normalised (snake_case, string bool/number, blank dropped)", na.unreadOnly === true && na.top === 7 && na.query === undefined);
}

console.log("\n--- 2. Body cleaning ---");
{
  const html =
    "<html><head><style>p{color:red}</style></head><body><p>Hi&nbsp;Von,</p><p>The 702 deadline is <b>Friday</b> &amp; firm.</p><!-- x --><script>evil()</script></body></html>";
  const c = IR.cleanEmailBody(html, "html");
  check("2a HTML tags removed", !/<[a-z]/i.test(c.text), c.text);
  check("2b <style>/<script> content dropped", !c.text.includes("color:red") && !c.text.includes("evil"), c.text);
  check("2c entities decoded", c.text.includes("Hi Von,") && c.text.includes("Friday & firm."), c.text);
  check("2d block ends become line breaks", c.text.includes("Hi Von,\nThe 702"), JSON.stringify(c.text));

  const long = "word ".repeat(3000);
  const d = IR.cleanEmailBody(long, "text");
  check("2e default cap 4000 + truncated flag", d.truncated && d.text.length <= 4000 + 20 && d.text.endsWith("...[truncated]"), String(d.text.length));
  check("2f fullLength reports the uncapped length", d.fullLength === long.trim().length, String(d.fullLength));
  const h = IR.cleanEmailBody("x".repeat(50000), "text", 999999);
  check("2g hard cap 12000 cannot be exceeded by max_chars", h.text.length <= 12000 + 20, String(h.text.length));
  const s = IR.cleanEmailBody("short", "text");
  check("2h short body untouched, not truncated", s.text === "short" && !s.truncated);
  const w = IR.cleanEmailBody("a\r\n\r\n\r\n\r\nb   ​ c", "text");
  check("2i whitespace squeezed, zero-width removed", w.text === "a\n\nb c", JSON.stringify(w.text));
}

console.log("\n--- 3. Owner time zone ---");
{
  const ny = IR.formatReceived("2026-11-03T14:14:00Z", "America/New_York");
  check("3a UTC instant rendered in owner zone", !!ny && ny.includes("9:14") && ny.includes("EST"), String(ny));
  const bad = IR.formatReceived("2026-11-03T14:14:00Z", "Not/AZone");
  check("3b unknown zone falls back to UTC (no throw)", !!bad && bad.includes("2:14") && bad.includes("UTC"), String(bad));
  check("3c missing/invalid date -> null", IR.formatReceived(null, "UTC") === null && IR.formatReceived("nope", "UTC") === null);
}

console.log("\n--- 4. Error mapping ---");
{
  const e = IR.mapGraphMailError(403, '{"error":{"code":"ErrorAccessDenied"}}', "Mailbox search");
  check("4a 403 -> needsConsent", e.needsConsent === true && e.ok === false && e.status === 403);
  check("4b 403 text names the Mail.Read grant", e.error.includes("Mail.Read") && e.error.includes("admin consent"), e.error);
  const nf = IR.mapGraphMailError(404, "", "Reading that email");
  check("4c 404 -> notFound, not needsConsent", nf.notFound === true && !nf.needsConsent);
  const o = IR.mapGraphMailError(400, '{"error":{"message":"Bad filter"}}', "Mailbox search");
  check("4d other status surfaces Graph's message", o.error.includes("Bad filter") && !o.needsConsent, o.error);
}

console.log("\n--- 5. Result shaping ---");
{
  const raws = [
    { id: "1", subject: "old", receivedDateTime: "2026-11-01T10:00:00Z", isRead: false },
    { id: "2", subject: "new", receivedDateTime: "2026-11-03T10:00:00Z", isRead: false },
    { id: "3", subject: "read", receivedDateTime: "2026-11-04T10:00:00Z", isRead: true },
    { id: "4", subject: "", receivedDateTime: "2026-11-02T10:00:00Z", isRead: false, bodyPreview: "p ".repeat(300) },
  ];
  const built = IR.buildInboxSearchQuery({ query: "x", unreadOnly: true, top: 2 }, NOW);
  const hits = IR.finishSearchHits(raws, built, "UTC");
  check("5a unread post-filter drops read mail", !hits.some((h) => h.id === "3"), JSON.stringify(hits.map((h) => h.id)));
  check("5b search results newest first, capped at top", hits.map((h) => h.id).join(",") === "2,4", hits.map((h) => h.id).join(","));
  check("5c empty subject -> (no subject)", hits[1].subject === "(no subject)");
  check("5d preview capped", hits[1].preview.length <= IR.SEARCH_PREVIEW_MAX_CHARS + 3, String(hits[1].preview.length));
}

console.log("\n--- 6. Network half (fetch mocked) ---");
{
  calls = [];
  graphResponder = () => ({
    status: 200,
    body: { value: [{ id: "m1", subject: "702 deadline", receivedDateTime: "2026-11-03T14:14:00Z", from: { emailAddress: { name: "Lee", address: "lee@school.edu" } } }] },
  });
  const r = (await GE.searchInboxMessages("owner@enterpriseds.io", { query: "702" }, "America/New_York")) as any;
  check("6a search ok with shaped hit", r.ok === true && r.count === 1 && r.messages[0].fromAddress === "lee@school.edu", JSON.stringify(r));
  check("6b hit time in owner zone", String(r.messages?.[0]?.received).includes("EST"), String(r.messages?.[0]?.received));
  const g = graphCalls();
  check("6c exactly one Graph call, to /users/<mailbox>/messages", g.length === 1 && g[0].url.startsWith("https://graph.microsoft.com/v1.0/users/owner%40enterpriseds.io/messages?"), g.map((c) => c.url).join(" | "));
  check("6d the Graph call is a GET", g.every((c) => c.method === "GET"), g.map((c) => c.method).join(","));

  calls = [];
  graphResponder = () => ({ status: 403, body: { error: { code: "ErrorAccessDenied", message: "Access is denied." } } });
  const f = (await GE.searchInboxMessages("owner@enterpriseds.io", { query: "702" }, "UTC")) as any;
  check("6e live 403 -> needsConsent (not a throw)", f.ok === false && f.needsConsent === true, JSON.stringify(f));

  calls = [];
  graphResponder = () => ({
    status: 200,
    body: { id: "m1", subject: "S", body: { contentType: "text", content: "z".repeat(9000) }, toRecipients: [{ emailAddress: { address: "owner@enterpriseds.io" } }] },
  });
  const rd = (await GE.readInboxMessage("owner@enterpriseds.io", "m1", "UTC")) as any;
  const rg = graphCalls();
  check("6f read ok, body capped at default 4000", rd.ok === true && rd.message.bodyTruncated === true && rd.message.body.length <= 4020 && rd.message.bodyLength === 9000, JSON.stringify({ ok: rd.ok, len: rd.message?.body?.length }));
  check("6g read is a GET to /messages/<id> asking for text body", rg.length === 1 && rg[0].method === "GET" && rg[0].url.includes("/messages/m1?") && String(rg[0].headers.Prefer).includes('body-content-type="text"'), JSON.stringify(rg));
  check("6h recipients flattened", JSON.stringify(rd.message?.to) === '["owner@enterpriseds.io"]');

  calls = [];
  const empty = (await GE.readInboxMessage("owner@enterpriseds.io", "  ", "UTC")) as any;
  check("6i read without id -> error and NO network", empty.ok === false && calls.length === 0, JSON.stringify(empty));
}

console.log("\n--- 7. Executor: mailbox from the caller, never from args ---");
{
  const caller = { entra_object_id: "oid", entra_email: "login@enterpriseds.io" };
  calls = [];
  resolvedMailbox = "owner@enterpriseds.io";
  graphResponder = () => ({ status: 200, body: { value: [] } });
  const r = await GE.runInboxReadTool("search_email", { query: "x", mailbox: "victim@other.com", user: "victim@other.com" }, caller, "UTC");
  const g = graphCalls();
  check("7a ok result", r.ok === true, JSON.stringify(r));
  check("7b mailbox comes from resolveCalendarMailbox; args.mailbox ignored", g.length === 1 && g[0].url.includes("/users/owner%40enterpriseds.io/") && !g.some((c) => c.url.includes("victim")), g.map((c) => c.url).join(" | "));

  calls = [];
  resolvedMailbox = undefined;
  await GE.runInboxReadTool("read_email", { id: "m1" }, caller, "UTC");
  check("7c resolver empty -> caller.entra_email", graphCalls().some((c) => c.url.includes("/users/login%40enterpriseds.io/messages/m1")), graphCalls().map((c) => c.url).join(" | "));

  calls = [];
  resolverThrows = true;
  await GE.runInboxReadTool("search_email", { query: "x" }, caller, "UTC");
  resolverThrows = false;
  check("7d resolver throws -> caller.entra_email, no crash", graphCalls().some((c) => c.url.includes("/users/login%40enterpriseds.io/messages?")));

  calls = [];
  resolvedMailbox = undefined;
  const none = await GE.runInboxReadTool("search_email", { query: "x", mailbox: "victim@other.com" }, {}, "UTC");
  check("7e no resolvable mailbox -> error, NO Graph call (args.mailbox never used)", none.ok === false && graphCalls().length === 0, JSON.stringify(none));

  calls = [];
  const wrong = await GE.runInboxReadTool("send_email", { to: "x@y.com" }, caller, "UTC");
  check("7f non-inbox tool name rejected, NO network", wrong.ok === false && calls.length === 0, JSON.stringify(wrong));

  calls = [];
  resolvedMailbox = "owner@enterpriseds.io";
  resolvedTz = "America/Los_Angeles";
  graphResponder = () => ({ status: 200, body: { value: [{ id: "m", receivedDateTime: "2026-11-03T17:00:00Z" }] } });
  const tz = (await GE.runInboxReadTool("search_email", { query: "x" }, caller, "UTC")) as any;
  check("7g owner zone from resolveTimeZone (not the browser arg)", String(tz.messages?.[0]?.received).includes("9:00") && String(tz.messages?.[0]?.received).includes("PST"), String(tz.messages?.[0]?.received));
}

console.log("\n--- 8. Read-only by construction (source) ---");
{
  const src = readFileSync(new URL("../src/features/huddle/lib/email/graph-email.server.ts", import.meta.url), "utf8");
  const start = src.indexOf("// INBOX READ (search_email / read_email)");
  const section = start >= 0 ? src.slice(start) : "";
  check("8a inbox section located", section.length > 0);
  check("8b inbox section issues no POST/PATCH/PUT/DELETE", !/method:\s*["'](POST|PATCH|PUT|DELETE)/i.test(section));
  check("8c inbox section never calls a send/draft helper", !/sendOrDraftEmail|sendMail|createReply|createFormattedReplyDraft/.test(section));
}

console.log("\n--- 9. Wiring: inside graphEmailConfigured(), outside the send gate, on all three surfaces ---");
/** The body of the first `{...}` block that opens at or after `from` (brace counting). */
function blockAt(src: string, from: number): string {
  const open = src.indexOf("{", from);
  if (from < 0 || open < 0) return "";
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(open, i + 1);
  }
  return "";
}
{
  const hf = readFileSync(new URL("../src/features/huddle/lib/huddle.functions.ts", import.meta.url), "utf8");
  const vf = readFileSync(new URL("../src/features/huddle/lib/voice/realtime-tools.server.ts", import.meta.url), "utf8");

  const oa = blockAt(hf, hf.indexOf("if (graphEmailConfigured())"));
  const oaSend = blockAt(oa, oa.indexOf("if (emailSendEnabled)"));
  check("9a OpenAI text: tools pushed inside the Graph gate", oa.includes("emailTools.push(SEARCH_EMAIL_TOOL, READ_EMAIL_TOOL)"));
  check("9b OpenAI text: NOT inside the send_email gate", oaSend.length > 0 && !oaSend.includes("SEARCH_EMAIL_TOOL"));
  check("9c OpenAI text: dispatch routes through runInboxReadTool", /INBOX_READ_TOOL_NAMES\.has\(c\.name\)\)\s*\{[\s\S]{0,400}runInboxReadTool/.test(hf));

  const lv = blockAt(hf, hf.indexOf("if (graphEmailConfigured())", hf.indexOf("if (graphEmailConfigured())") + 1));
  const lvSend = blockAt(lv, lv.indexOf("if (lovableEmailSendEnabled)"));
  check("9d Lovable text: search_email/read_email inside the Graph gate", lv.includes("lovableTools.search_email = tool(") && lv.includes("lovableTools.read_email = tool("));
  check("9e Lovable text: NOT inside the send_email gate", lvSend.length > 0 && !lvSend.includes("search_email"));

  const vb = blockAt(vf, vf.indexOf("if (graphEmailConfigured())"));
  const vSend = blockAt(vb, vb.indexOf("if (emailSendEnabled)"));
  check("9f voice: pushed inside the Graph gate", vb.includes("raw.push(SEARCH_EMAIL_TOOL, READ_EMAIL_TOOL)"));
  check("9g voice: NOT inside the send_email gate", vSend.length > 0 && !vSend.includes("SEARCH_EMAIL_TOOL"));
  check("9h voice: names in NATIVE (else they fall through to journey)", /const NATIVE[\s\S]{0,600}\.\.\.INBOX_READ_TOOL_NAMES/.test(vf));
  check("9i voice: dispatch routes through runInboxReadTool", /INBOX_READ_TOOL_NAMES\.has\(name\)\)\s*\{[\s\S]{0,200}runInboxReadTool/.test(vf));
  check("9j no surface gives the model a mailbox parameter", !("mailbox" in (IR.SEARCH_EMAIL_TOOL.parameters.properties as object)) && !("mailbox" in (IR.READ_EMAIL_TOOL.parameters.properties as object)));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
