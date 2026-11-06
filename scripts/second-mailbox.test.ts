// WHAT:       Offline tests for the second-mailbox (@trinnex.io) path: the all-accounts picker, the
//             server-only gate on the mail-token tool, and mailboxAccess's key/URL choice.
// WHY:        2026-11-05 — the owner's work mailbox is in another company's Microsoft tenant, which
//             Huddle's app-only key cannot reach. These pin that EnterpriseDS mailboxes behave exactly
//             as before, that a model can never fetch a mail token, and that the token is never echoed.
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   .claude/actions.md ACT:trinnex-mailbox; journey-voice _shared/mail-access-token.ts.
// Run: bun scripts/second-mailbox.test.ts
import {
  appKeyDomains,
  isAppKeyMailbox,
  pickOutlookMailbox,
  pickOutlookMailboxes,
} from "../src/features/huddle/lib/journey/calendar-mailbox";

let fail = 0;
const t = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : `\n   got:  ${JSON.stringify(got)}\n   want: ${JSON.stringify(want)}`}`);
};
const conns = (c: unknown[]) => JSON.stringify({ calendar_connections: c });

console.log("A. PICKER — every connected Outlook account, EnterpriseDS first");
{
  const trinnexFirst = conns([
    { provider: "office365", provider_account_email: "Von.Ellis@Trinnex.io", is_active: true },
    { provider: "office365", provider_account_email: "Von.Ellis@EnterpriseDS.io", is_active: true },
    { provider: "outlook", provider_account_email: "Dev@EnterpriseDS.io", is_active: true },
    { provider: "google", provider_account_email: "x@gmail.com", is_active: true },
  ]);
  t("A1 a Trinnex row listed FIRST does not become the main mailbox", pickOutlookMailbox(trinnexFirst), "von.ellis@enterpriseds.io");
  t("A2 main EnterpriseDS mailbox + outside mailboxes ONLY — a second EnterpriseDS account (Dev@) is not merged", pickOutlookMailboxes(trinnexFirst), [
    "von.ellis@enterpriseds.io",
    "von.ellis@trinnex.io",
  ]);
  t("A8 today's real connections (two EnterpriseDS, no Trinnex) -> exactly ONE mailbox, as before", pickOutlookMailboxes(conns([
    { provider: "office365", provider_account_email: "Von.Ellis@EnterpriseDS.io", is_active: true },
    { provider: "outlook", provider_account_email: "Dev@EnterpriseDS.io", is_active: true },
  ])), ["von.ellis@enterpriseds.io"]);
  t("A3 duplicates and inactive rows are dropped", pickOutlookMailboxes(conns([
    { provider: "office365", provider_account_email: "a@enterpriseds.io", is_active: true },
    { provider: "office365", provider_account_email: "A@EnterpriseDS.io", is_active: true },
    { provider: "office365", provider_account_email: "b@trinnex.io", is_active: false },
  ])), ["a@enterpriseds.io"]);
  t("A4 only a Trinnex account connected -> it is the main one", pickOutlookMailbox(conns([
    { provider: "office365", provider_account_email: "v@trinnex.io", is_active: true },
  ])), "v@trinnex.io");
  t("A5 unparseable -> [] (caller falls back)", pickOutlookMailboxes("nope"), []);
  t("A6 app-key domain check", [isAppKeyMailbox("x@EnterpriseDS.io"), isAppKeyMailbox("x@trinnex.io"), isAppKeyMailbox("")], [true, false, false]);
  t("A7 env override (comma list, leading @ ok); blank -> default", [appKeyDomains("@a.com, b.org"), appKeyDomains("  ")], [["a.com", "b.org"], ["enterpriseds.io"]]);
}

// ---- network stubs for B and C --------------------------------------------------------------
process.env.JOURNEY_PROXY_URL = "https://journey.test/huddle-proxy";
process.env.JOURNEY_PROXY_TOKEN = "proxy-token";
process.env.AZURE_TENANT_ID = "tenant";
process.env.AZURE_CLIENT_ID = "client";
process.env.AZURE_CLIENT_SECRET = "secret";
delete process.env.HUDDLE_GRAPH_APP_DOMAINS;
const calls: { url: string; body: string }[] = [];
let journeyReply: unknown = { ok: true, output: JSON.stringify({ access_token: "DELEGATED-AT", expires_in: 3600 }) };
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  calls.push({ url, body: String(init?.body ?? "") });
  if (url.includes("login.microsoftonline.com")) return new Response(JSON.stringify({ access_token: "APP-AT", expires_in: 3600 }), { status: 200 });
  if (url.startsWith("https://journey.test")) return new Response(JSON.stringify(journeyReply), { status: 200 });
  return new Response("unexpected", { status: 500 });
}) as typeof fetch;

const { invokeJourneyTool } = await import("../src/features/huddle/lib/journey/proxy.functions");
const { mailboxAccess } = await import("../src/features/huddle/lib/email/graph-email.server");

console.log("B. GATE — the mail-token tool is server-only");
{
  calls.length = 0;
  const r = await invokeJourneyTool({ toolName: "get_mail_access_token", args: { account_email: "v@trinnex.io" }, caller: {} } as never);
  t("B1 refused without allowServerOnly (what every model / voice / debug path sends)", [r.ok, JSON.parse(r.output).error], [false, "not_allowed"]);
  t("B2 refused BEFORE any network call", calls.length, 0);
  const ui = await invokeJourneyTool({ toolName: "get_mail_access_token", args: {}, caller: {} } as never, { allowUiOnly: true });
  t("B3 a UI-only pass does NOT open it", ui.ok, false);
}

console.log("C. mailboxAccess — the right key and URL per mailbox");
{
  calls.length = 0;
  const a = await mailboxAccess("Von.Ellis@EnterpriseDS.io");
  t("C1 EnterpriseDS mailbox -> app key + /users/{mailbox}, no journey call", [a.token, a.base, a.delegated, calls.some((c) => c.url.startsWith("https://journey.test"))], [
    "APP-AT",
    "https://graph.microsoft.com/v1.0/users/Von.Ellis%40EnterpriseDS.io",
    false,
    false,
  ]);
  let threw = "";
  try {
    await mailboxAccess("v@trinnex.io");
  } catch (e) {
    threw = (e as Error).message;
  }
  t("C2 outside mailbox with no owner is refused, never guessed", /no owner/.test(threw), true);

  journeyReply = { ok: false, output: JSON.stringify({ error: "consent_required" }), error: "consent_required" };
  threw = "";
  try {
    await mailboxAccess("v@trinnex.io", "dev@enterpriseds.io");
  } catch (e) {
    threw = (e as Error).message;
  }
  t("C3 employer approval pending -> plain reason", /admin approval/.test(threw), true);

  journeyReply = { ok: true, output: JSON.stringify({ access_token: "DELEGATED-AT", expires_in: 3600 }) };
  calls.length = 0;
  const d = await mailboxAccess("V@Trinnex.io", "dev@enterpriseds.io");
  const sent = JSON.parse(calls.find((c) => c.url.startsWith("https://journey.test"))?.body ?? "{}");
  t("C4 outside mailbox -> delegated token + /me", [d.token, d.base, d.delegated], ["DELEGATED-AT", "https://graph.microsoft.com/v1.0/me", true]);
  t("C5 journey asked for THIS account as THIS owner", [sent.toolName, sent.args?.account_email, sent.caller?.entra_email], [
    "get_mail_access_token",
    "v@trinnex.io",
    "dev@enterpriseds.io",
  ]);
  calls.length = 0;
  await mailboxAccess("v@trinnex.io", "dev@enterpriseds.io");
  t("C6 token is cached (no second journey call within its life)", calls.length, 0);

  journeyReply = { ok: true, output: JSON.stringify({ nope: true, secret: "LEAK-ME" }) };
  threw = "";
  try {
    await mailboxAccess("other@trinnex.io", "dev@enterpriseds.io");
  } catch (e) {
    threw = (e as Error).message;
  }
  t("C7 a malformed reply is an error that never echoes journey's output", [!!threw, threw.includes("LEAK-ME")], [true, false]);
}

const { withExtraMailboxTimeout, pickReplyOriginal, getOwnerCalendarEvents } = await import(
  "../src/features/huddle/lib/email/graph-email.server"
);

console.log("D. EXTRA-MAILBOX TIME LIMIT — a hanging outside mailbox cannot hold up the main one");
{
  const t0 = Date.now();
  // The test bounds ITSELF: without the helper's limit this would hang forever, so a 1s guard turns
  // that into a visible FAIL (and keeps a mutation run from hanging).
  const hung = await Promise.race([
    withExtraMailboxTimeout(new Promise<string>(() => {}), "timed out", 50),
    new Promise<string>((r) => setTimeout(() => r("HUNG — no limit applied"), 1000)),
  ]);
  t("D1 a call that never settles resolves to the fallback at the limit", [hung, Date.now() - t0 < 1000], ["timed out", true]);
  t("D2 a call that rejects resolves to the fallback", await withExtraMailboxTimeout(Promise.reject(new Error("x")), "fb", 50), "fb");
  t("D3 a fast call returns its own value", await withExtraMailboxTimeout(Promise.resolve("ok"), "fb", 50), "ok");
}

console.log("E. REPLY ORIGINAL — the mailbox that holds the email being answered wins");
{
  const f = (mailbox: string, received: string, hintMatch = false) => ({ ok: true, mailbox, hintMatch, original: { receivedDateTime: received } });
  t("E1 newest wins when no subject was named", pickReplyOriginal([f("main", "2026-11-01T10:00:00Z"), f("trinnex", "2026-11-05T10:00:00Z")])?.mailbox, "trinnex");
  t("E2 a subject match beats a newer message elsewhere", pickReplyOriginal([f("main", "2026-11-05T10:00:00Z"), f("trinnex", "2026-11-01T10:00:00Z", true)])?.mailbox, "trinnex");
  t("E3 failed lookups are never chosen", pickReplyOriginal([{ ok: false, mailbox: "main" }, f("trinnex", "2026-11-01T10:00:00Z")])?.mailbox, "trinnex");
}

console.log("F. TOKEN CACHE — keyed by owner AND mailbox");
{
  let n = 0;
  journeyReply = undefined as unknown;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("https://journey.test")) {
      n++;
      const who = JSON.parse(String(init?.body ?? "{}")).caller?.entra_email;
      return new Response(JSON.stringify({ ok: true, output: JSON.stringify({ access_token: `TOKEN-FOR-${who}`, expires_in: 3600 }) }), { status: 200 });
    }
    return realFetch(input, init);
  }) as typeof fetch;
  const a = await mailboxAccess("shared@trinnex.io", "ownerA@enterpriseds.io");
  const b = await mailboxAccess("shared@trinnex.io", "ownerB@enterpriseds.io");
  t("F1 a second owner gets their OWN token, minted by journey", [a.token, b.token, n], [
    "TOKEN-FOR-ownerA@enterpriseds.io",
    "TOKEN-FOR-ownerB@enterpriseds.io",
    2,
  ]);
  let threw = "";
  try {
    await mailboxAccess("shared@trinnex.io");
  } catch (e) {
    threw = (e as Error).message;
  }
  t("F2 no owner is refused even with a warm cache", /no owner/.test(threw), true);
  globalThis.fetch = realFetch;
}

console.log("G. MAIN MAILBOX DECIDES — a failed main read is never reported as ok");
{
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("https://journey.test")) {
      const body = JSON.parse(String(init?.body ?? "{}"));
      if (body.toolName === "get_my_config")
        return new Response(JSON.stringify({ ok: true, output: conns([
          { provider: "office365", provider_account_email: "main@enterpriseds.io", is_active: true },
          { provider: "office365", provider_account_email: "g@trinnex.io", is_active: true },
        ]) }), { status: 200 });
      return new Response(JSON.stringify({ ok: true, output: JSON.stringify({ access_token: "D", expires_in: 3600 }) }), { status: 200 });
    }
    if (url.includes("login.microsoftonline.com")) return new Response(JSON.stringify({ access_token: "APP-AT" }), { status: 200 });
    if (url.includes("/users/main%40enterpriseds.io/calendarView")) return new Response("boom", { status: 500 });
    if (url.includes("/me/calendarView"))
      return new Response(JSON.stringify({ value: [{ id: "x", subject: "Trinnex standup", start: { dateTime: "2026-11-06T14:00:00" } }] }), { status: 200 });
    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;
  const r = await getOwnerCalendarEvents({ caller: { entra_email: "g-test@enterpriseds.io" }, startISO: "2026-11-06T00:00:00", endISO: "2026-11-06T23:59:59" });
  t("G1 main calendar fails, Trinnex answers -> NOT ok (never a falsely clear calendar)", r.ok, false);
  globalThis.fetch = realFetch;
}

if (fail) {
  console.log(`\n${fail} FAILED`);
  process.exit(1);
}
console.log("\nall passed");
