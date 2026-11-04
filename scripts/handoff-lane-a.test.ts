// WHAT:       Offline guards for Lane A of the 1:1 hand-off / confirm / honesty fix (F1, F2, F6 of
//             docs/qc-evidence/AC-handoff-confirm-flow.md): the urgency classifier's spelling table, the hand-off
//             suppression decision, the owner follow-up directive + confirm retry, and the board-claim presenter.
// WHY:        Seven live failures on 2026-10-30 (the AC file's WHY). The pure helpers are run for real; the
//             wiring inside the 8k-line runHuddleTurn (no offline driver) is pinned by source assertions, this
//             repo's convention for huddle.functions.ts (see scripts/raw-create-dedup.test.ts).
// SUPERSEDES: nothing. SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   docs/qc-evidence/BUILD-handoff-lane-a.md
// Run: bun test scripts/handoff-lane-a.test.ts
import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import {
  classifyAsk,
  laneHandoffSuppression,
  stripTeammateDeferral,
} from "../src/features/huddle/lib/capabilities.ts";
import {
  agentPerformedWork,
  boardFactFrom,
  detectBoardClaim,
  presentBoardClaims,
  presentBoardClaimsTurn,
  type ToolUseLike,
} from "../src/features/huddle/lib/tasks/board-claims.ts";
import {
  buildFollowupDirective,
  buildHandoffConfirmRetry,
  handoffRetryOutcome,
  needsHandoffConfirmRetry,
  proposedThisTurn,
  HANDOFF_CONFIRM_UNAVAILABLE,
} from "../src/features/huddle/lib/handoff-followup.ts";

const HF = readFileSync(`${import.meta.dir}/../src/features/huddle/lib/huddle.functions.ts`, "utf8");
const between = (a: string, b: string) => {
  const i = HF.indexOf(a);
  const j = HF.indexOf(b, i + a.length);
  if (i < 0 || j < 0) throw new Error(`anchor not found: ${i < 0 ? a : b}`);
  return HF.slice(i, j);
};

const use = (agentId: string, tool: string, summary: string, ok = true, detail?: string): ToolUseLike => ({
  agentId,
  tool,
  summary,
  ok,
  detail,
});

// ── Spelling table S-U1..S-U14 (AC file, "Urgency") ─────────────────────────────────────────────
describe("F1 urgency: classifyAsk().urgency spelling table", () => {
  const ROWS: [string, string, "now" | "default"][] = [
    ["S-U1", "Do it now", "now"],
    ["S-U2", "now please", "now"],
    ["S-U3", "asap", "now"],
    ["S-U4", "right away", "now"],
    ["S-U5", "immediately", "now"],
    ["S-U6", "i need an ai agent on the team to go and research chew treats. Do it now", "now"],
    ["S-U7", "Now, research chew treats", "now"],
    ["S-U8", "can you do it now?", "now"],
    ["S-U9", "do it today", "default"], // owner default for gap G-2: "today" is NOT a start-now trigger
    ["S-U10", "not now", "default"],
    ["S-U11", "don't do it now", "default"],
    ["S-U12", "now that you mention it, what's on my calendar", "default"],
    ["S-U13", "right now is a bad time", "default"],
    ["S-U14", "no rush, whenever", "default"],
    // extra negatives / positives around the new guards
    ["neg", "not right now", "default"],
    ["neg", "now isn't a good time", "default"],
    ["neg", "now's not a good time", "default"],
    ["pos", "don't wait, do it now", "now"],
    ["pos", "research Agentforce right now", "now"],
  ];
  for (const [id, text, want] of ROWS) {
    test(`${id}: ${JSON.stringify(text)} -> ${want}`, () => {
      expect(classifyAsk(text).urgency).toBe(want);
    });
  }
});

