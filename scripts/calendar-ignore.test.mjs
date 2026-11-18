// WHAT:       Test: Huddle's Outlook calendar read drops "work block" holds (graph-email.server.ts).
// WHY:        Owner 2026-11-18: "work block" events must not appear in TaskOS or Huddle.
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   journey-voice#125 (same phrase list, journey _shared/calendar-ignore.ts).
// Run: node --test scripts/calendar-ignore.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
test('CAL-IGN-1 Outlook calendar read drops work-block holds', () => {
  const src = readFileSync(new URL('../src/features/huddle/lib/email/graph-email.server.ts', import.meta.url), 'utf8');
  assert.match(src, /events: events\.filter\(\(e\) => !isIgnoredCalendarEvent\(e\)\)/, 'calendar read filters ignored titles');
  const list = JSON.parse(src.match(/export const IGNORED_CALENDAR_TITLES = (\[[^\]]*\])/)[1]);
  const ignored = (t) => list.some((p) => String(t).toLowerCase().includes(p));
  for (const t of ['Work Block', 'Work Block 1', 'Work block 2']) assert.equal(ignored(t), true, t);
  for (const t of ['1:1 Andrew and Von', 'Platform Weekly']) assert.equal(ignored(t), false, t);
});

// Owner 2026-11-19: "Items that are tentative on my schedule should be on the same exclusion list as 'work
// block' items". 37 tentative events were stored (Story Point Poker, Platform Weekly, ...).
const gsrc = () => readFileSync(new URL('../src/features/huddle/lib/email/graph-email.server.ts', import.meta.url), 'utf8');
test('CAL-IGN-2 the drop rule: an ignored title OR tentative availability', () => {
  const src = gsrc();
  assert.match(src, /export function isIgnoredCalendarEvent\(e: \{ subject\?: unknown; showAs\?: unknown \}\): boolean \{\n\s*if \(isIgnoredCalendarTitle\(e\?\.subject\)\) return true;\n\s*return String\(e\?\.showAs \?\? ""\)\.toLowerCase\(\) === "tentative";/);
});
test('CAL-IGN-3 the Outlook read asks Graph for showAs and keeps it on each event', () => {
  const src = gsrc();
  assert.match(src, /encodeURIComponent\("id,subject,start,end,location,isAllDay,organizer,showAs"\)/);
  assert.match(src, /showAs: e\.showAs \? String\(e\.showAs\)\.toLowerCase\(\) : null,/);
});
test('CAL-IGN-4 the work-calendar FEED gets the same exclusion (it had none)', () => {
  const src = gsrc();
  assert.match(src, /feed = \{ \.\.\.feed, events: feed\.events\.filter\(\(e\) => !isIgnoredCalendarEvent\(e\)\) \};\n\s*if \(!feed\.events\.length && !feed\.warnings\.length\) return r;/);
  const fsrc = readFileSync(new URL('../src/features/huddle/lib/external-feeds/onedrive-feed.ts', import.meta.url), 'utf8');
  assert.match(fsrc, /showAs: str\(r\.showAs\)\.toLowerCase\(\) \|\| null,/);
});
