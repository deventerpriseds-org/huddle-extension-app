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
import { agentPerformedWork, type ToolUseLike } from "../src/features/huddle/lib/tasks/board-claims.ts";
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
  test("create_huddle_task returns the canonical journey task id (so propose can chain)", () => {
    const fn = between("async function createSuggestedTaskFromTool", "async function createBatchTasksFromTool");
    expect(fn).toContain("task_id: (r.tasks ?? [])[0].id");
  });
});