describe("F1 hand-off suppression (laneHandoffSuppression)", () => {
  const A = "iris-chase";
  test("AC-F1-1: a successful delegate_to_specialist by the addressed agent = handled", () => {
    const uses = [use(A, "delegate_to_specialist", "tasked Researcher: dog chew treats")];
    expect(laneHandoffSuppression({ text: "research chew treats for me", addressedId: A, toolUses: uses })).toBe("handled");
  });
  test("AC-F1-1: a saved artifact = handled", () => {
    const uses = [use(A, "create_artifact", 'saved "Brief"', true, "/artifacts/abc")];
    expect(agentPerformedWork(uses, A)).toBe(true);
  });
  test("AC-F1-1: a task create that wrote a row = handled; a suggestion / dedup skip / failure is not", () => {
    expect(agentPerformedWork([use(A, "create_huddle_task", "“X” → Huddle board + journey")], A)).toBe(true);
    expect(agentPerformedWork([use(A, "create_huddle_tasks", "created 2/2 → Huddle board + journey")], A)).toBe(true);
    expect(agentPerformedWork([use(A, "quick_create_task", "journey-voice · ok")], A)).toBe(true);
    expect(agentPerformedWork([use(A, "create_huddle_task", "suggested “X” · owner Iris Chase")], A)).toBe(false);
    expect(agentPerformedWork([use(A, "create_huddle_task", "an open task with this title already exists — skipped duplicate")], A)).toBe(false);
    expect(agentPerformedWork([use(A, "quick_create_task", "skipped duplicate — “X” (already created this turn)")], A)).toBe(false);
    expect(agentPerformedWork([use(A, "create_huddle_tasks", "created 0/1 → Huddle board + journey")], A)).toBe(false);
    expect(agentPerformedWork([use(A, "delegate_to_specialist", "delegation failed", false)], A)).toBe(false);
    expect(agentPerformedWork([use(A, "create_artifact", "save failed", false)], A)).toBe(false);
  });
  test("AC-F1-1: another agent's work does not count for the addressed agent", () => {
    expect(agentPerformedWork([use("finn-reid", "delegate_to_specialist", "tasked Researcher: x")], A)).toBe(false);
  });
  test("a web search or a read alone is not 'handled' (the AC lists delegate / artifact / task row)", () => {
    expect(agentPerformedWork([use(A, "tavily_web_search", "“x” · 5 results")], A)).toBe(false);
  });
  test("AC-F1-2: an explicit now = suppressed even with no tool use", () => {
    expect(laneHandoffSuppression({ text: "build me a budget spreadsheet. Do it now", addressedId: A, toolUses: [] })).toBe("now");
  });
  test("AC-F1-5: no work, not now -> hand-off stands", () => {
    expect(laneHandoffSuppression({ text: "build a monthly household budget spreadsheet", addressedId: A, toolUses: [] })).toBe(null);
    expect(laneHandoffSuppression({ text: "not now, but build the budget spreadsheet", addressedId: A, toolUses: [] })).toBe(null);
  });
});

describe("F1-4 stripTeammateDeferral", () => {
  const A = "iris-chase";
  test("drops each sentence deferring to a NAMED teammate, keeps the rest verbatim", () => {
    const t = "On it — I've put a researcher on chew treats. That's really Finn's area, so I'll loop in Finn. You'll get a brief shortly.";
    const out = stripTeammateDeferral(t, A);
    expect(out).toBe("On it — I've put a researcher on chew treats. You'll get a brief shortly.");
  });
  for (const phrase of [
    "Tess is better suited for this.",
    "I've passed this to Tess.",
    "Tess will reach out shortly.",
    "Let me hand it off to Tess.",
    "Tess's better suited here.",
  ]) {
    test(`removes: ${phrase}`, () => {
      expect(stripTeammateDeferral(`Done — research is underway. ${phrase}`, A)).toBe("Done — research is underway.");
    });
  }
  test("never strips the addressed agent's own name, nor a non-deferral mention", () => {
    expect(stripTeammateDeferral("Iris will follow up with the brief.", A)).toBe("Iris will follow up with the brief.");
    expect(stripTeammateDeferral("Finn mentioned the budget last week; I've started the research.", A)).toBe(
      "Finn mentioned the budget last week; I've started the research.",
    );
  });
  test("a reply that is ONLY a deferral is left intact (never emptied)", () => {
    expect(stripTeammateDeferral("Tess is better suited.", A)).toBe("Tess is better suited.");
  });
});

