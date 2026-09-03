// WHAT:       Offline guard — the VOICE (Realtime) toolset must never offer two tools with the same
//             name as a Huddle-native one. Specifically: exactly ONE `send_email` (the native Graph
//             schema that REQUIRES a recipient) and ZERO journey `web_search`.
// WHY:        buildRealtimeToolset pushed journey's ENTIRE catalog unfiltered on top of its own
//             native Graph `send_email`, while the text path filtered it through HIDDEN_FROM_HUDDLE.
//             Journey's `send_email` has no recipient field and mails the OWNER, and the model picks
//             by name — so the wrong pick SUCCEEDED and reported success ("email Sarah" -> emailed
//             the owner). Verified from source 2026-09-03.
// SUPERSEDES: nothing
// SUPERSEDED-BY: nothing -- current
// EVIDENCE:   docs/cross-app-agent/FIX-send-email-collision.md (nexus-hub)
//
// Run:  npm run test:voice-tools     (bun scripts/voice-toolset-hidden.test.ts)
// No network, no API spend: journey's /tools catalog is served by a stubbed global fetch, so the
// REAL buildRealtimeToolset + the REAL filter run against a known catalog.

// Env must be set BEFORE the module graph loads (journeyEnv/graphEmailConfigured read at call time,
// but set them up front regardless).
process.env.JOURNEY_PROXY_URL = "https://journey.test/functions/v1/huddle-proxy";
process.env.JOURNEY_PROXY_TOKEN = "test-token";
process.env.AZURE_CLIENT_ID = "test-client";
process.env.AZURE_CLIENT_SECRET = "test-secret";
process.env.AZURE_TENANT_ID = "test-tenant";

// The catalog journey really returns includes both names Huddle owns natively. `send_email` here is
// journey's shape: NO `to` — it mails the owner.
const JOURNEY_CATALOG = [
  {
    name: "send_email",
    description: "Send an email to the user.",
    parameters: {
      type: "object",
      properties: { subject: { type: "string" }, body: { type: "string" } },
      required: ["subject", "body"],
    },
  },
  {
    name: "web_search",
    description: "Search the web.",
    parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  },
  {
    name: "create_task",
    description: "Create a task on the user's board.",
    parameters: { type: "object", properties: { title: { type: "string" } }, required: ["title"] },
  },
];

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url);
  if (url.includes("/tools")) {
    return new Response(JSON.stringify({ ok: true, tools: JOURNEY_CATALOG }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  throw new Error(`unexpected network call in offline test: ${url} (${init?.method ?? "GET"})`);
}) as typeof fetch;

const { buildRealtimeToolset } = await import("../src/features/huddle/lib/voice/realtime-tools.server");

let pass = 0,
  fail = 0;
function check(label: string, cond: boolean, detail: string) {
  console.log(`  ${cond ? "PASS" : "FAIL"} ${label} — ${detail}`);
  cond ? pass++ : fail++;
}

type Tool = { type?: string; name?: string; parameters?: { required?: string[] } };

const { tools, journeyNames } = await buildRealtimeToolset("iris-chase", {
  webSearch: true,
  journey: true,
});
const named = (n: string) => (tools as Tool[]).filter((t) => t?.name === n);
const names = (tools as Tool[]).map((t) => t?.name).filter(Boolean) as string[];
console.log(`\nvoice toolset (${tools.length}): ${names.join(", ")}\n`);

// 1. THE defect: two tools called send_email.
const sendEmails = named("send_email");
check("exactly ONE send_email in the voice toolset", sendEmails.length === 1, `found ${sendEmails.length}`);

// 2. …and the survivor is the NATIVE Graph one, which cannot silently mail the owner.
const req = sendEmails[0]?.parameters?.required ?? [];
check(
  "the surviving send_email REQUIRES a recipient (native Graph schema)",
  req.includes("to"),
  `required = [${req.join(", ")}]`,
);

// 3. The other HIDDEN_FROM_HUDDLE member.
check("journey web_search is NOT offered (Huddle owns tavily_web_search)", named("web_search").length === 0, `found ${named("web_search").length}`);
check("native tavily_web_search IS offered", named("tavily_web_search").length === 1, `found ${named("tavily_web_search").length}`);

// 4. Control: the filter must not nuke the rest of the catalog, and journeyNames must reflect what
//    is actually offered (nothing consumes it today, but a stale set would mislead a future reader).
check("a benign journey tool still reaches the toolset", named("create_task").length === 1, `found ${named("create_task").length}`);
check("journeyNames excludes the hidden names", !journeyNames.has("send_email") && !journeyNames.has("web_search"), `journeyNames = [${[...journeyNames].join(", ")}]`);
check("journeyNames still carries the benign tool", journeyNames.has("create_task"), `journeyNames = [${[...journeyNames].join(", ")}]`);

globalThis.fetch = realFetch;
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
