// Offline unit test for the router's pure winner-assembly logic. NO OpenAI calls — feeds mocked
// router outputs ({primary, supporting, explicitlyRequested} + mentions) straight into assembleWinners
// and asserts the final winner set. Run:  npx tsx scripts/router-winners.test.ts
//
// This is the cheap layer that proves the mention/handoff/multi-lane routing WITHOUT running full
// multi-agent turns (which would fire N agent-reply LLM calls per test and burn quota).

import { assembleWinners, countLaneLabels, detectLaneOwners, routeMessage, laneOwnerFor, primeLaneDecision } from "../src/features/huddle/lib/routing";
import { sharedCapabilityHolders } from "../src/features/huddle/lib/capabilities";
import { AGENTS } from "../src/features/huddle/data/agents";

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

console.log("=== MULTI-LANE LISTS (brain-dump) ===");
// 10. 4-lane labeled list → primary + 3 explicitly-requested lane owners all survive solo (cap raised to 4).
eq("4-lane list keeps all 4 owners",
  run({ primary: A.cole, supporting: [A.finn, A.tess, A.faith], explicitlyRequested: [A.finn, A.tess, A.faith],
        text: "Career - apply to X. Education - add program. Finance - pay bills. Errands - car repair.", soloOnCoverage: true }).winners,
  [A.cole, A.finn, A.tess, A.faith]);

// 11. 5-lane list → cap raised to 5 (primary + 4 explicit), not truncated at the old cap of 3.
{
  const w = run({ primary: A.cole, supporting: [A.finn, A.tess, A.faith, A.sam],
                  explicitlyRequested: [A.finn, A.tess, A.faith, A.sam], text: "five lanes each with items", soloOnCoverage: true }).winners;
  check("5-lane list keeps 5",
    w.length === 5 && [A.cole, A.finn, A.tess, A.faith, A.sam].every((x) => w.includes(x)), `[${w.join(", ")}]`);
}

// 12. Casual two-domain question (NOT an enumerated list): explicitlyRequested empty → stays solo.
{
  const r = run({ primary: A.finn, supporting: [A.sam], explicitlyRequested: [],
                  text: "should I focus on finance or fitness first?", soloOnCoverage: true });
  check("casual two-domain stays solo", r.soloApplied ? r.winners.length === 1 : true,
    `soloApplied=${r.soloApplied} winners=[${r.winners.join(", ")}]`);
}

// 13. Two enumerated lanes map to the SAME owner → owner appears exactly once.
eq("two lanes same owner → once",
  run({ primary: A.finn, supporting: [A.finn], explicitlyRequested: [A.finn], text: "Finance - pay. Budget - plan." }).winners,
  [A.finn]);

// 14. Normal turn, many adjacency (none explicitly requested) → dropped under solo, cap NOT raised.
{
  const r = run({ primary: A.finn, supporting: [A.sam, A.tess, A.iris, A.cole], explicitlyRequested: [],
                  text: "budget question", soloOnCoverage: true });
  check("adjacency dropped, cap not raised on normal turn",
    r.soloApplied ? r.winners.length === 1 : r.winners.length <= 3, `[${r.winners.join(", ")}]`);
}

console.log("=== MULTI-LANE DETECTION + FAN-OUT (not forced solo) ===");
const LIST = `Here are some things I need to tackle

Career - apply to a job, update LinkedIn
Education - import a course, add a program
Finance - make payments, transfer funds
Errands - take the car in Tuesday`;
// 15. countLaneLabels detects the 4 enumerated lanes.
check("countLaneLabels(4-lane list) === 4", countLaneLabels(LIST) === 4, `got ${countLaneLabels(LIST)}`);
// 16. A single-topic message is NOT a labeled list.
check("countLaneLabels(single topic) < 2",
  countLaneLabels("what workouts do I usually go for?") < 2, `got ${countLaneLabels("what workouts do I usually go for?")}`);
// 17. Multi-lane list → solo OFF (caller passes soloOnCoverage:false) → every lane owner the router
//     picked is kept (fan-out), even with explicitlyRequested empty, thanks to the raised cap.
eq("multi-lane list fans out (solo off, cap raised by laneCount)",
  run({ primary: A.cole, supporting: [A.finn, A.tess, A.faith], explicitlyRequested: [],
        soloOnCoverage: false, explicitLaneCount: 4, text: LIST }).winners,
  [A.cole, A.finn, A.tess, A.faith]);
// 18. Single-topic (NOT a list) → solo ON, laneCount 0 → adjacency dropped, stays solo (no pile-on).
{
  const r = run({ primary: A.finn, supporting: [A.sam, A.tess], explicitlyRequested: [],
                  soloOnCoverage: true, explicitLaneCount: 0, text: "am I over budget on dining this month?" });
  check("single-topic stays solo (no pile-on)",
    r.soloApplied ? r.winners.length === 1 : true, `soloApplied=${r.soloApplied} winners=[${r.winners.join(", ")}]`);
}

