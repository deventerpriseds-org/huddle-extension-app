// WHAT:       Offline guard for the VOICE (Realtime) surface, now covering THREE defect classes:
//             (1) NAME COLLISION — never two tools with the same name as a Huddle-native one:
//                 exactly ONE `send_email` (the native Graph schema that REQUIRES a recipient) and
//                 ZERO journey `web_search`.
//             (2) HALF-WIRED NATIVE TOOL — every Huddle-native tool must be offered by
//                 buildRealtimeToolset AND dispatched natively by executeRealtimeTool. The dispatcher
//                 routes on a local NATIVE set and everything else falls through to invokeJourneyTool,
//                 so a tool added to the toolset but NOT to NATIVE is silently proxied to journey,
//                 where it does not exist. The assertions below prove the DISPATCH, not just the set:
//                 they observe which journey tool name (if any) actually goes out on the wire.
//             (3) NO TELEMETRY — every executeRealtimeTool call, native or journey-fallthrough,
//                 must emit a tool-use record. The voice path recorded nothing at all, which is the
//                 observability gap that let defect class (1) live here for weeks unseen.
// WHY:        buildRealtimeToolset pushed journey's ENTIRE catalog unfiltered on top of its own
//             native Graph `send_email`, while the text path filtered it through HIDDEN_FROM_HUDDLE.
//             Journey's `send_email` has no recipient field and mails the OWNER, and the model picks
//             by name — so the wrong pick SUCCEEDED and reported success ("email Sarah" -> emailed
//             the owner). Verified from source 2026-09-03.
// SUPERSEDES: nothing
// SUPERSEDED-BY: nothing -- current
// EVIDENCE:   docs/cross-app-agent/FIX-send-email-collision.md and
//             docs/cross-app-agent/FIX-voice-telemetry.md (nexus-hub)
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

// The EMAIL SEND GATE (docs/cross-app-agent/FIX-email-send-gate.md, nexus-hub) means the toolset
// above is the DRAFTS-ONLY one: offline there is no AZURE_PG_URL, so isEmailSendEnabled fails closed
// and send_email is not offered at all. Build a second toolset with the gate open so the original
// name-collision assertions still run against the state where send_email actually exists.
// `emailSendEnabled: true` is the pre-resolved form of the same flag the mint path resolves from the
// database; it exercises the ASSEMBLY wiring. The database read itself needs a database and is NOT
// claimed here.
const { tools: toolsSendOn } = await buildRealtimeToolset("iris-chase", {
  webSearch: true,
  journey: true,
  emailSendEnabled: true,
});
const namedOn = (n: string) => (toolsSendOn as Tool[]).filter((t) => t?.name === n);

// 1. THE defect: two tools called send_email.
const sendEmails = namedOn("send_email");
check("exactly ONE send_email in the voice toolset (gate OPEN)", sendEmails.length === 1, `found ${sendEmails.length}`);

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

// ---------------------------------------------------------------------------------------------
// PART 2 — the tools closed by docs/cross-app-agent/FIX-voice-capability-gaps.md (nexus-hub).
// Each one needs BOTH halves. The DEFINITION half is a plain lookup in the toolset above. The
// DISPATCH half is proved by watching the wire: executeRealtimeTool's journey fallthrough posts
// /tool with `toolName` set to the ORIGINAL name, so if a native tool is missing from NATIVE we see
// its own name go out to journey. A correctly-native tool either posts a DIFFERENT journey tool
// (quick_create_task / parse_and_create_tasks) or posts nothing at all.

const { executeRealtimeTool } = await import("../src/features/huddle/lib/voice/realtime-tools.server");

