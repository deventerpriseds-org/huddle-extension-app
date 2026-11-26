// WHAT:       Test: Huddle's calendar reads (EDS Graph + the work feed) drop what the OWNER's TaskOS ignore
//             settings say to drop, through ONE decision (lib/calendar/calendar-ignore.ts).
// WHY:        Owner 2026-11-18: "work block" events must not appear in TaskOS or Huddle. Owner 2026-11-26 (option A):
//             Huddle follows the owner's TaskOS settings (titles, tentative switch, categories) instead of its own rule.
// SUPERSEDES: CAL-IGN-2/3 as written 2026-11-19, which pinned the blanket-tentative rule and the old $select text
//             (REWRITTEN to the new behaviour per .claude/ac-huddle-calendar-ignore.md AC-32, never loosened).
// SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   journey-voice#125 (phrase list); scripts/calendar-ignore-parity.test.ts (full parity with journey).
// Run: node --test scripts/calendar-ignore.test.mjs   (node >= 22.18 strips TS types by default)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_IGNORE_TITLES,
  fallbackIgnoreRules,
  isIgnoredByRules,
} from '../src/features/huddle/lib/calendar/calendar-ignore.ts';

const gsrc = () => readFileSync(new URL('../src/features/huddle/lib/email/graph-email.server.ts', import.meta.url), 'utf8');
const owner = (o = {}) => ({ phrases: ['work block'], tentative: false, categories: ['purple category'], ownerEmails: ['dev@example.io'], ...o });
const group = [{ email: 'dev@example.io' }, { email: 'dana@example.org' }, { email: 'pat@example.org' }];

test('CAL-IGN-1 work-block holds are dropped on the EDS read, by the fallback seed and by the owner list', () => {
  assert.match(gsrc(), /events: \(raw\.events \?\? \[\]\)\.filter\(\(e\) => !isIgnoredByRules\(e, rules\)\)\.map\(publicCalendarEvent\)/);
  assert.deepEqual([...DEFAULT_IGNORE_TITLES], ['work block']);
  for (const rules of [fallbackIgnoreRules(), owner()]) {
    for (const t of ['Work Block', 'Work Block 1', 'Work block 2']) assert.equal(isIgnoredByRules({ subject: t }, rules), true, t);
    for (const t of ['1:1 Andrew and Von', 'Platform Weekly']) assert.equal(isIgnoredByRules({ subject: t }, rules), false, t);
  }
});

// Owner 2026-11-19 put tentative events on the exclusion list; 2026-11-20 narrowed it to GROUP invites; the owner's
// switch (calendarIgnoreTentative, now OFF) decides. Rewritten 2026-11-26 from the old blanket-tentative text pin.
test('CAL-IGN-2 the drop rule follows the owner: switch OFF keeps every tentative; ON drops only groups; Purple always', () => {
  const t = (attendees) => ({ subject: 'x', showAs: 'tentative', attendees });
  assert.equal(isIgnoredByRules(t(group), owner()), false, 'switch off: tentative group kept');
  assert.equal(isIgnoredByRules(t(group), owner({ tentative: true })), true, 'switch on: group dropped');
  assert.equal(isIgnoredByRules(t([{ email: 'dev@example.io' }]), owner({ tentative: true })), false, 'switch on: own hold kept');
  assert.equal(isIgnoredByRules(t([{ email: 'dev@example.io' }, { email: 'dana@example.org' }]), owner({ tentative: true })), false, '1:1 kept');
  assert.equal(isIgnoredByRules({ subject: 'x', showAs: 'busy', categories: ['Purple category'] }, owner()), true, 'Purple dropped');
  assert.equal(isIgnoredByRules({ subject: 'x', showAs: 'busy', categories: ['Purple category'] }, fallbackIgnoreRules()), false, 'fallback has no categories');
  assert.equal(isIgnoredByRules(t(group), fallbackIgnoreRules()), true, 'fallback = journey default: tentative groups dropped');
  assert.equal(isIgnoredByRules(t(undefined), fallbackIgnoreRules()), false, 'no attendee list = kept');
});

test('CAL-IGN-3 the Outlook read asks Graph for showAs, categories and attendees and keeps them for the decision', () => {
  const src = gsrc();
  assert.match(src, /encodeURIComponent\("id,subject,start,end,location,isAllDay,organizer,showAs,categories,attendees"\)/);
  assert.match(src, /showAs: e\.showAs \? String\(e\.showAs\)\.toLowerCase\(\) : null,\n\s*categories: normalizeCategories\(e\.categories\),\n\s*attendees: graphAttendees\(e\.attendees\),/);
});

test('CAL-IGN-4 the work-calendar FEED gets the SAME decision, applied once with the same rules as the EDS events', () => {
  const src = gsrc();
  assert.match(src, /const keep = \(e: CalendarEvent\) => !isIgnoredByRules\(e, rules\);\n\s*const r: CalendarReadResult = raw\.ok\n\s*\? \{ \.\.\.raw, events: \(raw\.events \?\? \[\]\)\.filter\(keep\)\.map\(publicCalendarEvent\) \}\n\s*: raw;\n\s*feed = \{ \.\.\.feed, events: feed\.events\.filter\(keep\)\.map\(publicCalendarEvent\) \};/);
  const fsrc = readFileSync(new URL('../src/features/huddle/lib/external-feeds/onedrive-feed.ts', import.meta.url), 'utf8');
  assert.match(fsrc, /showAs: str\(r\.showAs\)\.toLowerCase\(\) \|\| null,/);
  assert.match(fsrc, /categories: normalizeCategories\(r\.categories\),\n\s*attendees: feedAttendees\(r\),/);
});

test('CAL-IGN-5 (AC-34) ONE decision function in src: no second local copy of an ignore predicate', () => {
  const root = new URL('../src', import.meta.url).pathname;
  const hits = [];
  const walk = (d) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(n) && /function (isIgnoredCalendarEvent|isIgnoredCalendarTitle|isIgnoredByRules)\b/.test(readFileSync(p, 'utf8'))) hits.push(p.slice(root.length));
    }
  };
  walk(root);
  assert.deepEqual(hits, ['/features/huddle/lib/calendar/calendar-ignore.ts']);
});
