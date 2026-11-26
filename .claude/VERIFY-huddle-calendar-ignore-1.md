<!--
WHAT:          Independent verification, loop 1, of "Huddle follows the owner's TaskOS calendar-ignore settings".
WHY:           Tier-1 change (decides which meetings the owner sees); verifier required before merge.
SUPERSEDES:    nothing.  SUPERSEDED-BY: nothing -- current.
EVIDENCE:      huddle claude_huddle-calendar-ignore @ bbef9356; journey claude_calendar-ignore-section @ 7a042778.
-->
# VERIFY huddle-calendar-ignore loop 1

Fresh clones under the session scratchpad. Nothing in source edited.

## Claims (one line each, appended as they land)
- SUITES huddle: `node --test scripts/calendar-ignore.test.mjs` 5/5; `bun scripts/calendar-ignore-parity.test.ts` 3/3 (45/45 parity, 42 rows through full read); `bun scripts/calendar-ignore-rules.test.ts` 11/11. CONFIRMED.
- SUITES huddle onedrive-feed: `bun scripts/onedrive-feed.test.ts` 58 PASS then `Cannot find package 'pg'` -- CONFIRMED as claimed, BUT sections H (H1) and I (I1), which call getGraphCalendarEvents/getOwnerCalendarEvents, never run here; their behaviour under the new code is NOT VERIFIED (a pg shim broke bun auto-install of parse5; abandoned). onedrive-feed.test.ts is unchanged on the branch.
- SUITES journey: `node scripts/run-tests.mjs` 771/771; section test + parity test 6/6 (`45/45 parity`). CONFIRMED.
- PARITY FIXTURE provenance: re-ran `node --experimental-strip-types --no-warnings scripts/calendar-ignore-parity-gen.ts` in journey -> `wrote 45 rows: 15 IGNORE, 30 KEEP`, `cmp` byte-identical to committed file; sha256 18c15b8f...11360 identical in both repos. CONFIRMED (AC-23/24).
- JOURNEY SECTION leaks only 4 keys: execute-tool branch returns `{phrases, tentative, categories, ownerEmails}` from `loadIgnoreRules`; huddle-proxy sends `JSON.stringify(exec.result)` as `output`, so Huddle receives exactly those four. No `Deno.env.get` added, no new secret/function/table (diff stat: 6 files, test + fixture + 18-line branch + harness limit()). `calendar_ignore` is NOT in the tool-definitions enum (tool-definitions.ts:643), so models are not steered to it. CONFIRMED (AC-1/2/3).
- MUTATIONS (mutate.sh, anchors from files, all FIRED with control EQUIVALENT, rc 0): V1 tentative switch ignored (`return isTentativeGroup(...)`) -> PAR-H2; V2 cache never expires (`if (hit)`) -> AC-8/9/10; V3 `self:true` attendee counted (NEW, not in implementer's 19) -> PAR-H2; V4 feed events unfiltered in getOwnerCalendarEvents -> PAR-H3; V5 `attendees` not stripped from returned events (NEW) -> AC-30. CONFIRMED.
- FALLBACK/CACHE probe (12 hostile invoke replies, timeout 300 ms): output "null", "[]", error-shaped JSON, all-wrong-types, undefined, sync TypeError, rejected string, ok:false http_502, non-JSON text, hang -> every one returns journey default rules `{work block, tentative:true, categories:[]}` from:"fallback", never throws, hang returns at 300 ms; log lines carry the kind only (bad_shape / unknown / TypeError / string / http_502 / non_json_output / timeout) and NEVER the planted `USERDATA` text; object (non-string) output honoured; partial `{tentative:false}` honours tentative and defaults the rest. CONFIRMED (AC-4/5/10/12).
- OLD RULE GONE: grep for `isIgnoredCalendarEvent|isIgnoredCalendarTitle` over huddle src/ scripts/ e2e/ .github and journey supabase/ scripts/ src/ -> only comments + CAL-IGN-5's own regex; no caller left. grep `tentative` in huddle src outside calendar-ignore.ts -> comments only. Every calendar reader (huddle.functions.ts:5167, :6746, voice/realtime-tools.server.ts:587, schedule-brief.server.ts:337 which day-schedule reads through) goes through getOwnerCalendarEvents/getGraphCalendarEvents, both of which apply isIgnoredByRules exactly once. prioritize does not read the calendar. CONFIRMED (AC-22/34).
- NO ADDRESSES TO MODEL CONTEXT: publicCalendarEvent strips `categories` and `attendees` on both paths (V5 proves the guard); returned fields = pre-change fields. ownerEmails only enter the rules object. CONFIRMED (AC-30).
- PORT FIDELITY (read side by side): otherPeople / cleanEmail / hasIgnoredCategory / title-contains / graphAttendees match journey meetings.ts:81-157 and calendar-ignore.ts:41-68; only difference: Huddle de-duplicates phrases (no verdict effect). CONFIRMED.
- MINOR (Tier 3, not a defect): calendar-ignore.ts:7-8 header says graph-email isIgnoredCalendarEvent "is now a thin wrapper over this module" -- it was REMOVED, not wrapped. Stale provenance line.
- NOT-VERIFIABLE-HERE: AC-11, AC-26, AC-27, AC-28 (need deploy + live reads); AC-29 (schedule-brief T-60 test needs pg); onedrive-feed.test.ts sections H1/I1 (never executed in this sandbox, before or after the change).
- BEHAVIOUR CHANGES beyond option A: only the no-caller path now drops tentative GROUP invites instead of every tentative -- this is the owner-decided G-1 fallback (journey default), so within approved scope. Graph `$select` gains categories,attendees (larger payload, no visible change). No other found.

VERDICT: PASS (0 defects; 1 stale comment; live ACs and onedrive H/I not reached here -- NOT YET live-verified)
