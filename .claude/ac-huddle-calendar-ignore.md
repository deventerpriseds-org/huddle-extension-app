<!--
WHAT:          Acceptance criteria: Huddle applies the owner's TaskOS calendar-ignore settings (titles, tentative
               switch, categories) to BOTH of its calendar paths instead of its own hardcoded rule.
WHY:           Owner 2026-11-26: "does huddle not look to items in taskos? Why would they need separate ignore
               approaches?" Option A chosen: Huddle READS the TaskOS settings, keeps no copy.
SUPERSEDES:    nothing.  SUPERSEDED-BY: nothing -- current.
EVIDENCE:      journey supabase/functions/_shared/calendar-ignore.ts (the rule); huddle graph-email.server.ts:674-687
               (Huddle's hardcoded rule today); journey .claude/ac-calendar-ignore-categories.md S-1..S-18.
-->

# Acceptance Criteria — Huddle follows the owner's TaskOS calendar-ignore settings

Task: make every calendar event Huddle reads (EDS Graph calendarView and the OneDrive work feed) pass through the
SAME ignore decision TaskOS makes, using the owner's settings read live from journey, with a safe fallback.

Tier: **1** (it decides which meetings an owner sees and which time agents treat as busy; a wrong answer hides a
real meeting or shows an ignored one). Spelling table required and included (section 2).

## Sources read (this session, cited as file:line)

Huddle (worktree, `origin/main` at branch time):
- `src/features/huddle/lib/email/graph-email.server.ts`: `CalendarEvent` 519-533 (no `categories`, no `attendees`);
  `getOwnerCalendarEvents` 551-596 (feed filtered at 581 with the hardcoded rule); `getGraphCalendarEvents` 606-671
  (`$select` at 622 has no `categories`/`attendees`; map 655-663; filter 667); `IGNORED_CALENDAR_TITLES` 674;
  `isIgnoredCalendarEvent` 684-687 (blanket tentative, ignores the owner switch).
- `src/features/huddle/lib/external-feeds/onedrive-feed.ts`: `FeedCalendarEvent` 624-635; `mapFeedAppointments`
  659-697 (no categories, no attendees). `onedrive-feed.server.ts:395` calls the mapper on `snap.records`.
- `src/features/huddle/lib/journey/proxy.functions.ts`: `UI_ONLY_JOURNEY_TOOLS` 114, `invokeJourneyTool` 116-136.
- Callers of the calendar read: `tasks/schedule-brief.server.ts:335` (falls back to `getGraphCalendarEvents` when
  there is NO caller), `voice/realtime-tools.server.ts:586-587`, `huddle.functions.ts:5166-5167` and `6745-6746`.
- `scripts/calendar-ignore.test.mjs` (4 tests; CAL-IGN-2 and CAL-IGN-3 pin the CURRENT implementation text by regex).

journey (read-only):
- `supabase/functions/_shared/calendar-ignore.ts`: `resolveIgnoreTitles` 35-39, `resolveIgnoreTentative` 49-51,
  `TENTATIVE_GROUP_MIN_OTHERS = 2` 55, `resolveIgnoreCategories` 58-62, `hasIgnoredCategory` 65-68,
  `resolveIgnoreRules` 84-91, `isTentativeGroup` 94-100, `isIgnoredCalendarEvent` 108-115, `loadIgnoreRules` 127-131
  (owner addresses come from `resolveOwnerEmails`, `digest-source-meetings.ts`).
- `supabase/functions/_shared/meetings.ts:141-157` `otherPeople` (drops empty email, `resource`, `self`, owner addresses).
- `supabase/functions/_shared/onedrive-feed.ts:148-165` `feedAttendees` (required/optional/resource strings split on
  `;`/`,`), `185-190` `feedCategories`.
- `supabase/functions/huddle-proxy/index.ts:150-210` (`/tool` → `execute-tool` with the service-role key; `whoami`
  special case at 170).
- `supabase/functions/execute-tool/index.ts:495-496` (`case 'get_my_config'`), `2942-3075` `getMyConfig`
  (reads `user_scheduling_prefs.config`; sections at 3021-3073; `full_config` also pulls call history, topics,
  notifications, calendar connections, profile -- heavy).
- `.claude/ac-calendar-ignore-categories.md:129-146` (spelling table S-1..S-18).

## Existing system this extends (not duplicates)

- The **rule** stays journey's `_shared/calendar-ignore.ts`. Huddle must not re-derive defaults or config parsing;
  it receives already-resolved rules from journey.
- The **transport** is the existing `invokeJourneyTool` → `huddle-proxy /tool` → `execute-tool` path, and the
  **read** is the existing `get_my_config` tool (execute-tool:495) extended with one narrow section. No new edge
  function, no new secret, no new table, no Huddle-side copy of the settings.
- Huddle's own `isIgnoredCalendarEvent` (graph-email.server.ts:684) is REPLACED (one decision function, not two
  side by side). `IGNORED_CALENDAR_TITLES` survives only as the fallback seed.

