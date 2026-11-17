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

// Verify loop 4 (VERIFY-handoff-confirm-flow-4.md, C7): never rewrite a TRUE statement; catch passive claims.
describe("F6 loop-4 rows", () => {
  const W = (tool: string, summary: string): ToolUseLike => ({ agentId: A, tool, summary, ok: true });
  const keep: [string, ToolUseLike[]][] = [
    ["I moved the task to Thursday.", [W("move_task_to_day", "move_task_to_day → journey-voice · ok")]],
    ["I moved that task to 3pm tomorrow.", [W("reschedule_task", "reschedule_task → journey-voice · ok")]],
    ["I set a reminder for that task at 3pm.", [W("schedule_reminder", "reminder set")]],
    ["I created a research brief for the task.", [W("create_artifact", "saved")]],
    ["I completed the research for that task — the brief is attached.", [W("create_artifact", "saved")]],
  ];
  for (const [text, uses] of keep) test(`true statement kept: ${JSON.stringify(text)}`, () => expect(SHOW(text, uses)).toBe(text));
  const fix: [string, string][] = [
    ["✅ Marked done.", L.notChanged],
    ["I've gone ahead and marked it done.", L.notChanged],
    ["I went ahead and moved it to Done.", L.notChanged],
    ["I've now added it to your board.", L.notAdded],
    ["We marked it done.", L.notChanged],
  ];
  for (const [text, want] of fix) test(`unbacked claim corrected: ${JSON.stringify(text)}`, () => expect(SHOW(text)).toBe(want));
});

// Verify loop 5 (VERIFY-handoff-confirm-flow-5-C7.md on claude_verify-handoff-confirm-flow-5-c7). Summaries are the
// ones huddle.functions.ts records: create_artifact `saved "<name>"…` (+ ensureReviewFlip moves the task to
// Review), groom_backlog "groomed the backlog", delegate_to_specialist `tasked <role>: …`.
describe("F6 loop-5 rows", () => {
  const W = (tool: string, summary: string): ToolUseLike => ({ agentId: A, tool, summary, ok: true, detail: "/artifacts/x" });
  const ART = W("create_artifact", 'saved "Comparison"');
  const GROOM = W("groom_backlog", "groomed the backlog");
  const DELEGATE = W("delegate_to_specialist", "tasked Finance: compare plans");
  // UNSAFE direction: a true statement is never rewritten.
  const keep: [string, string, ToolUseLike[]][] = [
    ["N-U1", "I've moved the task to Review with the write-up attached.", [ART]],
    ["N-U2", "The task has been moved to Review.", [ART]],
    ["N-U3", "I've completed the analysis for that task.", [ART]],
    ["N-U4", "I've put the comparison on the task card for you.", [ART]],
    ["N-U5", "I've set the priorities across your backlog.", [GROOM]],
    ["N-U6", "I moved three tasks into Up next.", [GROOM]],
    ["N-U7", "I've put Finn on that task.", [DELEGATE]],
    ["N-U8", "I set that task as your top priority.", [W("set_priority_rank", "set_priority_rank → journey-voice · ok")]],
    ["N-U9", "I added a calendar hold and moved nothing on the board.", []],
    ["N-U10", "I created 3 tasks and set them in your backlog.", [W("create_huddle_tasks", "created 3/3 → Huddle board + journey")]],
    // work statements with NO tool at all are not board claims either
    ["N-U3b", "I've completed the analysis for that task.", []],
    ["N-U4b", "I've put the comparison on the task card for you.", []],
  ];
  for (const [id, text, uses] of keep) test(`${id} kept: ${JSON.stringify(text)}`, () => expect(SHOW(text, uses)).toBe(text));
  // Under-matches: an unbacked claim is corrected.
  const fix: [string, string, string][] = [
    ["N-M1", "I've marked it done, let me know if you need anything else.", L.notChanged],
    ["N-M2", "I moved it to Done so it's off your plate if you were worried.", L.notChanged],
    ["N-M3", "I've updated the task to Done.", L.notChanged],
    ["N-M5", "I marked the task done and set a reminder for Friday.", L.notChanged],
    ["N-M6", "I've checked that task off.", L.notChanged],
    ["N-M7", "That one's handled — marked it complete.", L.notChanged],
    ["N-M8", "I've scheduled the task for 3pm tomorrow.", L.notChanged],
  ];
  for (const [id, text, want] of fix) test(`${id} corrected: ${JSON.stringify(text)}`, () => expect(SHOW(text)).toBe(want));
});

