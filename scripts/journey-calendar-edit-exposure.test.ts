// WHAT:       Offline guard that journey's new update_calendar_event / delete_calendar_event reach
//             Huddle agents ONLY through the existing journey-catalog path, with no Huddle code:
//             (1) fetchJourneyToolDefinitionsForHuddle passes them (not in HIDDEN_FROM_HUDDLE);
//             (2) invokeJourneyTool forwards them (not in UI_ONLY_JOURNEY_TOOLS — the delete guard is
//                 journey-side: user_explicitly_requested must be true, plus ambiguity refusal);
//             (3) VOICE offers them only when opts.journey !== false;
//             (4) a voice call is proxied to journey under its own name (no native shadow).
//             The TEXT gate (ensureJourneyTools: null unless a member has journey.enabled) lives inside
//             runHuddleTurn and is not unit-reachable; it is unchanged and read from source in
//             docs/qc-evidence/BUILD-calendar-edit.md.
// WHY:        journey had create-only calendar tools; the new edit/delete tools must be exposed by the
//             catalog alone, behind the same journey toggle as every other journey tool.
// SUPERSEDES: nothing
// SUPERSEDED-BY: nothing -- current
// EVIDENCE:   docs/qc-evidence/BUILD-calendar-edit.md
//
// Run:  npm run test:calendar-edit   (bun scripts/journey-calendar-edit-exposure.test.ts)
// No network: journey's /tools and /tool are served by a stubbed global fetch.

process.env.JOURNEY_PROXY_URL = "https://journey.test/functions/v1/huddle-proxy";
process.env.JOURNEY_PROXY_TOKEN = "test-token";

const JOURNEY_CATALOG = [
  { name: "create_calendar_event", description: "Create a calendar event.", parameters: { type: "object", properties: { title: { type: "string" } }, required: ["title"] } },
  { name: "update_calendar_event", description: "Move, retime or rename an event.", parameters: { type: "object", properties: { event_id: { type: "string" } } } },
  {
    name: "delete_calendar_event",
    description: "Delete an event. ONLY when the user explicitly asked.",
    parameters: { type: "object", properties: { event_id: { type: "string" }, user_explicitly_requested: { type: "boolean" } }, required: ["user_explicitly_requested"] },
  },
  { name: "send_email", description: "mails the owner", parameters: { type: "object", properties: {} } },
];

const journeyCalls: string[] = [];
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url);
  if (url.includes("/tools")) {
    return new Response(JSON.stringify({ ok: true, tools: JOURNEY_CATALOG }), { status: 200, headers: { "content-type": "application/json" } });
  }
  if (url.includes("/tool")) {
    journeyCalls.push(String(JSON.parse(String(init?.body ?? "{}")).toolName ?? ""));
    return new Response(JSON.stringify({ ok: true, output: "{}" }), { status: 200, headers: { "content-type": "application/json" } });
  }
  throw new Error(`unexpected network call in offline test: ${url}`);
}) as typeof fetch;

const proxy = await import("../src/features/huddle/lib/journey/proxy.functions");
const { buildRealtimeToolset, executeRealtimeTool } = await import("../src/features/huddle/lib/voice/realtime-tools.server");

let pass = 0,
  fail = 0;
function check(label: string, cond: boolean, detail: string) {
  console.log(`  ${cond ? "PASS" : "FAIL"} ${label} — ${detail}`);
  cond ? pass++ : fail++;
}
const NEW = ["update_calendar_event", "delete_calendar_event"];

// (1) catalog filter
const defs = await proxy.fetchJourneyToolDefinitionsForHuddle();
const defNames = defs.map((d) => d.name);
for (const n of NEW) check(`catalog: ${n} passes HIDDEN_FROM_HUDDLE`, defNames.includes(n), `[${defNames.join(", ")}]`);
check("catalog: create_calendar_event unchanged", defNames.includes("create_calendar_event"), `[${defNames.join(", ")}]`);
check("catalog: send_email still hidden (control)", !defNames.includes("send_email"), `[${defNames.join(", ")}]`);

// (2) chokepoint forwards both
for (const n of NEW) {
  journeyCalls.length = 0;
  const r = await proxy.invokeJourneyTool({ toolName: n, args: { event_id: "e1", user_explicitly_requested: true } } as never);
  check(`invokeJourneyTool forwards ${n} (not UI-only)`, r.ok === true && journeyCalls.includes(n), `ok=${r.ok} calls=[${journeyCalls.join(", ")}]`);
}
journeyCalls.length = 0;
const del = await proxy.invokeJourneyTool({ toolName: "delete_task", args: {} } as never);
check("control: delete_task still UI-only", del.ok === false && journeyCalls.length === 0, `ok=${del.ok}`);

// (3) voice gate
type Tool = { name?: string };
const on = await buildRealtimeToolset("iris-chase", { webSearch: false, journey: true });
const off = await buildRealtimeToolset("iris-chase", { webSearch: false, journey: false });
const onNames = (on.tools as Tool[]).map((t) => t.name);
const offNames = (off.tools as Tool[]).map((t) => t.name);
for (const n of NEW) {
  check(`voice journey:true offers ${n}`, onNames.filter((x) => x === n).length === 1, `count=${onNames.filter((x) => x === n).length}`);
  check(`voice journey:false does NOT offer ${n}`, !offNames.includes(n), `[${offNames.join(", ")}]`);
}

// (4) voice dispatch goes to journey under the same name
const CTX = { agentId: "iris-chase" as const, caller: {}, huddleId: "dm-iris-chase", timeZone: "UTC" };
for (const n of NEW) {
  journeyCalls.length = 0;
  await executeRealtimeTool(n, { event_id: "e1", user_explicitly_requested: true }, CTX as never);
  check(`voice ${n} is proxied to journey as ${n}`, journeyCalls.includes(n), `calls=[${journeyCalls.join(", ")}]`);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
