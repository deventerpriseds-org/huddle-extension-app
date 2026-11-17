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
  HANDOFF_TASK_AND_BUTTONS,
  proposedThisTurn,
  HANDOFF_CONFIRM_UNAVAILABLE,
} from "../src/features/huddle/lib/handoff-followup.ts";

const HF = readFileSync(`${import.meta.dir}/../src/features/huddle/lib/huddle.functions.ts`, "utf8");
const between = (a: string, b: string) => {
  const i = HF.indexOf(a);
  const j = HF.indexOf(b, i + a.length);
  if (i < 0 || j < 0) throw new Error(`anchor not found: ${i < 0 ? a : b}`);
  // Assert against CODE only: a commented-out copy of a wired line must not satisfy a wiring check
  // (verify loop 3, M8/M12 INERT). Anchors may be comments, so strip after slicing. Keeps "https://".
  return HF.slice(i, j)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
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
    // verify loop 1 C2 (VERIFY-handoff-confirm-flow-1.md): a negated non-"now" urgency word is NOT urgent
    ["v1-C2", "don't do it right away", "default"],
    ["v1-C2", "don't do it immediately", "default"],
    ["v1-C2", "not immediately", "default"],
    ["v1-C2", "not asap", "default"],
    ["v1-C2", "no rush, asap is fine whenever", "default"],
    // verify loop 2 C2 (VERIFY-handoff-confirm-flow-2.md): any "n't" / spelled-out negator is NOT urgent
    ["v2-C2", "it doesn't need to be done right away", "default"],
    ["v2-C2", "no need for it right now", "default"],
    ["v2-C2", "I wouldn't start it right away", "default"],
    ["v2-C2", "you shouldn't do it immediately", "default"],
    ["v2-C2", "this isn't urgent, it doesn't have to happen immediately", "default"],
    ["v2-C2", "there's no hurry to do it right now", "default"],
    ["v2-C2", "can't do it now", "default"],
    ["v2-C2", "I won't need it right away", "default"],
    ["v2-C2", "later is fine, rather than right now", "default"],
    ["pos", "never mind, do it right away", "now"],
    ["pos", "don't forget, do it now", "now"],
    // verify loop 3 C2 (VERIFY-handoff-confirm-flow-3.md): deferral idioms are NOT urgent (U-rows) ...
    ["v3-C2", "just leave it for now", "default"],
    ["v3-C2", "keep it on the backlog for now", "default"],
    ["v3-C2", "park it for now", "default"],
    ["v3-C2", "skip the research for now", "default"],
    ["v3-C2", "hold off on it right now", "default"],
    ["v3-C2", "I'm busy right now, do it later", "default"],
    ["v3-C2", "I'm in a meeting right now, remind me later about the deck", "default"],
    ["v3-C2", "wait until tomorrow instead of right away", "default"],
    ["v3-C2", "instead of right away, do it Friday", "default"],
    ["v3-C2", "maybe next week instead of now", "default"],
    ["v3-C2", "now doesn't work for me", "default"],
    ["v3-C2", "now won't work, maybe Friday", "default"],
    ["v3-C2", "Not. Now.", "default"],
    ["v3-C2", "nothing right now, thanks", "default"],
    // ... and words merely ENDING in "nt" are not negators (W-rows, regression from f3d94a5f)
    ["v3-W", "I want it now", "now"],
    ["v3-W", "I want it done right away", "now"],
    ["v3-W", "this is urgent so do it now", "now"],
    ["v3-W", "it's important to do it right away", "now"],
    // not an instruction to the agent -> one confirm step (accepted safe-direction miss, verify loop 7 allowlist)
    ["v3-W", "the client needs it right now", "default"],
    ["v3-W", "I want this researched asap", "now"],
    ["v3-O", "why don't you do it right now", "now"],
    ["v3-O", "can't you just do it now?", "now"],
    ["v3-O", "I don't care just do it now", "now"],
    ["v3-O", "don't wait, do it right away", "now"],
    // verify loop 4 C2 (VERIFY-handoff-confirm-flow-4.md): UNSAFE -- an urgent idiom must never hide a deferral,
    // and "right now" describing the owner's state alongside any time/busy word is not a go-ahead.
    ["v4-U", "Why don't you do it tomorrow instead of right now?", "default"],
    ["v4-U", "I don't care, just not right now", "default"],
    ["v4-U", "Can't you wait? Not right now.", "default"],
    ["v4-U", "Won't you hold off for now.", "default"],
    ["v4-U", "Do it on Friday, right now I'm slammed", "default"],
    ["v4-U", "Right now I'm swamped, get to it Monday", "default"],
    ["v4-U", "Get to it next month; right now there's too much going on", "default"],
    ["v4-U", "Do it after lunch, I'm on a call right now", "default"],
    ["v4-U", "don't worry about it now", "default"],
    // ... OVER-MATCH, by design (the safe direction: one confirm step): a time word next to an urgent ask.
    ["v4-O", "Do it right now so it's ready for tomorrow's meeting", "default"],
    ["v4-O", "I need it now, I'm busy later", "default"],
    ["v4-O", "ASAP please, I'm in a meeting at 3", "default"],
    ["v4-O", "Do it right now before my flight tonight", "default"],
    ["v4-O", "Start it immediately, I don't want to wait until Friday", "default"],
    // verify loop 7 C2 (VERIFY-handoff-confirm-flow-7-C2.md): UNSAFE inputs that read "now" before the allowlist
    ["v7-U", "Book the flight but don‘t do it right now", "default"],
    ["v7-U", "donʼt do it right now", "default"],
    ["v7-U", "don`t do it right now", "default"],
    ["v7-U", "don＇t do it right now", "default"],
    ["v7-U", "dnt do it right now", "default"],
    ["v7-U", "Write the brief; dnt start it right now", "default"],
    ["v7-U", "nto right now", "default"],
    ["v7-U", "Can't you see I'm driving right now?", "default"],
    ["v7-U", "I don't care right now", "default"],
    ["v7-U", "Research vendors, I don't care if it gets done right now", "default"],
    ["v7-U", "Never mind, I'll do it myself right now", "default"],
    ["v7-U", "Don't wait for me, I'm handling it myself right now", "default"],
    ["v7-U", "I'll do it myself right now", "default"],
    ["v7-U", "Let me think, I'll get back to you right away", "default"],
    ["v7-U", "Hang on, I'm checking something right now", "default"],
    ["v7-U", "Nah, right now I'm good", "default"],
    ["v7-U", "Nope. Right now I'm good.", "default"],
    ["v7-U", "Right now I'm tied up", "default"],
    ["v7-U", "Right now I'm driving", "default"],
    ["v7-U", "Do it tmrw, right now I'm drained", "default"],
    ["v7-U", "Do it tomorow, right now I'm drained", "default"],
    ["v7-U", "Do it afterwards, right now I'm busy with something", "default"],
    ["v7-U", "Give me a sec", "default"],
    ["v7-U", "Now is a terrible time", "default"],
    ["v7-U", "Asap is overkill", "default"],
    ["v7-U", "It's low priority, asap would be overkill", "default"],
    // ... and plain urgent instructions that now read "now" (were over-matches)
    ["v7-P", "Please handle this now, thanks", "now"],
    ["v7-P", "Start now?", "now"],
    ["v7-U", "Do I need it right now? Nah.", "default"],
    ["v7-P", "Do it now 🙏", "now"],
    ["pos", "do it right away", "now"],
    ["pos", "don't wait, do it immediately", "now"],
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
    expect(laneHandoffSuppression({ text: "build me a budget spreadsheet. Do it now", addressedId: A, toolUses: [], enabled: true })).toBe("now");
  });
  test("AC-F1-5: no work, not now -> hand-off stands", () => {
    expect(laneHandoffSuppression({ text: "build a monthly household budget spreadsheet", addressedId: A, toolUses: [], enabled: true })).toBe(null);
    expect(laneHandoffSuppression({ text: "not now, but build the budget spreadsheet", addressedId: A, toolUses: [], enabled: true })).toBe(null);
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
    // verify loop 3 C1 D-5..D-13
    "Let me bring Finn in on the numbers.",
    "I've asked Finn to take a look.",
    "I'll get Finn on it.",
    "Finn can take it from here.",
    "Finn will handle the spreadsheet.",
    "I'll have Finn look into it.",
    "I'll ping Finn about it.",
    "I'm putting this in Finn's hands.",
    "I'm sending this over to Finn.",
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
    // over-match negatives for the loop-3 patterns: a teammate named without a deferral stays
    for (const keep of [
      "Finn's numbers from last week look right; I've updated the sheet.",
      "I sent the draft to you, and Finn's notes are attached.",
      "You asked about Finn's budget, so here it is.",
    ]) {
      expect(stripTeammateDeferral(keep, A)).toBe(keep);
    }
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
    taskAndButtons: true,
  });
  test("row 2 ON (owner 2026-11-17 'keep 2'): the default is the task + buttons directive, and a skipped propose retries", () => {
    expect(HANDOFF_TASK_AND_BUTTONS).toBe(true);
    const base = { ownerName: "Finn Reid", ownerId: "finn-reid", fromName: "Tess", ask: "budget", mode: "confirm" as const };
    expect(buildFollowupDirective(base)).toBe(buildFollowupDirective({ ...base, taskAndButtons: true }));
    expect(buildFollowupDirective(base)).toContain("create_huddle_task");
    expect(needsHandoffConfirmRetry({ handoff: { mode: "confirm", fromName: "Tess", ownerId: "finn-reid", ask: "budget" }, internal: true, agentId: "finn-reid", outcomeKind: "reply", toolUses: [] })).toBe(true);
  });
  test("row 2 OFF side still works (the one-line rollback): live wording, no retry", () => {
    const live = buildFollowupDirective({ ownerName: "Finn Reid", ownerId: "finn-reid", fromName: "Tess", ask: "budget", mode: "confirm", taskAndButtons: false });
    expect(live).toContain("ask them to confirm before you act");
    expect(live).not.toContain("create_huddle_task");
    expect(needsHandoffConfirmRetry({ handoff: { mode: "confirm", fromName: "Tess", ownerId: "finn-reid", ask: "budget" }, internal: true, agentId: "finn-reid", outcomeKind: "reply", toolUses: [], enabled: false })).toBe(false);
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
    expect(needsHandoffConfirmRetry({ handoff: H, internal: true, agentId: B, outcomeKind: "reply", toolUses: [], enabled: true })).toBe(true);
    expect(needsHandoffConfirmRetry({ handoff: H, internal: true, agentId: B, outcomeKind: "hardReply", toolUses: [], enabled: true })).toBe(true);
  });
  test("no retry when the proposal is there", () => {
    expect(needsHandoffConfirmRetry({ handoff: H, internal: true, agentId: B, outcomeKind: "reply", toolUses: [propose()], enabled: true })).toBe(false);
  });
  test("no retry outside a confirm hand-off (ordinary turns, now mode, non-internal, another agent, a timed-out skip)", () => {
    expect(needsHandoffConfirmRetry({ handoff: undefined, internal: true, agentId: B, outcomeKind: "reply", toolUses: [], enabled: true })).toBe(false);
    expect(needsHandoffConfirmRetry({ handoff: { ...H, mode: "now" }, internal: true, agentId: B, outcomeKind: "reply", toolUses: [], enabled: true })).toBe(false);
    expect(needsHandoffConfirmRetry({ handoff: H, internal: false, agentId: B, outcomeKind: "reply", toolUses: [], enabled: true })).toBe(false);
    expect(needsHandoffConfirmRetry({ handoff: H, internal: true, agentId: "tess-sutton", outcomeKind: "reply", toolUses: [], enabled: true })).toBe(false);
    expect(needsHandoffConfirmRetry({ handoff: H, internal: true, agentId: B, outcomeKind: "skip", toolUses: [], enabled: true })).toBe(false);
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
  test("a same-turn duplicate create returns the first create's task id (hand-off retry can still propose)", () => {
    const fn = between("async function createSuggestedTaskFromTool", "async function createBatchTasksFromTool");
    expect(fn).toContain("if ((r.tasks ?? [])[0]?.id) createdTaskIdByTitle.set(titleKey, (r.tasks ?? [])[0].id);");
    expect(fn).toContain("const sameTurnId = createdTaskIdByTitle.get(titleKey);");
    expect(fn).toContain("...(sameTurnId ? { task_id: sameTurnId } : {}),");
  });
});
