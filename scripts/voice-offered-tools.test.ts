// WHAT:       offline guard: the VOICE tool executor forwards to journey ONLY tools the model is actually
//             offered, and never `register_push_token`.
// WHY:        journey-voice VERIFY-phone-registration-a-3 (2026-10-28): runRealtimeTool takes the tool NAME and
//             caller from the browser; executeRealtimeTool's fallthrough forwarded ANY non-native name to
//             invokeJourneyTool -> huddle-proxy (service role) -> execute-tool `register_push_token`, which
//             accepts the service role, so an attacker's phone could be registered for any user. The text path
//             already checked names against the offered set (`journeyNames.has(c.name)`).
// SUPERSEDES: nothing. SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   journey-voice docs/qc-evidence/RESTORE-step3-j13-j14-security.md ("Loop 4 fix")
//
// Run:  npm run test:voice-offered-tools   (bun scripts/voice-offered-tools.test.ts)
// No network: journey's /tools and /tool are served by a stubbed global fetch.
process.env.JOURNEY_PROXY_URL = "https://journey.test/functions/v1/huddle-proxy";
process.env.JOURNEY_PROXY_TOKEN = "test-token";

// A catalog that (hypothetically) even LISTS register_push_token, to prove the explicit refusal does not
// depend on the catalog leaving it out.
const JOURNEY_CATALOG = [
  { name: "create_task", description: "Create a task.", parameters: { type: "object", properties: { title: { type: "string" } } } },
  { name: "register_push_token", description: "internal", parameters: { type: "object", properties: {} } },
];
const wire: { toolName: string; caller: any }[] = [];
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url);
  if (url.endsWith("/tools")) return new Response(JSON.stringify({ ok: true, tools: JOURNEY_CATALOG }), { status: 200 });
  if (url.endsWith("/tool")) {
    const b = JSON.parse(String(init?.body ?? "{}"));
    wire.push({ toolName: b.toolName, caller: b.caller });
    return new Response(JSON.stringify({ ok: true, output: JSON.stringify({ success: true }) }), { status: 200 });
  }
  throw new Error(`unexpected network call in offline test: ${url}`);
}) as typeof fetch;

const { executeRealtimeTool } = await import("../src/features/huddle/lib/voice/realtime-tools.server");
const { isOfferedJourneyTool, fetchJourneyToolDefinitionsForHuddle } = await import("../src/features/huddle/lib/journey/proxy.functions");

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` -- ${detail}` : ""}`); }
}
// caller {} as in voice-toolset-hidden.test.ts: an email would make the fire-and-forget telemetry try the database.
// The gate under test is on the tool NAME and runs before anything reads the caller.
const CTX = { agentId: "iris-chase" as const, caller: {}, huddleId: "x", timeZone: "UTC" };
async function run(name: string, args: Record<string, unknown> = {}) {
  wire.length = 0;
  const r = await executeRealtimeTool(name, args, CTX as any);
  return { out: r.output, wire: [...wire] };
}

console.log("\n--- voice fallthrough ---");
let r = await run("register_push_token", { fcm_token: "ATTACKER-PHONE-TOKEN" });
check("VO-1: register_push_token from the voice data channel is REFUSED and never reaches journey (verifier R2 case)", r.wire.length === 0 && /not available on the voice path/.test(r.out), JSON.stringify(r));
r = await run("delete_everything_for_probe", {});
check("VO-2: a journey tool name the model was never offered is refused, nothing forwarded", r.wire.length === 0 && /not offered on the voice path/.test(r.out), JSON.stringify(r));
r = await run("create_task", { title: "Test-voice offered tool" });
check("VO-3: an OFFERED journey tool still forwards, under its own name", r.wire.length === 1 && r.wire[0].toolName === "create_task", JSON.stringify(r));

console.log("\n--- shared source of truth ---");
check("VO-4: isOfferedJourneyTool: offered tool true, register_push_token false even when the catalog lists it, unknown false",
  (await isOfferedJourneyTool("create_task")) === true && (await isOfferedJourneyTool("register_push_token")) === false && (await isOfferedJourneyTool("nope")) === false);
check("VO-5: fetchJourneyToolDefinitionsForHuddle (what text + voice OFFER) drops register_push_token",
  !(await fetchJourneyToolDefinitionsForHuddle()).some((d) => d.name === "register_push_token"));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
