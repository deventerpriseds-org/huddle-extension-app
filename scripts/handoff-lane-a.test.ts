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
import { buildFollowupDirective } from "../src/features/huddle/lib/handoff-followup.ts";

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
    expect(block).toContain("deliverOwnerFollowup(ownerId, winner.name, data.text, followupMode)");
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
