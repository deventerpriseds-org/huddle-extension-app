// Offline unit test for the router's pure winner-assembly logic. NO OpenAI calls — feeds mocked
// router outputs ({primary, supporting, explicitlyRequested} + mentions) straight into assembleWinners
// and asserts the final winner set. Run:  npx tsx scripts/router-winners.test.ts
//
// This is the cheap layer that proves the mention/handoff/multi-lane routing WITHOUT running full
// multi-agent turns (which would fire N agent-reply LLM calls per test and burn quota).

import { assembleWinners } from "../src/features/huddle/lib/routing";

const A = {
  iris: "iris-chase", tess: "tess-sutton", sam: "sam-trent", terry: "terry-locke",
  finn: "finn-reid", faith: "faith-hartley", cole: "cole-blake",
} as const;
const ALL = Object.values(A) as string[];

let pass = 0, fail = 0;
function eq(label: string, got: string[], want: string[]) {
  const g = [...got].sort().join(","), w = [...want].sort().join(",");
  const ok = g === w;
  console.log(`  ${ok ? "PASS" : "FAIL"} ${label} — got [${got.join(", ")}]${ok ? "" : `  want [${want.join(", ")}]`}`);
  ok ? pass++ : fail++;
}
function check(label: string, cond: boolean, detail: string) {
  console.log(`  ${cond ? "PASS" : "FAIL"} ${label} — ${detail}`);
  cond ? pass++ : fail++;
}
const run = (o: Partial<Parameters<typeof assembleWinners>[0]>) =>
  assembleWinners({
    primary: A.sam, supporting: [], explicitlyRequested: [], mentions: [],
    memberIds: ALL, text: "", soloOnCoverage: true, ...o,
  } as Parameters<typeof assembleWinners>[0]);

console.log("=== MENTION TURNS ===");
// 1. Handoff: named work-owner is primary, @mention is the handoff target → both.
eq("handoff (primary tess + @cole)",
  run({ primary: A.tess, supporting: [], mentions: [A.cole], text: "Tess, scope the MVP, then @cole build it" }).winners,
  [A.tess, A.cole]);

// 2. Handoff where the LLM also lists the mentioned agent as supporting → no duplicate.
eq("handoff (cole also in supporting, no dup)",
  run({ primary: A.tess, supporting: [A.cole], mentions: [A.cole] }).winners,
  [A.tess, A.cole]);

// 3. Bare mention: LLM makes the addressed agent primary; adjacency supporting is dropped → just Cole.
eq("bare @cole (adjacency tess dropped)",
  run({ primary: A.cole, supporting: [A.tess], mentions: [A.cole], text: "@cole how long will the API take?" }).winners,
  [A.cole]);

// 4. Bare mention with a MIS-PICKED primary (documented residual): at most 2, mention always present.
{
  const w = run({ primary: A.tess, supporting: [], mentions: [A.cole] }).winners;
  check("bare @cole w/ mispick — <=2 and cole present", w.includes(A.cole) && w.length <= 2, `[${w.join(", ")}]`);
}

// 5. Mixed: prose primary + explicitly-named supporting + @mention → all three.
eq("mixed (sam + named finn + @tess)",
  run({ primary: A.sam, supporting: [A.finn], explicitlyRequested: [A.finn], mentions: [A.tess] }).winners,
  [A.sam, A.finn, A.tess]);

console.log("=== NORMAL TURNS (no @mention) ===");
// 6. Multi-lane: user-named supporting survive the solo cut even when the primary covers the topic.
eq("multi-lane (sam + named finn + tess survive solo)",
  run({ primary: A.sam, supporting: [A.finn, A.tess], explicitlyRequested: [A.finn, A.tess],
        text: "Sam, draft a go-to-market plan. Pull in Finn for pricing and Tess for the MVP scope.", soloOnCoverage: true }).winners,
  [A.sam, A.finn, A.tess]);

// 7. Single-lane adjacency: an UNNAMED supporting agent IS cut when solo applies.
{
  const r = run({ primary: A.finn, supporting: [A.sam], explicitlyRequested: [],
                  text: "am I over budget on dining this month?", soloOnCoverage: true });
  // If the primary scored high enough to trigger solo, the unnamed adjacency (sam) must be dropped.
  check("single-lane adjacency cut when solo",
    r.soloApplied ? r.winners.join(",") === A.finn : true,
    `soloApplied=${r.soloApplied} winners=[${r.winners.join(", ")}]`);
}

// 8. soloOnCoverage OFF: adjacency is kept.
eq("solo OFF keeps adjacency",
  run({ primary: A.finn, supporting: [A.sam], soloOnCoverage: false, text: "budget dining" }).winners,
  [A.finn, A.sam]);

// 9. Cap: never exceed 4 winners on a mention turn.
{
  const w = run({ primary: A.sam, supporting: [A.finn, A.tess, A.iris], explicitlyRequested: [A.finn, A.tess, A.iris],
                  mentions: [A.cole, A.terry] }).winners;
  check("mention cap <=4", w.length <= 4, `[${w.join(", ")}]`);
}

console.log(`\n==================== ${pass} passed, ${fail} failed ====================`);
process.exit(fail === 0 ? 0 : 1);