describe("F1 wiring in huddle.functions.ts (source assertions)", () => {
  const block = between("// 1:1 owner follow-up (AC-4)", "// The frozen anti-repetition anchor");
  test("AC-F1-7/F1-8: group and internal turns never reach the follow-up path (gate intact)", () => {
    expect(block).toContain(`if (data.scope !== "group" && !data.internal && followupTurnIntent === "perform") {`);
  });
  test("AC-F1-1/F1-2: the semantic lane hand-off is gated on laneHandoffSuppression over the agent's own toolUses", () => {
    expect(block).toContain("const laneSuppressed = laneHandoffSuppression({");
    expect(block).toContain("toolUses: r.toolUses,");
    const supp = block.indexOf("} else if (laneSuppressed) {");
    const llm = block.indexOf("followupResolution = (async () => {");
    expect(supp).toBeGreaterThan(-1);
    expect(llm).toBeGreaterThan(supp); // the LLM lane hand-off is the else branch AFTER the suppression
  });
  test("AC-F1-4: a suppressed hand-off strips teammate deferrals from the reply just pushed", () => {
    expect(block).toContain("stripTeammateDeferral(replies[last].text, nextId)");
  });
  test("AC-F1-3: a tool-gated hand-off of a now ask is delivered in 'now' mode", () => {
    expect(block).toContain(`classifyAsk(data.text).urgency === "now" ? "now" : "confirm"`);
    expect(block).toContain("deliverOwnerFollowup(ownerId, winner.name, data.text, followupMode, addressedReply)");
  });
  test("AC-F1-2: a now ask replaces the defer-to-teammate directive with a do-it-now directive", () => {
    const pre = between("let laneDirective = \"\";", "const isInterjector = interjectorSet.has(nextId);");
    expect(pre).toContain("const doItNowHere = oneToOneNowKeeps(nextId, turnIntent);");
    expect(pre.indexOf("if (doItNowHere)")).toBeLessThan(pre.indexOf("laneOwnerFor(data.text, nextId)"));
  });
  test("AC-F1-11: no second 'now' matcher in huddle.functions.ts (classifyAsk is the one)", () => {
    expect(HF).not.toMatch(/\/[^/\n]*\\b\(?right now\|/);
    expect(HF).not.toMatch(/URGENCY_RE/);
  });
});

describe("F1-3 follow-up directive (now mode)", () => {
  test("now mode starts the work and never asks to confirm first", () => {
    const d = buildFollowupDirective({ ownerName: "Terry Locke", fromName: "Iris", ask: "groom the backlog now", mode: "now" });
    expect(d).toContain("do NOT ask them to confirm first");
    expect(d).toContain("YOUR OWN");
    expect(d).toMatch(/passed|tapped/);
    expect(d).not.toContain("@");
  });
});

// ── F1 x #131 reconciliation: answer-first + the owner's follow-up must not duplicate A's work ───────
describe("F1 x #131: the owner follow-up is told what the addressed agent already said", () => {
  const said = "A Roth IRA is funded with after-tax money, so withdrawals in retirement are tax-free.";
  test("confirm mode quotes A's reply and forbids repeating it", () => {
    const d = buildFollowupDirective({ ownerName: "Finn Reid", fromName: "Iris", ask: "roth or traditional?", mode: "confirm", addressedReply: said });
    expect(d).toContain(said);
    expect(d).toContain("Do NOT repeat, re-answer or paraphrase what Iris already said");
  });
  test("now mode carries the same clause", () => {
    const d = buildFollowupDirective({ ownerName: "Terry Locke", fromName: "Iris", ask: "groom now", mode: "now", addressedReply: said });
    expect(d).toContain("Do NOT repeat, re-answer or paraphrase");
  });
  test("no addressed reply -> no clause (pre-#131 directive unchanged)", () => {
    const d = buildFollowupDirective({ ownerName: "Finn Reid", fromName: "Iris", ask: "x", mode: "confirm" });
    expect(d).not.toContain("already replied");
  });
  test("the quoted reply is bounded", () => {
    const d = buildFollowupDirective({ ownerName: "Finn Reid", fromName: "Iris", ask: "x", mode: "confirm", addressedReply: "y".repeat(5000) });
    expect(d.length).toBeLessThan(2500);
  });
  test("wiring: the follow-up block hands A's own reply to deliverOwnerFollowup", () => {
    const block = between("// 1:1 owner follow-up (AC-4)", "// The frozen anti-repetition anchor");
    expect(block).toContain("replies[replies.length - 1].agentId === nextId");
    expect(block).toContain("deliverOwnerFollowup(ownerId, winner.name, data.text, followupMode, addressedReply)");
    expect(HF).toContain("addressedReply,\n      });");
  });
  test("#131 answer-first wording is stripped when no hand-off happens (F1-4)", () => {
    const t = "A Roth is after-tax. Finn knows this area best — I'm looping them in if you want to dig deeper.";
    expect(stripTeammateDeferral(t, "iris-chase")).toBe("A Roth is after-tax.");
  });
  test("#131: looping a pronoun in with no teammate named is NOT stripped", () => {
    const t = "Done. I'm looping them in on the thread you mentioned.";
    expect(stripTeammateDeferral(t, "iris-chase")).toBe(t);
  });
});

// ── F2: a hand-off carries a real task + Confirm buttons; a skipped proposal is retried, then flagged ───
describe("F2 directive (AC-F2-1/F2-2/F2-5)", () => {
  const d = buildFollowupDirective({
    ownerName: "Finn Reid",
    ownerId: "finn-reid",
    fromName: "Tess",
    ask: "build a monthly household budget spreadsheet",
    mode: "confirm",
  });
  test("F2-5: hand-off framing kept (passed/tapped, YOUR OWN channel, no at-sign)", () => {
    expect(d).toMatch(/passed|tapped/);
    expect(d).toContain("YOUR OWN");
    expect(d).not.toContain("@");
  });
  test("F2-1: creates ONE task through create_huddle_task, assigned to the owner, reusing an existing one", () => {
    expect(d).toContain("call create_huddle_task");
    expect(d).toContain('ownerId "finn-reid"');
    expect(d).toContain("never create a second one");
  });
  test("F2-2: proposes with propose_task_intent on that task id, and asks for the Confirm tap", () => {
    expect(d).toContain("propose_task_intent with that task's task_id");
    expect(d).toContain("tap Confirm");
    // the work itself waits for the confirm (there IS a task now, so this is no longer CF-2)
    expect(d).toContain("Do not perform the work yet");
  });
  test("F2-8: a create that did not save must not be claimed", () => {
    expect(d).toContain("do not claim it was added");
  });
  test("now mode does not create/propose (the 'now' is the go-ahead)", () => {
    const n = buildFollowupDirective({ ownerName: "Terry Locke", ownerId: "terry-locke", fromName: "Iris", ask: "groom now", mode: "now" });
    expect(n).not.toContain("propose_task_intent");
  });
});

describe("F2-4 retry decision (never a silent, button-less hand-off)", () => {
  const B = "finn-reid";
  const H = { mode: "confirm" as const, fromName: "Tess", ownerId: B, ask: "budget" };
  const propose = (agentId = B, ok = true, detail = JSON.stringify({ taskId: "t1", taskTitle: "Budget", proposedDod: "a sheet" })) =>
    use(agentId, "propose_task_intent", 'Proposed DoD for "Budget"', ok, detail);
  test("proposedThisTurn mirrors the confirmAsk derivation", () => {
    expect(proposedThisTurn([propose()], B)).toBe(true);
    expect(proposedThisTurn([propose(B, false)], B)).toBe(false);
    expect(proposedThisTurn([propose("tess-sutton")], B)).toBe(false);
    expect(proposedThisTurn([propose(B, true, "not json")], B)).toBe(false);
    expect(proposedThisTurn([propose(B, true, JSON.stringify({ taskId: "t1" }))], B)).toBe(false);
    expect(proposedThisTurn([], B)).toBe(false);
  });
  test("retry when a confirm hand-off reply has no proposal", () => {
    expect(needsHandoffConfirmRetry({ handoff: H, internal: true, agentId: B, outcomeKind: "reply", toolUses: [] })).toBe(true);
    expect(needsHandoffConfirmRetry({ handoff: H, internal: true, agentId: B, outcomeKind: "hardReply", toolUses: [] })).toBe(true);
  });
  test("no retry when the proposal is there", () => {
    expect(needsHandoffConfirmRetry({ handoff: H, internal: true, agentId: B, outcomeKind: "reply", toolUses: [propose()] })).toBe(false);
  });
  test("no retry outside a confirm hand-off (ordinary turns, now mode, non-internal, another agent, a timed-out skip)", () => {
    expect(needsHandoffConfirmRetry({ handoff: undefined, internal: true, agentId: B, outcomeKind: "reply", toolUses: [] })).toBe(false);
    expect(needsHandoffConfirmRetry({ handoff: { ...H, mode: "now" }, internal: true, agentId: B, outcomeKind: "reply", toolUses: [] })).toBe(false);
    expect(needsHandoffConfirmRetry({ handoff: H, internal: false, agentId: B, outcomeKind: "reply", toolUses: [] })).toBe(false);
    expect(needsHandoffConfirmRetry({ handoff: H, internal: true, agentId: "tess-sutton", outcomeKind: "reply", toolUses: [] })).toBe(false);
    expect(needsHandoffConfirmRetry({ handoff: H, internal: true, agentId: B, outcomeKind: "skip", toolUses: [] })).toBe(false);
  });
  test("outcome: keep the first reply, flag only when the retry also missed", () => {
    expect(handoffRetryOutcome({ kind: "reply" }, { kind: "reply", proposed: true })).toEqual({ useOutcomeOf: "first", flagMissing: false });
    expect(handoffRetryOutcome({ kind: "reply" }, { kind: "reply", proposed: false })).toEqual({ useOutcomeOf: "first", flagMissing: true });
    expect(handoffRetryOutcome({ kind: "skip" }, { kind: "reply", proposed: true })).toEqual({ useOutcomeOf: "second", flagMissing: false });
  });
  test("the retry text carries the original directive and names both calls", () => {
    const t = buildHandoffConfirmRetry("ORIGINAL");
    expect(t.startsWith("ORIGINAL")).toBe(true);
    expect(t).toContain("propose_task_intent");
    expect(t).toContain("create_huddle_task");
  });
  test("the visible marker names the missing buttons", () => {
    expect(HANDOFF_CONFIRM_UNAVAILABLE).toContain("confirm buttons unavailable");
  });
});

describe("F2 wiring in huddle.functions.ts (source assertions)", () => {
  test("Input declares `handoff` (zod strips undeclared keys on the durable re-parse)", () => {
    const input = between("const Input = z.object({", "// A new-email alert turn");
    expect(input).toContain("handoff: z");
    expect(input).toContain('mode: z.enum(["now", "confirm"])');
  });
  test("the follow-up payload carries the hand-off marker and the owner id reaches the directive", () => {
    const fn = between("async function deliverOwnerFollowup(", "const { enqueueTurn }");
    expect(fn).toContain("handoff: { mode, fromName, ownerId, ask: cleanAsk }");
    expect(fn).toContain("ownerId,\n        fromName,");
  });
  test("the primary (1:1) run goes through runHandoffAware", () => {
    expect(HF).toContain("const r = await runHandoffAware(primaryId);");
  });
  test("runHandoffAware retries once, merges BOTH attempts' toolUses, and flags a still-missing proposal", () => {
    const fn = between("const runHandoffAware = async", "// Serialize the exact mid-turn position");
    expect((fn.match(/runBounded\(/g) ?? []).length).toBe(2);
    expect(fn).toContain("buildHandoffConfirmRetry(data.text)");
    expect(fn).toContain("toolUses: [...first.toolUses, ...second.toolUses]");
    expect(fn).toContain("HANDOFF_CONFIRM_UNAVAILABLE");
    expect(fn).toContain("perAgentFallbacks: [...outcome.perAgentFallbacks, HANDOFF_CONFIRM_UNAVAILABLE]");
  });
  test("create_huddle_task returns the canonical journey task id (so propose can chain) [F2]", () => {
    const fn = between("async function createSuggestedTaskFromTool", "async function createBatchTasksFromTool");
    expect(fn).toContain("task_id: (r.tasks ?? [])[0].id");
  });
});

// ── F6: never claim a board action no performed write backs ─────────────────────────────────────────
const E = "ezra-miles";
const upd = (taskId: string, title: string, status: string, agentId = E, ok = true) => ({
  ...use(agentId, "update_task", ok ? "journey-voice · ok" : "journey-voice · failed", ok),
  board: { taskId, title, status },
});
const deferredUpd = (taskId: string, status: string) => ({
  ...use(E, "update_task", `deferred — task assigned to finn-reid, not ${E}`, true),
  board: { taskId, status },
});
const NAME = (id: string) => ({ "finn-reid": "Finn Reid" } as Record<string, string>)[id];

describe("F6 spelling table S-B1..S-B15 (presentBoardClaims)", () => {
  const ROWS: Array<[string, string, ToolUseLike[], "PASS" | "WITHHOLD", string?]> = [
    ["S-B1", "I marked 'Order Nike Pegasus Premium' done", [], "WITHHOLD", "already done"],
    ["S-B2", "I've moved it to review", [], "WITHHOLD"],
    ["S-B3", "I marked it done", [upd("t1", "Order shoes", "DONE")], "PASS"],
    ["S-B4", "I've moved it to review", [deferredUpd("t9", "IN_REVIEW")], "WITHHOLD", "passed to them"],
    ["S-B5", "I'll mark it done", [], "PASS"],
    ["S-B6", "Want me to move it to review?", [], "PASS"],
    ["S-B7", "I can add that to your board", [], "PASS"],
    ["S-B8", "I marked that email as read", [], "PASS"],
    ["S-B9", "I marked the date in my notes", [], "PASS"],
    ["S-B10", "I've noted that", [], "PASS"],
    ["S-B11", "Done — I've added 'Buy milk' to your board", [use(E, "quick_create_task", "skipped duplicate — “Buy milk” (already on the board)")], "WITHHOLD", "already on your board"],
    ["S-B12", "I'm proceeding with the research", [], "WITHHOLD", "hasn't started"],
    ["S-B13", 'You asked me to "mark it done", so here\'s what\'s left first', [], "PASS"],
    ["S-B14", "Marked as done ✅", [], "WITHHOLD"],
    ["S-B15", "I marked 'Alpha plan' done", [upd("tB", "Beta plan", "DONE")], "WITHHOLD"],
  ];
  const statusOf = (t: string) => (t === "Order Nike Pegasus Premium" ? "DONE" : undefined);
  for (const [id, text, uses, want, mustContain] of ROWS) {
    test(`${id}: ${JSON.stringify(text)} -> ${want}`, () => {
      const out = presentBoardClaims(text, uses, { statusOf, nameOf: NAME });
      if (want === "PASS") expect(out).toBe(text);
      else {
        expect(out).not.toBe(text);
        if (mustContain) expect(out).toContain(mustContain);
      }
    });
  }
});

describe("F6 ACs", () => {
  test("AC-F6-1: the claim is replaced by a code-built line; the rest of the reply is kept", () => {
    const t = "Thanks for the update. I've moved 'Draft budget' to review. Anything else?";
    const out = presentBoardClaims(t, []);
    expect(out).toBe("Thanks for the update. Nothing was changed on the board for “Draft budget”. Anything else?");
  });
  test("AC-F6-2: an already-DONE task, no write -> says already done, never 'I marked'", () => {
    const out = presentBoardClaims("I marked 'Test-Order running shoes' done.", [], { statusOf: () => "DONE" });
    expect(out).toContain("already done");
    expect(out).not.toContain("I marked");
  });
  test("AC-F6-3: a matching performed write leaves the reply untouched", () => {
    const t = "I marked 'Order shoes' done.";
    expect(presentBoardClaims(t, [upd("t1", "Order shoes", "DONE")])).toBe(t);
  });
  test("AC-F6-4: a deferred status change names the assignee (ok=true is NOT performed)", () => {
    const out = presentBoardClaims("I've moved it to review.", [deferredUpd("t9", "IN_REVIEW")], { nameOf: NAME });
    expect(out).toContain("Finn Reid");
    expect(out).not.toContain("I've moved");
  });
  test("AC-F6-5: a dedup-skipped create -> 'already on your board'", () => {
    const out = presentBoardClaims("I've added it to your board.", [use(E, "create_huddle_task", "an open task with this title already exists — skipped duplicate")]);
    expect(out).toContain("already on your board");
  });
  test("AC-F6-6: a FAILED write does not back the claim; neither does no record (in flight)", () => {
    expect(presentBoardClaims("I marked it done.", [upd("t1", "X", "DONE", E, false)])).not.toContain("I marked");
    expect(presentBoardClaims("I marked it done.", [])).not.toContain("I marked");
  });
  test("F2-8 / journey off: a suggestion-only create does not back 'added to your board'", () => {
    const out = presentBoardClaims("I've added 'Budget' to your board.", [use(E, "create_huddle_task", "suggested “Budget” · owner Finn Reid")]);
    expect(out).not.toContain("I've added");
  });
  test("a REAL create backs 'added to your board' (no false refusal)", () => {
    const t = "Done — I've added 'Budget' to your board.";
    expect(presentBoardClaims(t, [use(E, "create_huddle_task", "“Budget” → Huddle board + journey · assigned to Finn Reid")])).toBe(t);
    expect(presentBoardClaims("I created a task for that.", [use(E, "create_huddle_tasks", "created 2/2 → Huddle board + journey")])).toBe(
      "I created a task for that.",
    );
  });
  test("AC-F6-9: 'started' is backed by real work this turn; internal turns are exempt", () => {
    expect(presentBoardClaims("I'm proceeding with the research.", [use(E, "delegate_to_specialist", "tasked Researcher: x")])).toBe(
      "I'm proceeding with the research.",
    );
    expect(presentBoardClaims("I've started on it.", [], { internal: true })).toBe("I've started on it.");
    expect(presentBoardClaims("I've started on it.", [])).toContain("hasn't started");
  });
  test("AC-F6-7 more offers/futures: 'I'll set it to Up Next', 'Should I archive it?', 'Let me move it to Doing'", () => {
    for (const t of ["I'll set it to Up Next.", "Should I archive it?", "Let me move it to Doing.", "I could add it to your board."]) {
      expect(presentBoardClaims(t, [])).toBe(t);
    }
  });
  test("over-match negatives: someone else's action, past facts about the user", () => {
    for (const t of ["You marked it done yesterday.", "Finn moved it to review this morning.", "It was archived last week by you."]) {
      expect(detectBoardClaim(t)).toBe(null);
    }
  });
  test("AC-F6-10: idempotent (presenting twice changes nothing more) and pure", () => {
    for (const t of ["I marked 'A' done. I've moved it to review.", "Marked as done ✅", "I've added it to your board."]) {
      const once = presentBoardClaims(t, [deferredUpd("t9", "IN_REVIEW")], { nameOf: NAME });
      expect(presentBoardClaims(once, [deferredUpd("t9", "IN_REVIEW")], { nameOf: NAME })).toBe(once);
    }
  });
  test("AC-F6-12: claims about A and B, write only on B -> A corrected, B kept", () => {
    const t = "I marked 'Alpha plan' done. I marked 'Beta plan' done.";
    const out = presentBoardClaims(t, [upd("tB", "Beta plan", "DONE")]);
    expect(out).toBe("Nothing was changed on the board for “Alpha plan”. I marked 'Beta plan' done.");
  });
  test("AC-F6-12 in one sentence: every named task must be backed on its own", () => {
    const t = "I've parked 'Gym plan' and set 'Taxes' to Up Next.";
    const out = presentBoardClaims(t, [upd("tT", "Taxes", "UP_NEXT")]);
    expect(out).toBe("Nothing was changed on the board for “Gym plan”.");
    const both = presentBoardClaims(t, [upd("tT", "Taxes", "UP_NEXT"), upd("tG", "Gym plan", "BACKLOG")]);
    expect(both).toBe(t);
  });
  test("turn view: unchanged replies keep their identity; changed ones get a new text", () => {
    const a = { agentId: E, text: "Hello." };
    const b = { agentId: E, text: "I marked it done." };
    const out = presentBoardClaimsTurn([a, b], []);
    expect(out[0]).toBe(a);
    expect(out[1].text).not.toContain("I marked");
  });
  test("boardFactFrom: id/status from args, title from journey's echo; non-board tools -> undefined", () => {
    expect(boardFactFrom("update_task", { task_id: "t1", status: "DONE" }, [{ id: "t1", title: "Shoes", status: "DONE" }])).toEqual({
      taskId: "t1",
      title: "Shoes",
      status: "DONE",
      tags: undefined,
    });
    expect(boardFactFrom("tavily_web_search", { q: "x" })).toBe(undefined);
  });
});

describe("F6 wiring (source assertions)", () => {
  test("AC-F6-10: presentedReplies composes the board presenter over the Nexus presenter (one presenter, same call sites)", () => {
    const fn = between("const presentedReplies = (", "// Lightweight handoff contract");
    expect(fn).toContain("presentBoardClaimsTurn(");
    expect(fn).toContain("presentNexusWriteTurn(list, turnNexusWriteUses)");
    expect(fn).toContain("internal: !!data.internal");
  });
  test("the 1:1 stream presents against the streaming agent's own calls too (in-flight buffers)", () => {
    expect(HF).toContain("inFlightToolUses.push(toolUses);");
    const fn = between("const presentedReplies = (", "// Lightweight handoff contract");
    expect(fn).toContain("turnToolUsesForClaims(),");
    expect(HF).toContain("for (const buf of inFlightToolUses) for (const u of buf) if (!byId.has(u.id)) byId.set(u.id, u);");
  });
  test("both journey dispatchers record the board fact (success and deferral)", () => {
    expect((HF.match(/boardFactFrom\(c\.name, /g) ?? []).length).toBe(2);
    expect((HF.match(/boardFactFrom\(def\.name, /g) ?? []).length).toBe(2);
  });
  test("no exit point bypasses presentedReplies (finalResult, chunk saves)", () => {
    expect(HF).toContain("replies: presentedReplies(),");
    expect(HF).toContain("saveTurnChunk(turnId, presentedReplies(), null, true, finalResult())");
  });
});