/** Every toolName posted to journey's /tool during one executeRealtimeTool call. */
const journeyCalls: string[] = [];
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url);
  if (url.includes("/tools")) {
    return new Response(JSON.stringify({ ok: true, tools: JOURNEY_CATALOG }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  if (url.includes("/tool")) {
    try {
      journeyCalls.push(String(JSON.parse(String(init?.body ?? "{}")).toolName ?? ""));
    } catch {
      journeyCalls.push("<unparseable>");
    }
    return new Response(JSON.stringify({ ok: true, output: "{}" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  throw new Error(`unexpected network call in offline test: ${url} (${init?.method ?? "GET"})`);
}) as typeof fetch;

// caller {} on purpose: no entra_email, so the cross-turn dedup read short-circuits and no database
// is touched. The dispatch decision under test happens before any of that.
const CTX = { agentId: "iris-chase" as const, caller: {}, huddleId: "dm-iris-chase", timeZone: "UTC" };

async function dispatched(name: string, args: Record<string, unknown>): Promise<string[]> {
  journeyCalls.length = 0;
  await executeRealtimeTool(name, args, CTX);
  return [...journeyCalls];
}

for (const [tool, args, expectedJourneyTool] of [
  ["create_huddle_task", { title: "Test-voice parity single" }, "quick_create_task"],
  ["create_huddle_tasks", { tasks: ["Test-voice parity A", "Test-voice parity B"] }, "parse_and_create_tasks"],
  ["confirm_task_intent", {}, null],
] as Array<[string, Record<string, unknown>, string | null]>) {
  // HALF 1 — the model is actually offered it.
  check(`${tool} is OFFERED by buildRealtimeToolset`, named(tool).length === 1, `found ${named(tool).length}`);
  // HALF 2 — and executeRealtimeTool handles it natively instead of proxying it to journey.
  const calls = await dispatched(tool, args);
  check(
    `${tool} is dispatched NATIVELY (never proxied to journey under its own name)`,
    !calls.includes(tool),
    `journey /tool calls = [${calls.join(", ")}]`,
  );
  if (expectedJourneyTool) {
    check(
      `${tool} reaches journey via ${expectedJourneyTool} (the native executor ran)`,
      calls.includes(expectedJourneyTool),
      `journey /tool calls = [${calls.join(", ")}]`,
    );
  }
}

// The confirm gate must FAIL CLOSED on voice: with no outstanding confirm-intent ask it must refuse,
// and it must never write anything. A voice confirm that can manufacture a confirmation is worse than
// no voice confirm at all (memory.md 2026-08-05: the gate was ON and 8 unconfirmed tasks still reached
// review). Note the model is given NO task_id and NO definition_of_done to supply — see the schema.
const confirmTool = named("confirm_task_intent")[0] as
  | { parameters?: { properties?: Record<string, unknown>; required?: string[] } }
  | undefined;
const confirmProps = Object.keys(confirmTool?.parameters?.properties ?? {});
check(
  "voice confirm_task_intent does NOT let the model choose the task (no task_id param)",
  !confirmProps.includes("task_id"),
  `params = [${confirmProps.join(", ")}]`,
);
check(
  "voice confirm_task_intent does NOT let the model author the DoD (no definition_of_done param)",
  !confirmProps.includes("definition_of_done"),
  `params = [${confirmProps.join(", ")}]`,
);
const confirmOut = JSON.parse((await executeRealtimeTool("confirm_task_intent", {}, CTX)).output) as {
  ok?: boolean;
};
// HONEST SCOPE, stated because the label used to overclaim: offline there is no database, so the
// executor cannot get as far as the no-pending-ask branch — it refuses earlier, at identity. What
// this proves is that NO offline path returns ok, i.e. the executor never reports a confirmation it
// did not obtain. The no-pending-ask refusal itself is structural (getPendingConfirmForAgent filters
// confirm_status='asked' AND assigned_agent) and is NOT offline-provable; a mutation that fails it
// open comes back INERT here for exactly that reason, which is equivalence, not a broken guard.
check(
  "voice confirm_task_intent never returns ok when it cannot establish identity or state",
  confirmOut.ok !== true,
  `ok = ${String(confirmOut.ok)}`,
);

// ---------------------------------------------------------------------------------------------
// PART 3 — TOOL TELEMETRY (docs/cross-app-agent/FIX-voice-telemetry.md, nexus-hub).
// The defect this guards: the voice path recorded NOTHING. Measured on RAG_AI_Agents 2026-09-03,
// chat.ceremony_transcript held 236 kind='tool' rows and ZERO on a voice call (huddle_id LIKE
// 'dm-%'), while 19 voice rows existed — all spoken turns. That blindness is why the duplicate
// send_email survived here for weeks, so the guard has to cover BOTH halves of the dispatcher:
// a NATIVE tool and the JOURNEY FALLTHROUGH. Covering only the easy half would rebuild the exact
// asymmetry that caused the original defect.
//
// SCOPE, stated honestly: the durable INSERT needs a database and a resolved user email, and this
// test is offline with caller {} — so what is proved here is that executeRealtimeTool EMITS a
// telemetry event, with the right tool name, the right branch, and a real duration, on both paths.
// The INSERT itself (appendCeremonyToolCall) is not offline-provable and is not claimed.
const { __observeVoiceToolUse } = await import(
  "../src/features/huddle/lib/voice/voice-tool-telemetry.server"
);

type TelemetryEvent = { toolName: string; via: string; ms: number; ok: boolean; agentId: string };
const telemetry: TelemetryEvent[] = [];
const stopObserving = __observeVoiceToolUse((ev) => {
  telemetry.push({ toolName: ev.toolName, via: ev.via, ms: ev.ms, ok: ev.ok, agentId: ev.agentId });
});

async function telemetryFor(name: string, args: Record<string, unknown>): Promise<TelemetryEvent[]> {
  telemetry.length = 0;
  await executeRealtimeTool(name, args, CTX);
  return telemetry.filter((e) => e.toolName === name);
}

// HALF 1 — a NATIVE tool is recorded.
const nativeEvents = await telemetryFor("create_huddle_task", { title: "Test-voice telemetry native" });
check(
  "a NATIVE voice tool call is RECORDED (tool telemetry emitted)",
  nativeEvents.length === 1,
  `events for create_huddle_task = ${nativeEvents.length}`,
);
check(
  "the native telemetry row is attributed to the native branch and the calling agent",
  nativeEvents[0]?.via === "native" && nativeEvents[0]?.agentId === "iris-chase",
  `via = ${nativeEvents[0]?.via}, agentId = ${nativeEvents[0]?.agentId}`,
);
check(
  "the native telemetry row carries a real duration (executeRealtimeTool's own t0 timer, not a second clock)",
  typeof nativeEvents[0]?.ms === "number" && Number.isFinite(nativeEvents[0]?.ms) && nativeEvents[0]!.ms >= 0,
  `ms = ${String(nativeEvents[0]?.ms)}`,
);

// HALF 2 — the JOURNEY FALLTHROUGH is recorded too. `create_task` is in the journey catalog and is
// NOT in NATIVE, so it takes the `if (!NATIVE.has(name))` proxy hop — the half that crosses an app
// boundary and therefore needs telemetry MORE, not less.
const journeyEvents = await telemetryFor("create_task", { title: "Test-voice telemetry fallthrough" });
check(
  "a JOURNEY-FALLTHROUGH voice tool call is RECORDED (tool telemetry emitted)",
  journeyEvents.length === 1,
  `events for create_task = ${journeyEvents.length}`,
);
check(
  "the fallthrough telemetry row is attributed to the journey branch, not reported as native",
  journeyEvents[0]?.via === "journey",
  `via = ${journeyEvents[0]?.via}`,
);

stopObserving();

// ---------------------------------------------------------------------------------------------
// PART 4 — THE EMAIL SEND GATE (docs/cross-app-agent/FIX-email-send-gate.md, nexus-hub).
// Owner, 2026-09-07: "d4 is drafts only for now but be able to quickly set it to send by design
// once I'm comfortable enough." So: drafting always available, sending available only when
// identity.agent_workflow_config.email_send_enabled is true — and flipping that one boolean is the
// whole re-enable, no code change and no redeploy.
//
// SCOPE, stated honestly because two of the four checks below are source-shape checks, not runtime
// ones. The VOICE surface is exercised for real (buildRealtimeToolset runs, both states). The TEXT
// surface lives inside runHuddleTurn — a function that cannot be invoked offline without a model —
// so its two gates are asserted against the SOURCE: that each `send_email` definition is lexically
// inside its gate's block and each `create_email_draft` is outside it. That is weaker than a runtime
// check and is still mutation-sensitive: deleting either gate, or moving the draft inside one, fails.

// 4a. GATE CLOSED (the offline default: no AZURE_PG_URL, so isEmailSendEnabled fails closed).
check(
  "gate CLOSED: send_email is NOT offered on the voice surface",
  named("send_email").length === 0,
  `found ${named("send_email").length}`,
);
check(
  "gate CLOSED: create_email_draft IS still offered (drafting is always allowed)",
  named("create_email_draft").length === 1,
  `found ${named("create_email_draft").length}`,
);

// 4b. GATE OPEN: send_email comes back, and drafting is unaffected.
check(
  "gate OPEN: send_email IS offered on the voice surface",
  namedOn("send_email").length === 1,
  `found ${namedOn("send_email").length}`,
);
check(
  "gate OPEN: create_email_draft is still offered",
  namedOn("create_email_draft").length === 1,
  `found ${namedOn("create_email_draft").length}`,
);

// 4c. A caller that cannot be resolved must NOT open the gate. This is the fail-closed contract:
// no resolved identity means no affirmative permission, so drafts only.
const { tools: toolsUnknownCaller } = await buildRealtimeToolset("iris-chase", {
  webSearch: true,
  journey: true,
  caller: { entra_email: "nobody@example.invalid" },
});
check(
  "gate FAILS CLOSED for an unresolvable caller (no config row / no database)",
  (toolsUnknownCaller as Tool[]).filter((t) => t?.name === "send_email").length === 0,
  `found ${(toolsUnknownCaller as Tool[]).filter((t) => t?.name === "send_email").length}`,
);

// 4d. DISPATCH BACKSTOP: even if a stale toolset gets send_email through, sendGraphEmail refuses
// when the gate is closed, and the refusal names the setting to flip. Fully offline — the gate check
// returns before any Graph token or fetch.
const { sendGraphEmail } = await import("../src/features/huddle/lib/email/graph-email.server");
const refused = await sendGraphEmail({
  to: "someone@example.com",
  subject: "Test-email send gate backstop",
  body: "should never leave the tenant",
});
check(
  "dispatch backstop: sendGraphEmail REFUSES when the gate is closed",
  refused.ok === false,
  `ok = ${String(refused.ok)}`,
);
check(
  "the refusal names the setting to flip (email_send_enabled) and points at drafting",
  (refused.error ?? "").includes("email_send_enabled") &&
    (refused.error ?? "").includes("create_email_draft"),
  `error = ${(refused.error ?? "").slice(0, 120)}`,
);

// 4e. TEXT SURFACE (source-shape). Both text-path assemblies must put send_email inside a gate and
// create_email_draft outside it. Gating one surface and not the other is the exact defect that
// produced the duplicate send_email — the guard covers every surface, together.
const textSrc = await Bun.file(
  new URL("../src/features/huddle/lib/huddle.functions.ts", import.meta.url),
).text();
const textLines = textSrc.split("\n");

/** Index of the line closing the block opened on `openIdx` (brace depth; template `${}` pairs balance). */
function blockCloseIndex(lines: string[], openIdx: number): number {
  let depth = 0;
  for (let i = openIdx; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) return i;
      }
    }
  }
  return -1;
}

for (const [label, gateLine, sendMarker, draftMarker] of [
  ["OpenAI Responses path", "if (emailSendEnabled) {", 'name: "send_email",', 'name: "create_email_draft",'],
  ["Lovable path", "if (lovableEmailSendEnabled) {", "lovableTools.send_email = tool({", "lovableTools.create_email_draft = tool({"],
] as Array<[string, string, string, string]>) {
  const gateIdxs = textLines.map((l, i) => (l.trim() === gateLine ? i : -1)).filter((i) => i >= 0);
  check(
    `text/${label}: exactly one \`${gateLine}\` gate exists`,
    gateIdxs.length === 1,
    `found ${gateIdxs.length}`,
  );
  if (gateIdxs.length !== 1) continue;
  const open = gateIdxs[0];
  const close = blockCloseIndex(textLines, open);
  const sendIdxs = textLines
    .map((l, i) => (l.trim() === sendMarker.trim() ? i : -1))
    .filter((i) => i >= 0);
  const draftIdxs = textLines
    .map((l, i) => (l.trim() === draftMarker.trim() ? i : -1))
    .filter((i) => i >= 0);
  check(
    `text/${label}: EVERY send_email definition is INSIDE the gate block (lines ${open + 1}-${close + 1})`,
    sendIdxs.length > 0 && sendIdxs.every((i) => i > open && i < close),
    `send_email at lines [${sendIdxs.map((i) => i + 1).join(", ")}]`,
  );
  check(
    `text/${label}: create_email_draft is OUTSIDE the gate (drafting always allowed)`,
    draftIdxs.length > 0 && draftIdxs.every((i) => i < open || i > close),
    `create_email_draft at lines [${draftIdxs.map((i) => i + 1).join(", ")}]`,
  );
}

globalThis.fetch = realFetch;
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
