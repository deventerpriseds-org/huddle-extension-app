// WHAT:       Proves the Schedule tab's This Week star is a working "Remove from This Week" button on
//             starred rows of the LIVE tab only, wired to the same unstar write the Priorities tab uses,
//             and that the tab re-reads itself afterwards.
// WHY:        Owner 2026-11-18: "I attempted to click to uncheck a star in the schedules priority rows".
//             The star was a decorative <Star aria-hidden>, and Schedule rows had no ⋮ menu, so there was
//             no way at all to unstar from the Schedule tab. journey logs showed zero set_priority_rank
//             calls in the 48h before the report.
// SUPERSEDES: nothing
// SUPERSEDED-BY: nothing -- current
// EVIDENCE:   .claude/actions.md ACT:schedule-unstar-star
//
// Run:  bun scripts/schedule-unstar.test.ts   (npm run test:schedule-unstar)
// Offline source checks: the component is a React tree with server-fn imports, so the wiring is read
// from JourneyWidgets.tsx itself rather than rendered.
import { readFileSync } from "node:fs";

let pass = 0,
  fail = 0;
function check(label: string, cond: boolean) {
  console.log(`  ${cond ? "PASS" : "FAIL"} ${label}`);
  cond ? pass++ : fail++;
}

const src = readFileSync("src/features/huddle/components/JourneyWidgets.tsx", "utf8");
const fn = (name: string) => {
  const i = src.indexOf(`function ${name}(`);
  const j = src.indexOf("\nfunction ", i + 10);
  const k = src.indexOf("\nexport function ", i + 10);
  const end = [j, k].filter((n) => n > 0).reduce((a, b) => Math.min(a, b), src.length);
  return i < 0 ? "" : src.slice(i, end);
};

const upNext = fn("UpNextRowItem");
const unstar = fn("UnstarButton");
const sched = src.slice(src.indexOf("export function ScheduleWidget("), src.indexOf("function useScheduleData("));
const live = fn("LiveScheduleWidget");
const hook = fn("useScheduleData");

check("S1 a starred row on the live tab gets the button", /pushCtx && row\.isPriority \?\s*\(\s*<UnstarButton row=\{row\} ctx=\{pushCtx\} \/>/.test(upNext));
check("S2 every other row keeps the plain star", /:\s*\(\s*<Star size=\{11\}[^>]*aria-hidden \/>/.test(upNext));
check("S3 the button runs the SAME unstar write as the Priorities ⋮ menu", /runPush\(ctx, "unstar", \{ taskId: row\.id \}\)/.test(unstar));
check("S4 the button is labelled for what it does", /aria-label=\{`Remove "\$\{row\.title\}" from This Week`\}/.test(unstar));
check("S5 a busy button cannot be tapped twice", /disabled=\{busy \|\| !ctx\.caller\?\.entra_email\}/.test(unstar));
check("S6 only the LIVE widget makes the star tappable (a chat snapshot card does not)", /live === true \? \{ caller, live: true, pushes: \[\], onChanged \} : undefined/.test(sched));
check("S7 the band passes the context to each row", /<UpNextRowItem key=\{row\.id\} row=\{row\} caller=\{caller\} pushCtx=\{pushCtx\} \/>/.test(sched));
check("S8 the Schedule tab re-reads itself after a change", /onChanged=\{reload\}/.test(live) && /\[caller, nonce\]/.test(hook));
check("S9 a failed RE-read keeps what is on screen", /setState\(\(prev\) => \(\{ loading: false, data: prev\.data \}\)\)/.test(hook));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
