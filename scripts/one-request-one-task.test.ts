// WHAT:       Offline checks for row 7 "one request makes one task": a new title that is journey's SHORTENED form
//             of an open task (the extra words live in that task's description) is a duplicate, on every create
//             path — and a more specific, DIFFERENT task that merely starts with an open title is not.
// WHY:        2026-10-30 two identical asks two minutes apart made duplicate "Obtain official transcript" rows:
//             Iris created "Obtain official transcript and send it directly to UM-Flint ..." and journey kept
//             the short title, so the next exact-match check missed it (azure-pg-query run 43976983455).
//             Verify loop 4 C8 then refuted the first fix (any 3+-word prefix): it blocked distinct asks.
// SUPERSEDES: the 12e49afa version of this file (prefix-only rows).  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   run: bun test scripts/one-request-one-task.test.ts; live row read 2026-11-17 via Supabase MCP
//             (title "Obtain official transcript", description quoted below).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  matchOpenTitle,
  matchesOpenTitle,
  normalizeTaskTitle as n,
} from "../src/features/huddle/lib/tasks/create-task-core.ts";

// Open board: title → description, as journey stores them.
const board: [string, string][] = [
  // The real 2026-10-30 row, verbatim.
  ["Obtain official transcript", "Request the official transcript and ensure it is sent directly to UM-Flint to remove the registration hold."],
  ["Call mom", ""],
  ["Research Slack AI agents", "Compare Slack's AI agent features and pricing tiers."],
  // Loop 4's refuting open titles, each with a plausible description that does NOT carry the new detail.
  ["Draft blog post", "Write the next post for the company blog."],
  ["Buy birthday gift", "Pick something for Mom's birthday."],
  ["Research AI tools", "Look at AI tools that could save time."],
  ["Book flight to Denver", "Find a cheap flight."],
  ["Pay the bill", "Electric bill due."],
  ["Email John Smith", "Follow up with John."],
  ["Schedule a meeting", "Find time with the team."],
  ["Write a review", "Performance review."],
];
const titles = new Set(board.map(([t]) => n(t)));
const descriptions = new Map(board.filter(([, d]) => d).map(([t, d]) => [n(t), d]));

describe("row 7: same request (journey's shortened form) IS a duplicate", () => {
  const rows = [
    "Obtain official transcript",
    "obtain official transcript.",
    "Obtain official transcript and send it directly to UM-Flint to remove the registration hold",
    "Obtain official transcript and send it directly to UM-Flint",
    "Research Slack AI agents pricing",
  ];
  for (const title of rows)
    test(`${JSON.stringify(title)} -> duplicate`, () => expect(matchesOpenTitle(n(title), titles, descriptions)).toBe(true));
});

describe("row 7: a different, more specific task is NOT a duplicate (verify loop 4 C8)", () => {
  const rows = [
    "Draft blog post on onboarding",
    "Buy birthday gift for Sarah",
    "Research AI tools for legal contract review",
    "Book flight to Denver for the June wedding",
    "Pay the bill for the dentist",
    "Email John Smith the signed lease",
    "Schedule a meeting with the landlord",
    "Write a review of Q3 sales numbers",
    "Obtain official transcripts for both schools", // "transcripts" is a different word: no prefix
    "Call mom about Sunday dinner", // open task has no description
    "Research Slack", // a SHORTER title is not covered by a longer open one
    "Order more fat burners",
  ];
  for (const title of rows)
    test(`${JSON.stringify(title)} -> new task`, () => expect(matchesOpenTitle(n(title), titles, descriptions)).toBe(false));
});

// Verify loop 7 C8 (VERIFY-handoff-confirm-flow-7-C8.md on claude_verify-handoff-confirm-flow-7-c8): at a 60% threshold,
// shared generic words outvoted the one word that made a request different. Every one of these is a DIFFERENT task.
describe("row 7: one distinct word is never outvoted (verify loop 7 C8)", () => {
  const rows: [string, string, string][] = [
    ["Buy birthday gift", "Buy a birthday gift for Mom and have it delivered before Saturday", "Buy birthday gift for Sarah and have it delivered before Saturday"],
    ["Schedule a meeting", "Schedule a meeting with the team to review the project timeline", "Schedule a meeting with the team to review the budget"],
    ["Pay the electric bill", "Pay the electric bill before the due date to avoid a late fee", "Pay the electric bill for the rental property before the due date"],
    ["Call the doctor", "Call the doctor to schedule an appointment about the persistent cough", "Call the doctor to schedule an appointment for Sarah"],
    ["Pick up prescription", "Pick up the prescription from the pharmacy", "Pick up prescription for the presentation"],
    ["Follow up", "Follow up with the team to schedule the quarterly review and confirm the agenda", "Follow up with the landlord to schedule the review"],
    ["Email John", "Email John about the lease agreement", "Email John about the lease for Mike"],
  ];
  for (const [open, desc, next] of rows)
    test(`${JSON.stringify(next)} -> new task`, () =>
      expect(matchesOpenTitle(n(next), new Set([n(open)]), new Map([[n(open), desc]]))).toBe(false));
  test("same task, every extra word in the description -> duplicate", () =>
    expect(
      matchesOpenTitle(
        n("Email John Smith the deposit receipt"),
        new Set([n("Email John Smith")]),
        new Map([[n("Email John Smith"), "Send John the signed lease and the deposit receipt"]]),
      ),
    ).toBe(true));
});

