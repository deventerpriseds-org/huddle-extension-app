// WHAT:       Offline spelling table for the F6 presenter: a reply may not claim a board action (marked done,
//             moved, added, started) that the agent's own performed toolUses this turn do not back.
// WHY:        2026-10-29 Ezra said "I marked 'Order Nike Pegasus Premium' done" with no write, and "I'm proceeding
//             with the research" while the task sat in BACKLOG (AC-handoff-confirm-flow.md F6, S-B1..S-B15).
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   origin/claude_ac-handoff-confirm docs/qc-evidence/AC-handoff-confirm-flow.md; run: bun test this file.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { BOARD_CLAIM_LINES as L, presentBoardClaims, type ToolUseLike } from "../src/features/huddle/lib/tasks/board-claims.ts";

const A = "ezra-miles";
const ok = (tool: string, summary: string): ToolUseLike => ({ agentId: A, tool, summary, ok: true });
const UPDATE_OK = ok("update_task", "update_task → journey-voice · ok");
const DEFERRED = ok("update_task", "deferred — task assigned to Iris Chase");
const CREATE_OK = ok("create_huddle_task", "“Test-walk the dog” → Huddle board + journey");
const CREATE_DUP = ok("create_huddle_task", "already created this turn — skipped duplicate");
const SHOW = (text: string, uses: ToolUseLike[] = []) => presentBoardClaims([{ agentId: A, text }], uses)[0].text;

describe("F6 spelling table (S-B rows)", () => {
  const rows: [string, string, ToolUseLike[], string][] = [
    ["S-B1", "I marked 'Order Nike Pegasus Premium' done.", [], L.notChanged],
    ["S-B2", "I've moved it to review.", [], L.notChanged],
    ["S-B3", "I marked it done.", [UPDATE_OK], "I marked it done."],
    ["S-B4", "I've moved it to review.", [DEFERRED], L.deferred],
    ["S-B5", "I'll mark it done.", [], "I'll mark it done."],
    ["S-B6", "Want me to move it to review?", [], "Want me to move it to review?"],
    ["S-B7", "I can add that to your board.", [], "I can add that to your board."],
    ["S-B8", "I marked that email as read.", [], "I marked that email as read."],
    ["S-B9", "I marked the date in my notes.", [], "I marked the date in my notes."],
    ["S-B10", "I've noted that.", [], "I've noted that."],
    ["S-B11", "Done — I've added 'Test-walk the dog' to your board.", [CREATE_DUP], L.alreadyThere],
    ["S-B12", "I'm proceeding with the research.", [], L.notStarted],
    ["S-B13", 'You asked me to "mark it done", so here\'s what\'s left first.', [], 'You asked me to "mark it done", so here\'s what\'s left first.'],
    ["S-B14", "Marked as done ✅", [], L.notChanged],
    ["create ok", "I've added 'Test-walk the dog' to your board.", [CREATE_OK], "I've added 'Test-walk the dog' to your board."],
    ["create none", "I've added it to your board.", [], L.notAdded],
  ];
  for (const [id, text, uses, want] of rows) {
    test(`${id}: ${JSON.stringify(text)}`, () => expect(SHOW(text, uses)).toBe(want));
  }
  test("another agent's write never backs this agent's claim", () => {
    expect(SHOW("I marked it done.", [{ ...UPDATE_OK, agentId: "iris-chase" }])).toBe(L.notChanged);
  });
  test("only the claim sentence is replaced; the rest of the reply is kept", () => {
    expect(SHOW("Thanks for the reminder. I marked it done. Anything else?")).toBe(`Thanks for the reminder. ${L.notChanged} Anything else?`);
  });
  test("idempotent: presenting twice gives the same text", () => {
    const once = SHOW("I marked it done. I've added it to your board.");
    expect(SHOW(once)).toBe(once);
  });
});

describe("F6 wiring", () => {
  test("presentedReplies runs presentBoardClaims over the turn-level toolUses", () => {
    const hf = readFileSync(`${import.meta.dir}/../src/features/huddle/lib/huddle.functions.ts`, "utf8").replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
    expect(hf).toContain("presentBoardClaims(presentNexusWriteTurn(list, turnNexusWriteUses) as Reply[], toolUses)");
  });
});