// Verify loop 7 (VERIFY-handoff-confirm-flow-7-C7.md on claude_verify-handoff-confirm-flow-7-c7): the matcher is an
// ALLOWLIST of first-person claims about the task itself. Passive statements describe STATE (maybe already true, maybe
// a teammate's doing) and are never rewritten -- accepted safe-direction misses, formerly loop-4/5 "corrected" rows.
describe("F6 loop-7 rows", () => {
  const W = (tool: string, summary: string, agentId = A): ToolUseLike => ({ agentId, tool, summary, ok: true });
  const REMINDER = W("schedule_reminder", "reminder scheduled");
  const CAL = W("create_calendar_event", "create_calendar_event → journey-voice · ok");
  const DRAFT = W("create_email_draft", "draft saved in Outlook");
  const SEARCH = W("tavily_web_search", "searched");
  const keep: [string, string, ToolUseLike[]][] = [
    ["U7-1", "I set a reminder for the review at 3pm.", [REMINDER]],
    ["U7-2", "I've set a reminder for when you're done.", [REMINDER]],
    ["U7-3", "I've set aside an hour for the review.", [CAL]],
    ["U7-4", "I've marked 2-4pm as blocked on your calendar.", [CAL]],
    ["U7-5", "I've put it in drafts for your review.", [DRAFT]],
    ["U7-6", "I've started a draft for you.", [DRAFT]],
    ["U7-7", "I've started the email to Sam — it's in your drafts.", [DRAFT]],
    ["U7-9", "It's been moved to Done by Finn.", [W("update_task", "update_task → journey-voice · ok", "finn-reid")]],
    ["U7-10", "That task is marked done already — since Sept 1.", []],
    ["U7-15", "I updated the doc to complete the analysis.", []],
    ["U7-16", "I'm working on it — here's what I found so far.", [SEARCH]],
    ["passive-1", "All set — it's marked as complete.", []],
    ["passive-2", "Task moved to Done.", []],
    ["passive-3", "It's been added to your board.", []],
    ["passive-4", "Your task is now marked done.", []],
  ];
  for (const [id, text, uses] of keep) test(`${id} kept: ${JSON.stringify(text)}`, () => expect(SHOW(text, uses)).toBe(text));
  const fix: [string, string, string][] = [
    ["M7-1", "I wrapped it up and marked it done.", L.notChanged],
    ["M7-2", "Just marked it done!", L.notChanged],
    ["M7-3", "Got it, marked it done.", L.notChanged],
    ["M7-4", "Happy to help, I've marked it done.", L.notChanged],
    ["M7-6", "Once you confirmed, I marked it done.", L.notChanged],
    ["M7-8", "I've archived both.", L.notChanged],
    ["M7-10", "Sure thing, moved it to Review.", L.notChanged],
  ];
  for (const [id, text, want] of fix) test(`${id} corrected: ${JSON.stringify(text)}`, () => expect(SHOW(text)).toBe(want));
  test("a create whose TITLE contains a not-performed word still counts as performed (7-rest C1)", () => {
    const real = W("create_huddle_task", "“Test-set Huddle-only mode” → Huddle board + journey");
    expect(SHOW("I've added 'Test-set Huddle-only mode' to your board.", [real])).toBe("I've added 'Test-set Huddle-only mode' to your board.");
  });
});

// Verify loop 8 (VERIFY-handoff-confirm-flow-8-C7.md on claude_verify-handoff-confirm-flow-8-c7): a Huddle tool's own free
// text (a block reason, an artifact name) must never make a real change read as "not performed".
describe("F6 loop-8 rows", () => {
  const W = (tool: string, summary: string): ToolUseLike => ({ agentId: A, tool, summary, ok: true, detail: "/artifacts/x" });
  const BLOCK = W("flag_blocker", "blocked: waiting on the vendor's quote");
  const keep: [string, string, ToolUseLike[]][] = [
    ["U8-1", "I've marked it blocked.", [BLOCK]],
    ["U8-2", "I moved the task to Blocked until the quote arrives.", [BLOCK]],
    ["U8-3", "I flagged it and set it to blocked.", [BLOCK]],
    ["U8-4", "I saved the post-mortem and moved the task to review.", [W("create_artifact", 'saved "Why the Q3 launch failed"')]],
    ["U8-5", "I saved the notes and moved it to Review.", [W("create_artifact", 'saved "Huddle-only vs journey sync notes"')]],
  ];
  for (const [id, text, uses] of keep) test(`${id} kept: ${JSON.stringify(text)}`, () => expect(SHOW(text, uses)).toBe(text));
  test("a skipped-duplicate or failed-journey confirm does not back a claim", () => {
    expect(SHOW("I marked it done.", [W("confirm_task_intent", "DoD confirmed, journey write failed: 500")])).toBe(L.notChanged);
    expect(SHOW("I marked it done.", [W("create_artifact", "already saved this turn — skipped duplicate")])).toBe(L.notChanged);
  });
  test("a title with its own quotes still reads as a real create (8-rest)", () => {
    const real = W("create_huddle_task", "“Test-say \"hi\" in Huddle-only mode” → Huddle board + journey");
    expect(SHOW("I've added it to your board.", [real])).toBe("I've added it to your board.");
  });
});
