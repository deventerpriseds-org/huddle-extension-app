// WHAT:       Pins that Iris's 1:1 transcript no longer renders the "Docked in this huddle" priorities +
//             schedule pair. Owner, 2026-10-18: "The docked priority and schedule widgets are not
//             actually docked so they can be removed from the 1:1 thread stream given we already have
//             tabs at the bottom for me to get to them."
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   Run: bun scripts/no-docked-widgets.test.ts
import { readFileSync } from "node:fs";

let pass = 0,
  fail = 0;
function check(name: string, ok: boolean) {
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
}
const view = readFileSync("src/features/huddle/components/HuddleView.tsx", "utf8");
const widgets = readFileSync("src/features/huddle/components/JourneyWidgets.tsx", "utf8");
check("D1 the transcript mounts no docked widget pair", !/DockedJourneyWidgets/.test(view));
check("D2 the docked component is gone (no second copy to re-mount)", !/export function DockedJourneyWidgets/.test(widgets));
check("D3 the Priorities and Schedule tabs still render their views", /export function PrioritiesView\(/.test(widgets) && /export function ScheduleView\(/.test(widgets));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
