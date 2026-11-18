// WHAT:       Test: Huddle's Outlook calendar read drops "work block" holds (graph-email.server.ts).
// WHY:        Owner 2026-11-18: "work block" events must not appear in TaskOS or Huddle.
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   journey-voice#125 (same phrase list, journey _shared/calendar-ignore.ts).
// Run: node scripts/calendar-ignore.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('../src/features/huddle/lib/email/graph-email.server.ts', import.meta.url), 'utf8');
assert.match(src, /events: events\.filter\(\(e\) => !isIgnoredCalendarTitle\(e\.subject\)\)/, 'calendar read filters ignored titles');
const list = JSON.parse(src.match(/export const IGNORED_CALENDAR_TITLES = (\[[^\]]*\])/)[1]);
const ignored = (t) => list.some((p) => String(t).toLowerCase().includes(p));
for (const t of ['Work Block', 'Work Block 1', 'Work block 2']) assert.equal(ignored(t), true, t);
for (const t of ['1:1 Andrew and Von', 'Platform Weekly']) assert.equal(ignored(t), false, t);
console.log('calendar-ignore: all checks passed');
