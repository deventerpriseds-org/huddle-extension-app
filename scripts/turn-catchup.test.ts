// WHAT:       Proves the back-fill resumes from the newest SAVED message, not this device's cursor.
// WHY:        2026-10-28: saves were rejected for 10 days; after an app restart the back-fill resumed
//             from a recent cursor and never re-fetched 147 Iris turns sitting on the server.
// SUPERSEDES: nothing
// SUPERSEDED-BY: nothing -- current
// EVIDENCE:   src/features/huddle/lib/turn-catchup.ts header
//
// Run:  bun scripts/turn-catchup.test.ts   (npm run test:turn-catchup)
import { catchUpCursor, newestSavedTs } from "../src/features/huddle/lib/turn-catchup";

let pass = 0,
  fail = 0;
function check(label: string, cond: boolean, detail: string) {
  console.log(`  ${cond ? "PASS" : "FAIL"} ${label} — ${detail}`);
  if (cond) pass++;
  else fail++;
}

const OCT15 = Date.parse("2026-10-15T21:52:22Z");
const TODAY = Date.parse("2026-10-28T18:00:00Z");
const saved = [
  { id: "u-1", ts: OCT15 - 60_000 },
  { id: "a-u-1-0", ts: OCT15 },
];

check(
  "C1 the owner's case: cursor today, saved history ends Oct 15 -> resume from Oct 15",
  catchUpCursor(TODAY, saved) === OCT15,
  `${new Date(catchUpCursor(TODAY, saved)).toISOString()}`,
);
check(
  "C2 a cursor already older than the saved history is kept",
  catchUpCursor(OCT15 - 86_400_000, saved) === OCT15 - 86_400_000,
  "unchanged",
);
check("C3 nothing saved leaves the cursor alone", catchUpCursor(TODAY, []) === TODAY, "unchanged");
check(
  "C4 a reminder fired today does not count as saved history",
  newestSavedTs([...saved, { id: "rem-abc", ts: TODAY }]) === OCT15,
  "rem- ignored",
);
check(
  "C5 seeded demo rows do not count as saved history",
  newestSavedTs([...saved, { id: "d-1", ts: TODAY, demo: true }]) === OCT15,
  "demo ignored",
);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