// Verify loop 8 C8 (VERIFY-handoff-confirm-flow-8-C8.md on claude_verify-handoff-confirm-flow-8-c8): a short extra word
// matched any description word that STARTS with it. Every one of these is a different task.
describe("row 7: a short word only matches itself plus a plain ending (verify loop 8 C8)", () => {
  const rows: [string, string, string][] = [
    ["Pay insurance", "Pay the insurance premium online with the credit card.", "Pay insurance for the car"],
    ["Pay the bill", "Pay the credit card bill before the due date.", "Pay the bill for the car"],
    ["Renew registration", "Renew the registration for the career fair.", "Renew registration for the car"],
    ["Pay invoice", "Pay the invoice for the business lunch.", "Pay invoice for the bus"],
    ["Cancel subscription", "Cancel the subscription before the next appointment renewal.", "Cancel subscription for the app"],
    ["Buy first aid", "Buy first aid supplies for the kitchen.", "Buy first aid kit"],
    ["Pay for", "Pay for the gasket replacement.", "Pay for gas"],
  ];
  for (const [open, desc, next] of rows)
    test(`${JSON.stringify(next)} -> new task`, () =>
      expect(matchesOpenTitle(n(next), new Set([n(open)]), new Map([[n(open), desc]]))).toBe(false));
  test("a plain ending still matches: 'holds' in the description covers 'hold'", () =>
    expect(
      matchesOpenTitle(
        n("Obtain official transcript to remove the registration hold"),
        new Set([n("Obtain official transcript")]),
        new Map([[n("Obtain official transcript"), "Request the transcript so the registration holds are removed"]]),
      ),
    ).toBe(true));
});

describe("row 7: a description that draws a contrast never proves a duplicate (verify loop 8 C8)", () => {
  const rows: [string, string, string][] = [
    ["Call dentist", "Call the dentist about the crown, not the cleaning.", "Call dentist about the cleaning"],
    ["Book appointment", "Book the appointment for Sarah; Mom will book her own later.", "Book appointment for Mom"],
  ];
  for (const [open, desc, next] of rows)
    test(`${JSON.stringify(next)} -> new task`, () =>
      expect(matchesOpenTitle(n(next), new Set([n(open)]), new Map([[n(open), desc]]))).toBe(false));
});

describe("row 7: without descriptions only an exact title matches", () => {
  test("prefix + no description map -> new task", () =>
    expect(matchesOpenTitle(n("Obtain official transcript and send it directly to UM-Flint"), titles)).toBe(false));
  test("exact + no description map -> duplicate", () =>
    expect(matchesOpenTitle(n("Obtain official transcript"), titles)).toBe(true));
  test("matchOpenTitle names the open title it matched", () =>
    expect(matchOpenTitle(n("Obtain official transcript and send it directly to UM-Flint"), titles, descriptions)).toBe(
      n("Obtain official transcript"),
    ));
});

describe("row 7 wiring: every create path passes the descriptions", () => {
  const strip = (p: string) =>
    readFileSync(`${import.meta.dir}/../src/features/huddle/lib/${p}`, "utf8").replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
  test("create_huddle_task, create_huddle_tasks, raw journey creates and voice", () => {
    const hf = strip("huddle.functions.ts");
    expect(hf).toContain("matchOpenTitle(titleKey, existing, existingOpenTitles?.descriptions)");
    expect(hf).toContain("matchesOpenTitle(key, existing, existingOpenTitles?.descriptions)");
    expect(strip("tasks/create-task-core.ts")).toContain("if (matchesOpenTitle(key, load.titles, load.descriptions)) {");
    expect(strip("voice/realtime-tools.server.ts")).toContain("if (matchesOpenTitle(key, seen, load.descriptions)) {");
  });
  test("the dedup read selects the description; the skip returns the matched task id", () => {
    expect(strip("tasks/tasks.server.ts")).toContain('${opts?.includeBlocked ? ",description" : ""}');
    expect(strip("huddle.functions.ts")).toContain("existingOpenTitles?.ids?.get(matchedOpen)");
  });
});
