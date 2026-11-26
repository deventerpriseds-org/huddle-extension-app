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
