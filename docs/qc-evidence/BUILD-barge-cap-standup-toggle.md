# BUILD — barge 25s server cap + "Automatic stand-up" toggle

<!--
WHAT:       Build log for two owner-approved changes: (1) ceremony barge server deadline 36s -> 25s,
            (2) an on/off toggle for the daily automatic stand-up in the Meetings menu.
WHY:        Owner 2026-11-16: "use your 25 second server option offered and toggle off the automatic
            stand-ups from the meetings menu where I can always toggle or kick one off manually, my hope
            is this will cut down in the usage of cost resources". Root cause for (1):
            docs/qc-evidence/DIAG-uat-long-task-barge.md (branch claude_diag-uat-long-task-barge) --
            client abandons a barge at 30s, server allowed 36s, so a 30-36s answer was thrown away.
SUPERSEDES: nothing
SUPERSEDED-BY: nothing -- current
EVIDENCE:   branch claude_barge-cap-standup-toggle; sections below.
-->

Branch `claude_barge-cap-standup-toggle`, cut from origin/main `c1ea08ef`. Not merged, no PR.

## Progress

- [x] Read the DIAG evidence and the code paths (below).
- [ ] Piece 1: barge cap
- [ ] Piece 2: stand-up toggle
- [ ] Suites / tsc / build

## Fact finding

### Barge path (code read 2026-11-16)
- Client: `MeetingBar.tsx` `runBargeSequence` races `sendHuddleMessage({scope:"group", ceremonyBarge:true})`
  (no turnId = synchronous, not chunked) against a 30_000ms timer (lines ~1037-1058).
- Server: `huddle.functions.ts` `runHuddleTurn` picked `deadlineMs = chunked ? 30_000 : 36_000`; barges
  were not distinguished. `runBounded` bounds each agent at `max(2_000, budget - elapsed)`.

### Automatic stand-up (code read 2026-11-16)
- Huddle scheduler (`scheduler.server.ts`) row `standup` -> job_type `standup-digest` -> POST
  `/api/public/run-standup` -> `runScheduledStandup` (standup.server.ts). Default cadence 8:00 ET
  (`SCHEDULING_DEFAULTS.standup`). Cost per fire: several Azure PG reads (board, blockers, artifacts,
  engagement) and, unless the change-gate finds nothing new, ONE durable LLM turn for Terry in
  `dm-terry-locke` (router gpt-4o-mini + Terry's model) plus a phone push. No voice/TTS.
- journey side: `public.ceremony_occurrences` (journey `run-scheduled-ceremonies`) has a `standup` row
  at 17:00 UTC with `auto_run=false` -> it only inserts a `ceremony_reminder` notification (no LLM).
  Queried 2026-11-16: standup rows = 5 `reminded`, 1 `pending`, all `auto_run=false`. Not touched here.
- No existing per-job disable: an empty `hours` list falls back to `[8]` in `runDueScheduledJobs`.
