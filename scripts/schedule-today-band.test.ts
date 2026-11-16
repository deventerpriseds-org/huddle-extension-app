// WHAT:       source pins for the full-page Schedule layout: sections flow at natural height (the page
//             scrolls, nothing is squeezed) and every section is collapsible.
// WHY:        2026-11-07 TODAY'S SCHEDULE held 5 rows and rendered 0px tall under a long Up Next (flex-column
//             overflow-y-auto band shrank to nothing). Owner: "If there were items ... it should push the
//             sections below it down and they should all be collapsible". The LIVE proof is the browser
//             probe .claude/skills/test-agent-serverfn/scripts/schedule-today-checks.mjs; these pins are the
//             cheap offline guard that the fix stays wired.
// SUPERSEDES: the first version of this file (kept-band cap), same branch.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   verify-uat run 42409814370 (bandHeight 0, liCount 5).
import { readFileSync } from "node:fs";
const src = readFileSync("src/features/huddle/components/JourneyWidgets.tsx", "utf8");
const sched = src.slice(src.indexOf("export function ScheduleWidget("), src.indexOf("/* ── Live data"));
const prio = src.slice(0, src.indexOf("export function ScheduleWidget("));
let fail = 0;
const check = (n: string, ok: boolean) => { console.log(`${ok ? "PASS" : "FAIL"} ${n}`); if (!ok) fail++; };
check("T1 every Schedule band flows (no inner scroll)", (sched.match(/<ScrollBand full=\{full\} flow>/g) ?? []).length >= 2 && !/<ScrollBand full=\{full\}>/.test(sched));
check("T2 a flowing full band is not a scroll container", /cn\(flow && full \? "" : "overflow-y-auto"/.test(src));
check("T3 the Schedule page shell scrolls and its sections never shrink", /chrome === "page" && "overflow-y-auto \[&>\*\]:shrink-0"/.test(sched));
check("T4 all three Schedule sections are collapsible", ["schedule-today", "schedule-doing", "schedule-upnext"].every((id) => sched.includes(`<CollapsibleSection id="${id}"`)));
check("T5 collapsible sections open by default and expose aria-expanded", /return v === null \? true : v === "1";/.test(src) && /aria-expanded=\{open\}\s*\n\s*aria-label=\{`\$\{open \? "Collapse" : "Expand"\} \$\{label\}`\}/.test(src));
check("T6 Priorities is untouched (no flow bands there)", !/flow>/.test(prio));
console.log(fail ? `${fail} failed` : "all passed");
process.exit(fail ? 1 : 0);
