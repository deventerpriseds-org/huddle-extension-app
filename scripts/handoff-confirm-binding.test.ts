// WHAT:          Offline, table-driven proof of F4 (a typed confirmation binds to the ask the owner is replying to):
//                isPlainConfirmation over spelling rows S-C1..S-C17, the binding rule (decideTypedConfirmBinding),
//                which reply of the latest turn carries the ask (confirmAskTaskIdOfLatestReply), and that a
//                live-stamped ask arms no extra autowork send (planConfirmArming, AC-F4-4).
// WHY:           docs/qc-evidence/AC-handoff-confirm-flow.md (branch claude_ac-handoff-confirm) F4 + spelling table.
//                Live failure 2026-10-30: a typed "Confirmed" confirmed an older brakes task instead of the hand-off
//                ask on screen (CF-3); "👍" never matched; "great job on the last one" and "yes, but make it a
//                2-page brief" confirmed.
// SUPERSEDES:    nothing.
// SUPERSEDED-BY: nothing -- current.
// EVIDENCE:      docs/qc-evidence/BUILD-handoff-lane-b.md. Run: bun scripts/handoff-confirm-binding.test.ts
//                Imports the REAL functions (no copies). No network, no DB.
import { isPlainConfirmation, decideTypedConfirmBinding } from "../src/features/huddle/lib/huddle.functions.ts";
import { confirmAskTaskIdOfLatestReply } from "../src/features/huddle/lib/tasks/turns.server.ts";
import { planConfirmArming } from "../src/features/huddle/lib/tasks/autowork.server.ts";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${!ok && detail ? ` -- ${detail}` : ""}`);
}

// ---- Spelling table S-C rows: isPlainConfirmation verdict (context L/N is the binding rule's job, below) ----
const SC: [string, string, boolean][] = [
  ["S-C1", "confirm", true],
  ["S-C2", "Confirmed", true],
  ["S-C3", "yes", true],
  ["S-C4", "yes do it", true],
  ["S-C5", "go ahead", true],
  ["S-C6", "ok", true],
  ["S-C7", "ok great", true], // plain, but with no ask on the latest message it binds nothing (below)
  ["S-C8", "👍", true],
  ["S-C9", "no", false],
  ["S-C10", "not yet", false],
  ["S-C11", "yes?", false],
  ["S-C12", "can you change the DoD first", false],
  ["S-C13", "great job on the last one", false],
  ["S-C14", "Do it now", true],
  ["S-C15", "that's right", true],
  ["S-C16", "yes, but make it a 2-page brief", false],
  ["S-C17", "sounds good, thanks", true],
  // AC-F4-7 negation / question / long-text extras
  ["F4-7 wait", "wait", false],
  ["F4-7 don't", "don't", false],
  ["F4-7 >40 chars", "yes yes yes yes yes yes yes yes yes yes yes", false],
  // Over-match negatives in the same family as S-C13/S-C16
  ["neg filler-only", "thanks", false],
  ["neg praise", "great work today", false],
  ["neg refine", "ok but shorter", false],
  ["pos skin-tone thumb", "👍🏽", true],
  ["pos curly apostrophe", "that’s right", true],
];
for (const [id, input, expected] of SC) {
  const got = isPlainConfirmation(input);
  check(`${id} isPlainConfirmation(${JSON.stringify(input)}) === ${expected}`, got === expected, `got ${got}`);
}

// ---- Binding rule (AC-F4-1/2, rows S-C2 / S-C2n / S-C7 / S-C14 / S-C14n) ----------------------------------
type T = { taskId: string };
const Y: T = { taskId: "Y-handoff" };
const X: T = { taskId: "X-older-autowork" };
const bind = (bound: T | null, text: string, pending: T | null) =>
  decideTypedConfirmBinding<T>({ bound, plain: isPlainConfirmation(text), pending: bound || isPlainConfirmation(text) ? null : pending });

{
  // AC-F4-1 observed-failure replay: latest message carries Y's ask; X is an older outstanding ask.
  const b = bind(Y, "Confirmed", X);
  check("AC-F4-1/S-C2 'Confirmed' with Y's ask on screen confirms Y (not X)", b.confirm?.taskId === "Y-handoff", JSON.stringify(b));
}
{
  const b = bind(null, "Confirmed", X);
  check("AC-F4-2/S-C2n 'Confirmed' with NO ask on the latest message confirms nothing", b.confirm === null && b.directive === null, JSON.stringify(b));
}
{
  const b = bind(null, "ok great", X);
  check("AC-F4-2/S-C7 'ok great' after a status update confirms nothing and gets no confirm directive", b.confirm === null && b.directive === null, JSON.stringify(b));
}
{
  const b = bind(Y, "Do it now", X);
  check("AC-F4-9/S-C14 'Do it now' with an ask on screen confirms that ask", b.confirm?.taskId === "Y-handoff", JSON.stringify(b));
}
{
  const b = bind(null, "Do it now", X);
  check("S-C14n 'Do it now' with no ask on screen is NOT a deterministic confirm", b.confirm === null, JSON.stringify(b));
}
{
  const b = bind(Y, "yes, but make it a 2-page brief", X);
  check(
    "S-C16 a refinement to the bound ask confirms nothing deterministically but hands the model Y (to fold it in)",
    b.confirm === null && b.directive?.taskId === "Y-handoff",
    JSON.stringify(b),
  );
}
{
  const b = bind(null, "for the brakes one, yes go with the dealer quote", X);
  check(
    "a longer message with no ask on screen can still reach an older check-in via the MODEL directive (never deterministic)",
    b.confirm === null && b.directive?.taskId === "X-older-autowork",
    JSON.stringify(b),
  );
}

// ---- Which reply carries the ask (AC-F4-8: from durable turn data) ---------------------------------------
check(
  "latest reply's confirmAsk is returned",
  confirmAskTaskIdOfLatestReply({ replies: [{ agentId: "finn-reid", text: "Here's the plan", confirmAsk: { taskId: "Y" } }], result: null }) === "Y",
);
check(
  "a sync-completed turn (replies only in result.replies) is read too",
  confirmAskTaskIdOfLatestReply({ replies: [], result: { replies: [{ text: "plan", confirmAsk: { taskId: "Y2" } }] } }) === "Y2",
);
check(
  "an ask on an EARLIER reply followed by a plain agent message is not the latest thing on screen",
  confirmAskTaskIdOfLatestReply({
    replies: [
      { text: "plan", confirmAsk: { taskId: "Y" } },
      { text: "Also — your 3pm moved." },
    ],
    result: null,
  }) === null,
);
check("no turn = nothing to bind", confirmAskTaskIdOfLatestReply(null) === null);
check(
  "a malformed confirmAsk binds nothing",
  confirmAskTaskIdOfLatestReply({ replies: [{ text: "x", confirmAsk: { taskId: 42 } }], result: null }) === null,
);

// ---- AC-F4-4: a live-stamped ask (asked, ask_at == last_sent == now) arms NOTHING inside the 24h floor ------
{
  const now = Date.parse("2026-10-31T15:00:00Z");
  const stamp = new Date(now - 60_000).toISOString();
  const plan = planConfirmArming({
    lanes: [{ agent: "finn-reid", lane: [{ id: "Y" } as never] }],
    states: new Map([["Y", { confirm_status: "asked", confirm_ask_at: stamp, confirm_last_sent_at: stamp }]]),
    required: new Map([["finn-reid", true]]),
    now,
    reaskMinMs: 24 * 3_600_000,
  });
  check("AC-F4-4 live-stamped row + planConfirmArming within 24h arms nothing", plan.length === 0, JSON.stringify(plan));
  const later = planConfirmArming({
    lanes: [{ agent: "finn-reid", lane: [{ id: "Y" } as never] }],
    states: new Map([["Y", { confirm_status: "asked", confirm_ask_at: stamp, confirm_last_sent_at: stamp }]]),
    required: new Map([["finn-reid", true]]),
    now: now + 25 * 3_600_000,
    reaskMinMs: 24 * 3_600_000,
  });
  check("AC-F4-4 control: after the 24h floor the normal re-ask rotation resumes", later.length === 1 && later[0].kind === "reask", JSON.stringify(later));
}

console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
process.exit(failures ? 1 : 0);