console.log("=== LANE→OWNER RESOLUTION (real roster) ===");
const USER_LIST = `Here are some things I need to tackle

Career - Apply to Trinnex position, update LinkedIn profile, confirm MIT CTO courses
Education - import AI course, add DBA program, add schedule from image or file
Finance - make payments to klarna, transfer HSA funds, transfer bill and Amex funds
Errands - cancel or take my wife's suv for repair 8am Tuesday morning`;
{
  const owners = detectLaneOwners(USER_LIST, AGENTS);
  // The four EXACT lane owners must all resolve — this is the fix: education→elle & errands→ezra
  // were the ones the LLM dropped; they must now be forced in deterministically.
  const need = ["cole-blake", "finn-reid", "elle-rowan", "ezra-miles"];
  const got = need.filter((id) => owners.includes(id));
  check("4 exact lane owners resolve (cole/finn/elle/ezra)",
    got.length === 4, `resolved [${owners.join(", ")}]`);
}
// A single-topic message resolves NO forced owners (not a list).
check("single-topic → no forced lane owners",
  detectLaneOwners("what workouts do I usually go for?", AGENTS).length === 0,
  `got [${detectLaneOwners("what workouts do I usually go for?", AGENTS).join(", ")}]`);

// ── PRIME RESPONDERS for Nexus assignment asks (AC-F2-41/42/43/45/46, RG-8) ─────────────────────────
// Owner, 2026-10-28: "elle and iris should be prime to use it immediately if i request it." Proved on
// the DETERMINISTIC path -- the one that runs when the LLM router 429s -- and on the 1:1 lane logic.
// Baseline before the change (origin/main 4809e2e): "update the due date on my research paper" ->
// eli-vaughn 0.32, "log my DBA deliverables" -> ezra-miles 0.26, "fix the due date on my strategy
// paper" -> liam-kingsley 0.11; laneOwnerFor(..,'elle-rowan') and (..,'iris-chase') -> eli/ezra.
console.log("\n=== PRIME RESPONDERS (Nexus assignments) ===");
{
  const ALL_IDS = AGENTS.map((a) => a.id);
  const PRIME = new Set(["elle-rowan", "iris-chase"]);
  const PHRASES = [
    "add my assignments",
    "add my MGT-782 assignments from the syllabus",
    "put the research paper due Dec 9 on my assignments",
    "update the due date on my research paper",
    "change my research proposal deadline to Nov 2",
    "log my DBA deliverables",
    "add this syllabus's deadlines to Nexus",
    "I have a new paper due next month for MGT-782, add it",
    "add my school assignments",
    "fix the due date on my strategy paper",
  ];
  const winner = (text: string) =>
    routeMessage({ text, scope: "group", members: ALL_IDS, history: [] } as Parameters<typeof routeMessage>[0]).winners[0];
  const groupHits = PHRASES.filter((p) => PRIME.has(winner(p)));
  check("F2-41 group fallback: Elle/Iris lead 10/10", groupHits.length === 10,
    `${groupHits.length}/10; misses: ${PHRASES.filter((p) => !PRIME.has(winner(p))).map((p) => `"${p}"->${winner(p)}`).join("; ") || "none"}`);
  for (const self of ["elle-rowan", "iris-chase"] as const) {
    const handed = PHRASES.map((p) => [p, laneOwnerFor(p, self)?.id] as const).filter(([, o]) => o);
    check(`F2-42 1:1 with ${self} keeps all 10 (no lane hand-off)`, handed.length === 0,
      handed.map(([p, o]) => `"${p}"->${o}`).join("; ") || "none handed off");
    const notKeep = PHRASES.filter((p) => primeLaneDecision(p, self) !== "keep");
    check(`F2-42 1:1 with ${self}: owner follow-up decision is 'keep' for all 10`, notKeep.length === 0,
      notKeep.join("; ") || "all keep");
  }
  for (const self of ["finn-reid", "eli-vaughn", "faith-hartley"] as const) {
    const bad = PHRASES.map((p) => [p, laneOwnerFor(p, self)?.id] as const).filter(([, o]) => o && !PRIME.has(o));
    check(`F2-43 1:1 with ${self}: any hand-off goes to Elle/Iris, never a third lane`, bad.length === 0,
      bad.map(([p, o]) => `"${p}"->${o}`).join("; ") || "ok");
  }
  // Regression: lanes that must NOT move. Expected values are the origin/main baseline, measured.
  const KEEP: Array<[string, string]> = [
    ["add a task to my board to call the bank", "iris-chase"],
    ["what's on my board", "iris-chase"],
    ["plan my workout for tomorrow", "flex-grimes"],
    ["tighten my budget", "finn-reid"],
    ["book my flight to Denver", "troy-lennox"],
    ["tidy up my calendar adjustments", "eli-vaughn"],
    ["change the due date on my grocery task", "charleston-lewis"],
    // PRE-EXISTING on origin/main and NOT changed here: these two do not route where AC-F2-45/46
    // say ("assign the grocery run to Iris" -> charleston, "fix the typo in the email draft" ->
    // cam-post). Pinned to the baseline so this change provably did not move them.
    ["assign the grocery run to Iris", "charleston-lewis"],
    ["fix the typo in the email draft", "cam-post"],
  ];
  for (const [text, want] of KEEP) {
    const got = winner(text);
    check(`F2-45/46 unchanged lane: "${text}"`, got === want, `-> ${got} (baseline ${want})`);
  }
  check("F2-45 'buy paper towels' is not a coursework ask", sharedCapabilityHolders("buy paper towels").length === 0,
    `holders [${sharedCapabilityHolders("buy paper towels").map((h) => h.agent.id).join(", ")}]`);
  check("F2-45 'assign the grocery run' is not captured by 'assignment'",
    sharedCapabilityHolders("assign the grocery run to Iris").length === 0, "word-start match only");
}

console.log(`\n==================== ${pass} passed, ${fail} failed ====================`);
process.exit(fail === 0 ? 0 : 1);
