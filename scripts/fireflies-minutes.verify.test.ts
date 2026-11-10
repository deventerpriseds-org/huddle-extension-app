// WHAT:       Adversarial checks written by the independent verifier for PR #191 (fireflies-minutes).
//             Each case is a scenario the PR's own test does not cover. A "DEFECT" line means the
//             scenario reproduces a refuted claim; "OK" means the code held.
// WHY:        VERIFY loop 1 of fireflies-minutes; see docs/qc-evidence/VERIFY-fireflies-minutes-1.md.
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   docs/qc-evidence/VERIFY-fireflies-minutes-1.md
// Run: bun scripts/fireflies-minutes.verify.test.ts
import { mock } from "bun:test";

const out = (ok: boolean, name: string, detail: unknown) =>
  console.log(`${ok ? "OK    " : "DEFECT"} ${name} :: ${JSON.stringify(detail)}`);

const SECRET = "s";
process.env.FIREFLIES_WEBHOOK_SECRET = SECRET;
process.env.FIREFLIES_API_KEY = "k";
process.env.FIREFLIES_ONEDRIVE_MAILBOX = "owner@example.com";

let settingsThrows = false;
const uploads: string[] = [];
mock.module("../src/features/huddle/lib/fireflies/minutes-store.server", () => ({
  getMinutesSettings: async () => {
    if (settingsThrows) throw new Error("settings_db_down");
    return null;
  },
  noteDelivery: async (id: string) => ({ meeting_id: id, email_status: null, content_hash: null }),
  claimEmail: async () => true,
  recordEmail: async () => {},
  recordEmailSkipped: async () => {},
  recordOneDrive: async () => {},
}));
mock.module("../src/features/huddle/lib/email/graph-email.server", () => ({
  emailFromOptions: () => ["sender@example.com"],
  graphEmailConfigured: () => true,
  getAppToken: async () => "t",
  sendGraphEmail: async () => ({ ok: true }),
}));
mock.module("../src/features/huddle/lib/fireflies/recipient-check.server", () => ({
  sendableTiers: async () => [{ address: "owner@example.com", tier: "auto", sends: true }],
}));
globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
  const u = String(url);
  if (u.includes("api.fireflies.ai"))
    return new Response(
      JSON.stringify({ data: { transcript: { id: "x", title: "T", sentences: [{ speaker_name: "A", text: "hi", start_time: 1 }], summary: { overview: "o" } } } }),
    );
  if (init?.method === "PUT") uploads.push(u);
  return new Response("{}", { status: 200 });
}) as typeof fetch;

const M = await import("../src/features/huddle/lib/fireflies/minutes");
const S = await import("../src/features/huddle/lib/fireflies/fireflies.server");

async function sign(body: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  return "sha256=" + [...sig].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// V1 -- C7: a 'sending' row left by a crashed/killed attempt. decideDelivery has no age input, so it returns
// skip_in_flight forever and claimEmail's 10-minute reclaim clause is never reached.
{
  const d = M.decideDelivery({ email_status: "sending", content_hash: null }, "h", false);
  out(d !== "skip_in_flight", "V1 C7 stale 'sending' row (crashed attempt) is never re-attempted", d);
}

// V2 -- C8: a settings-table read failure (email-side input) is thrown BEFORE Promise.allSettled,
// so the independent OneDrive save never runs.
{
  settingsThrows = true;
  uploads.length = 0;
  const body = JSON.stringify({ event: "meeting.transcribed", meeting_id: "abc" });
  const r = await S.handleFirefliesWebhook(body, await sign(body)).catch((e: Error) => ({ thrown: e.message }));
  out(uploads.length > 0, "V2 C8 settings read failure still lets OneDrive save run", { result: r, uploads: uploads.length });
  settingsThrows = false;
}

// V3 -- C9: HTML injection attempts through the Markdown renderer.
{
  const payloads = [
    "<script>alert(1)</script>",
    "**<img src=x onerror=alert(1)>**",
    "# <a href='javascript:alert(1)'>x</a>",
    "- `\"><svg onload=alert(1)>`",
    "*a\" onmouseover=\"x*",
    "  - nested <iframe>",
    "[link](javascript:alert(1))",
    "&lt;script&gt; double-escape",
  ];
  for (const p of payloads) {
    const html = M.markdownToEmailHtml(p);
    // Strip every tag the renderer is allowed to emit; any '<' left over is injected markup.
    const rest = html.replace(/<\/?(div|p|h[1-6]|ul|ol|li|strong|em|code|br)( style="[^"<>]*")?>/g, "");
    const bad = rest.includes("<") || rest.includes(">");
    out(!bad, "V3 C9 html-escape " + JSON.stringify(p), html);
  }
}

// V4 -- C2: meeting ids with special characters are sanitised, not rejected.
{
  out(M.safeMeetingId("../../etc/passwd") === null, "V4 C2 path-shaped meeting_id rejected", M.safeMeetingId("../../etc/passwd"));
  out(M.safeMeetingId("ab/c") !== M.safeMeetingId("abc"), "V4b C2 distinct ids map to distinct OneDrive files", [M.safeMeetingId("ab/c"), M.safeMeetingId("abc")]);
}

// V5 -- C7: decideDelivery after a recordEmailSkipped turned another delivery's 'sending' into 'failed'.
{
  const d = M.decideDelivery({ email_status: "failed", content_hash: null }, "h", false);
  out(d !== "send", "V5 C7 'failed' written over an in-flight 'sending' lets a 3rd delivery send too", d);
}
