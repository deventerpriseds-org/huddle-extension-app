// WHAT:       source pin: the Schedule widget's TODAY'S SCHEDULE band is a non-shrinking ScrollBand.
// WHY:        2026-11-07 the band held 5 rows and rendered 0px tall on the full-page Schedule (flex column
//             child with overflow-y-auto shrank to nothing under a long Up Next). The LIVE proof is the
//             browser probe .claude/skills/test-agent-serverfn/scripts/schedule-today-checks.mjs; this pin
//             is the cheap offline guard that the fix stays wired.
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   verify-uat run 42409814370 (bandHeight 0, liCount 5).
import { readFileSync } from "node:fs";
const src = readFileSync("src/features/huddle/components/JourneyWidgets.tsx", "utf8");
let fail = 0;
const check = (n: string, ok: boolean) => { console.log(`${ok ? "PASS" : "FAIL"} ${n}`); if (!ok) fail++; };
check("T1 today band is rendered with keep", /data\.todaySchedule\.length > 0 \? \(\s*\n\s*<ScrollBand full=\{full\} keep>/.test(src));
check("T2 a kept band never shrinks", /keep && "shrink-0"/.test(src));
check("T3 a kept band is height-capped even when full", /full && !keep \? "" : "max-h-\[min\(22rem,45vh\)\]"/.test(src));
console.log(fail ? `${fail} failed` : "all passed");
process.exit(fail ? 1 : 0);
