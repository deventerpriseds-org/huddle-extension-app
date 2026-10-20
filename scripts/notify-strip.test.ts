// WHAT:       Pins the reply-notification strip that replaced the composer bell (owner 2026-10-20: "I prefer
//             'Get reply notifications on this computer — Turn on' strip"): it shows only where Web Push
//             works and only until the browser has been asked, and the bell is gone from the composer.
// WHY:        Owner, 2026-10-19: "I still don't understand the point of the manual bell".
// SUPERSEDES: the composer bell / BellRing indicator (HuddleView.tsx, removed in the same commit).
// SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   Run: bun scripts/notify-strip.test.ts
import { readFileSync } from "node:fs";

let pass = 0,
  fail = 0;
function check(name: string, ok: boolean) {
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
}
const view = readFileSync("src/features/huddle/components/HuddleView.tsx", "utf8");
check("N1 the strip shows only where Web Push works, before the browser has been asked, unless hidden",
  /\{push\.supported && push\.permission === "default" && !notifyStripHidden && \(/.test(view));
check("N2 the strip says what it does and its button turns notifications on",
  /Get reply notifications on this computer<\/span>/.test(view) && /onClick=\{toggleNotifications\}[\s\S]{0,300}Turn on/.test(view));
check("N3 the composer bell and its 'on' indicator are gone",
  !/aria-label="Enable notifications for replies while you're away"/.test(view) && !/BellRing/.test(view));
check("N4 'Not now' is remembered per browser and survives storage being blocked",
  /localStorage\.setItem\("huddle\.notifyStripHidden", "1"\)/.test(view) && /localStorage\.getItem\("huddle\.notifyStripHidden"\) === "1";\s*\} catch \{\s*return false;/.test(view));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
