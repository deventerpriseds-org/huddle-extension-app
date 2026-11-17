// WHAT:       Offline checks for row 7 "one request makes one task": a new title that merely EXTENDS an open
//             board title (3+ words) is a duplicate, on every create path.
// WHY:        2026-10-30 two identical asks two minutes apart made duplicate "Obtain official transcript" rows:
//             Iris created "Obtain official transcript and send it directly to UM-Flint ..." and journey kept
//             the short title, so the next exact-match check missed it (azure-pg-query run 43976983455).
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   run: bun test scripts/one-request-one-task.test.ts
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { matchesOpenTitle, normalizeTaskTitle as n } from "../src/features/huddle/lib/tasks/create-task-core.ts";

const open = new Set([n("Obtain official transcript"), n("Call mom"), n("Research Slack AI agents")]);
describe("row 7: matchesOpenTitle", () => {
  const rows: [string, boolean][] = [
    ["Obtain official transcript", true],
    ["Obtain official transcript and send it directly to UM-Flint to remove the registration hold", true],
    ["obtain official transcript.", true],
    ["Obtain official transcripts for both schools", false], // "transcripts" is a different word
    ["Call mom about Sunday dinner", false], // 2-word open titles never swallow a longer one
    ["Research Slack AI agents pricing", true],
    ["Research Slack", false], // a SHORTER title is not covered by a longer open one
    ["Order more fat burners", false],
  ];
  for (const [title, want] of rows) test(`${JSON.stringify(title)} -> ${want}`, () => expect(matchesOpenTitle(n(title), open)).toBe(want));
});
describe("row 7 wiring: every create path uses it", () => {
  const strip = (p: string) =>
    readFileSync(`${import.meta.dir}/../src/features/huddle/lib/${p}`, "utf8").replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
  test("create_huddle_task, create_huddle_tasks and raw journey creates", () => {
    const hf = strip("huddle.functions.ts");
    expect(hf).toContain("if (matchesOpenTitle(titleKey, existing)) {");
    expect(hf).toContain("if (createdTaskTitles.has(key) || matchesOpenTitle(key, existing)) {");
    expect(strip("tasks/create-task-core.ts")).toContain("if (matchesOpenTitle(key, load.titles)) {");
    expect(strip("voice/realtime-tools.server.ts")).toContain("if (matchesOpenTitle(key, seen)) {");
  });
});