## Section 1 — Huddle obtains the owner's settings

| # | Given / When / Then | Category | Observed via |
|---|---|---|---|
| AC-1 | Given the owner's `user_scheduling_prefs.config` holds `calendarIgnoreTitles`, `calendarIgnoreTentative`, `calendarIgnoreCategories`, when Huddle calls `invokeJourneyTool({toolName:"get_my_config", args:{section:"calendar_ignore"}, caller})`, then the parsed `output` contains exactly `{phrases, tentative, categories, ownerEmails}` equal to journey `loadIgnoreRules(supabase, userId)` (calendar-ignore.ts:127) for that user -- same arrays, same order, lower-cased -- and does NOT contain `call_history`, `topic_groups`, `pending_notifications` or any other `full_config` field. | happy-path | journey unit test calling `getMyConfig` with a stub supabase; one live call through the proxy, output printed |
| AC-2 | Given AC-1's section, when it resolves the values, then it calls journey's `resolveIgnoreRules` / `loadIgnoreRules` (no second parser in execute-tool), so absent/malformed config yields the journey defaults: `phrases:["work block"]`, `tentative:true`, `categories:[]`. | happy-path / extend | grep: `section === 'calendar_ignore'` branch imports from `../_shared/calendar-ignore.ts`; unit test with `config:{}` and `config:{calendarIgnoreCategories:"Purple category"}` |
| AC-3 | Given the change, when `git diff` is read for both repos, then no new org/edge secret, env var, edge function, or table is introduced; Huddle's call goes through `invokeJourneyTool` (proxy.functions.ts:116) and `get_my_config` is NOT added to `UI_ONLY_JOURNEY_TOOLS` (114). | regression / extend | `git diff --stat`; grep for `Deno.env.get(` / `process.env.` additions = 0 |
| AC-4 | Given journey is unreachable (proxy non-200, network throw, `ok:false`, non-JSON `output`, or a missing/ill-typed field), when Huddle reads the calendar, then (a) the read still returns events, never `events: []` caused by the settings failure, (b) no exception escapes `getOwnerCalendarEvents`, (c) the decision falls back to the BUILT-IN rule (see Gap G-1: proposed = journey's defaults `resolveIgnoreRules({})` = work-block titles, tentative-GROUP-only, no categories), and (d) one `console.error` line names the failure KIND (HTTP status / `ok:false` error code / exception class), never response text. | error | unit test with `invokeJourneyTool` stubbed to each failure; assert returned events = fixture minus fallback-ignored; assert log line |
| AC-5 | Given a settings payload that is partially valid (e.g. `categories` is a string), when Huddle consumes it, then each field is validated independently: a bad field takes its fallback value, good fields are still honoured, and nothing throws. A non-array `categories` can only KEEP meetings (never drop more). | edge | unit test, 3 payload variants |
| AC-6 | Given a calendar read with NO caller (schedule-brief.server.ts:335 `getGraphCalendarEvents(window)` branch), when it runs, then it uses the fallback rule from AC-4 and does not call journey (there is no owner to resolve); this is stated in a code comment at that branch. | edge | unit test with caller undefined: zero `invokeJourneyTool` calls, fallback verdicts |
| AC-7 | Given one `getOwnerCalendarEvents` call (EDS + feed), when it runs, then journey is called AT MOST ONCE for the settings, and both the EDS events and the feed events are filtered with that same rules object. | performance | counting stub on `invokeJourneyTool`: count ≤ 1 |
| AC-8 | Given several calendar reads for the same owner inside one turn (e.g. a 1:1 turn calling `get_calendar_events` twice, huddle.functions.ts:5166 and 6745, or a voice call realtime-tools.server.ts:586), when they run within the cache lifetime, then the total journey settings calls for that owner is 1. Cache is keyed by the caller's identity (entra object id / email) and its lifetime is ≤ 60 s. | performance | counting stub across 3 sequential reads: count = 1; advance clock 61 s: count = 2 |
| AC-9 | Given owner A's rules are cached, when owner B reads, then B's events are filtered by B's rules, never A's (cache miss for B). | edge (isolation) | unit test with two callers and different stubbed rules |
| AC-10 | Given a settings FAILURE, when the next read for that owner happens, then journey is asked again (a failure/fallback is not cached for the full lifetime; at most the same turn). | error | stub fails then succeeds: second read uses the owner rules |
| AC-11 | Given the owner changes a setting in TaskOS, when a Huddle calendar read starts more than the cache lifetime after the save, then it reflects the change. | happy-path | live: toggle once, read twice (see AC-24) |
| AC-12 | Given journey answers slowly, when Huddle waits for settings, then the wait is bounded (≤ 5 s) and a timeout takes the AC-4 fallback; the calendar read's total time grows by at most that bound. | performance | stub delaying 10 s: read returns in < 6 s with fallback verdicts |

## Section 2 — The decision on both calendar paths

| # | Given / When / Then | Category | Observed via |
|---|---|---|---|
| AC-13 | Given the EDS Graph read, when the calendarView URL is built (graph-email.server.ts:622), then `$select` includes `categories` AND `attendees` in addition to today's fields, and each mapped `CalendarEvent` carries `categories: string[]` (string names only, as journey `normalizeCategories` calendar-ignore.ts:71) and the attendee list needed for the group test. Both fields are additive and optional on the interface (519-533). | happy-path | unit test on the built query string; mapping test with a Graph-shaped fixture containing `categories:["Purple category"]` and 3 attendees |
| AC-14 | Given the OneDrive feed path, when `mapFeedAppointments` (onedrive-feed.ts:659) maps a record with `categories:["Purple category"]` and `requiredAttendees`/`optionalAttendees`/`resourceAttendees` strings, then the `FeedCalendarEvent` carries `categories` equal to journey `feedCategories(rec)` (journey onedrive-feed.ts:187) and attendees equal to journey `feedAttendees(rec)` (148-165: split on `;`/`,`, de-duplicated, `optional`/`resource` flags). | happy-path | unit test feeding the SAME record objects journey's `onedrive-feed.test.ts:58,308-312` uses; deep-equal to journey's outputs pasted as expected values |
| AC-15 | Given owner rules `categories:["purple category"]`, when an event (either path) has any category equal to it after trim+case-fold, then it is absent from `getOwnerCalendarEvents(...).events`; an event with only non-listed categories is present. Exact equality, never substring (spelling table S-1..S-18 below, all applied to BOTH paths). | happy-path | table-driven unit test, one row per S-n, run once per path |
| AC-16 | Given `tentative:false` (the owner's current setting), when events with `showAs:"tentative"` are read -- solo hold, 1:1, and a 3-person group -- then ALL of them are returned (none dropped for being tentative). | happy-path | unit test; and live AC-23 |
| AC-17 | Given `tentative:true`, when a tentative event has ≥ 2 OTHER people (journey `TENTATIVE_GROUP_MIN_OTHERS`, calendar-ignore.ts:55), then it is dropped; a tentative solo hold (0 others) and a tentative 1:1 (1 other) are kept. | happy-path | unit test with journey's own fixture shapes (`SOLO`, `ONE`, `GRP` at journey onedrive-feed.test.ts:308-312) |
| AC-18 | Given `tentative:true`, when a tentative event has NO attendee list (field absent, `null`, or not an array) -- the case for any path that did not select/parse attendees -- then it is KEPT (journey: "no attendee list = not a group", calendar-ignore.ts:17-18, 93). | edge | unit test, 3 variants |
| AC-19 | Given "other people" counting, when an attendee is a room (`resource:true`), flagged `self:true`, has an empty email, or is one of the owner's addresses (case-insensitive, trimmed), then it is NOT counted -- same as journey `otherPeople` (meetings.ts:141-157). Owner addresses = the `ownerEmails` returned in AC-1 UNION the caller's `entra_email`, the EDS `mailbox`, and the feed mailbox (journey adds the feed mailbox via `extraOwnerEmails`, calendar-ignore.ts:127). | edge | unit test: tentative event with owner + room + `Work@Example.org` + 1 real person = 1 other → kept |
| AC-20 | Given `phrases` from the owner list (e.g. `["work block","focus"]`), when a title contains any phrase case-insensitively, then it is dropped; `phrases:[]` (owner cleared the list) drops nothing by title -- the built-in `"work block"` is NOT re-added when journey answered successfully with `[]`. | happy-path / edge | unit test: `"Focus time"` dropped with list, kept with `[]`; `"Work Block 1"` kept with `[]` |
| AC-21 | Given the three rules, when they disagree, then the event is dropped if ANY rule matches (title OR category OR tentative-group), with the category rule independent of the tentative switch (S-17). | happy-path | unit test |
| AC-22 | Given `getOwnerCalendarEvents`, when the EDS read and the feed read are merged, then the ignore decision is applied exactly ONCE per event with the owner rules -- `getGraphCalendarEvents`'s internal filter (667) must not pre-drop events with the fallback rule when the caller's rules differ (e.g. a tentative group invite dropped by the old blanket rule while the owner switch is off). | regression | unit test: owner `tentative:false`, EDS fixture has a tentative group invite → present in result |

### Spelling table (Tier 1 matcher) -- category names, copied from journey `.claude/ac-calendar-ignore-categories.md:129-146`

Documentation basis: journey `calendar-ignore.ts:23-28` (exact name after trim + case-fold, ANY category, malformed =
[]); the owner's own words in that file's header. The Outlook categories API was NOT opened this session (see G-4);
S-18 inherits its "[Graph, unread]" marking from journey. Every row runs on BOTH Huddle paths (EDS Graph, feed).
Unless stated, owner list = `["Purple category"]`.

| # | Event categories / config | Documented by | Expected verdict | Wrong answer would be |
|---|---|---|---|---|
| S-1 | `["Purple category"]` | probe (exact stored value) | IGNORE | FALSE PASS (event shown/busy) |
| S-2 | `["purple CATEGORY"]` | case-fold rule, calendar-ignore.ts:26 | IGNORE | FALSE PASS |
| S-3 | `[" Purple category "]` | trim rule, calendar-ignore.ts:26,67 | IGNORE | FALSE PASS |
| S-4 | `["Blue category","Purple category"]` | ANY-category rule, :27 (15 live records carry both) | IGNORE | FALSE PASS |
| S-5 | `["Blue category"]` | probe | KEEP | FALSE REFUSAL (meeting lost) |
| S-6 | `["Purple"]` | over-match negative (prefix) | KEEP | FALSE REFUSAL |
| S-7 | `["Dark Purple category"]` | over-match negative (list entry is a substring) | KEEP | FALSE REFUSAL |
| S-8 | `["Purple category 2"]` | over-match negative (suffix) | KEEP | FALSE REFUSAL |
| S-9 | `[""]` / `["   "]` | blank name | KEEP | FALSE REFUSAL |
| S-10 | `null` / absent / `[]` | EDS events with no categories | KEEP | FALSE REFUSAL |
| S-11 | `"Purple category"` (string, not array) | non-array input, :66 | KEEP, no throw | crash or FALSE REFUSAL |
| S-12 | `[7, null, {}]` | non-string elements, :67 | KEEP, no throw | crash |
| S-13 | title `"Purple category sync"`, categories `[]` | over-match negative (title must not feed category rule) | KEEP | FALSE REFUSAL |
| S-14 | list `["purple category"]`, event `["Purple category"]` | case-fold on list side, :61 | IGNORE | FALSE PASS |
| S-15 | list `[]`, event `["Purple category"]` | owner unticked | KEEP | FALSE REFUSAL |
| S-16 | list `"Purple category"` (string in config) | malformed config, :60 | KEEP (category rule off) | FALSE REFUSAL |
| S-17 | list `["Purple category"]`, `calendarIgnoreTentative:false`, event tentative group with `["Purple category"]` | tentative-switch independence, :28 | IGNORE | FALSE PASS |
| S-18 | `["Purple Category"]` (capital C) | [Graph, unread] owner-editable display names | IGNORE | FALSE PASS |

Huddle-specific additions (same axes, new transport):

| # | Input | Documented by | Expected verdict | Wrong answer would be |
|---|---|---|---|---|
| S-19 | journey unreachable, event `["Purple category"]` | AC-4 fallback (categories:[]) | KEEP | FALSE REFUSAL if fallback invents categories |
| S-20 | journey unreachable, event title `"Work Block 2"` | AC-4 fallback seed `["work block"]` | IGNORE | FALSE PASS |
| S-21 | `tentative:false`, tentative 3-person group, no categories | owner switch, calendar-ignore.ts:49-51 | KEEP | FALSE REFUSAL (today's Huddle bug, graph-email.server.ts:686) |
| S-22 | `tentative:true`, tentative event, attendees absent (EDS path if `attendees` not selected) | calendar-ignore.ts:93 | KEEP | FALSE REFUSAL |
| S-23 | `tentative:true`, attendees = owner (different case) + 1 person | otherPeople owner exclusion, meetings.ts:155 | KEEP | FALSE REFUSAL |
| S-24 | `tentative:true`, attendees = 2 people + 1 room (`resource:true`) | meetings.ts:153; journey feedAttendees `resourceAttendees` | IGNORE | FALSE PASS |
| S-25 | `showAs:"Tentative"` (Graph casing) vs `"tentative"` | Huddle lower-cases at graph-email.server.ts:662, onedrive-feed.ts:693 | same verdict | either |
| S-26 | title `"WORK BLOCK"`, owner list `["work block"]` | case-insensitive contains, calendar-ignore.ts:42-43 | IGNORE | FALSE PASS |
| S-27 | title `"Networking block party"`, owner list `["work block"]` | over-match negative (`work block` not a substring) | KEEP | FALSE REFUSAL |
