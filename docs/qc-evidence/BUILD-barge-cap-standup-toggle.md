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
- [x] Piece 1: barge cap — commit `a673b972`
- [x] Piece 2: stand-up toggle — commit `66043785` (+ tsc type fix)
- [x] Suites / tsc / build

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

## Piece 1 — barge cap (commit a673b972)

**Change.** `src/features/huddle/lib/turn-deadline.ts` (new): `TURN_DEADLINE_MS = 36_000`,
`BARGE_TURN_DEADLINE_MS = 25_000`, `turnDeadlineMs()`, `agentBudgetMs()`. `huddle.functions.ts`
`runHuddleTurn` now takes `deadlineMs` from `turnDeadlineMs({chunked, chunkBudgetMs, ceremonyBarge})`,
and `runBounded`'s per-agent budget from `agentBudgetMs(...)` (a barge never takes the 40s 1:1
allowance; no client sends a 1:1 barge today, so this is belt-and-braces). Chunked turns unchanged (30s).
Client (`MeetingBar.tsx`) unchanged.

**Test.** `bun scripts/barge-deadline.test.ts` (`npm run test:barge-deadline`): 13 passed, 0 failed.
D10 reads the client's 30s timer from `MeetingBar.tsx` and asserts the server cap is below it.

**Mutation proofs (mutate.sh, exit codes read):**

| mutation | named test | verdict | exit |
|---|---|---|---|
| `turnDeadlineMs` returns 36s for barges too | D1 | FIRED (control EQUIVALENT) | 0 |
| `agentBudgetMs` drops the barge branch (1:1 barge gets 40s) | D7 | FIRED (control EQUIVALENT) | 0 |
| `runHuddleTurn` passes `ceremonyBarge: false` | D11 | FIRED (control EQUIVALENT) | 0 |

### What the user hears when a barge hits the 25s cap (code read, not live-observed)

```
t=0     barge sent (sync sendHuddleMessage, scope "group", no turnId)
        meanwhile: client narration loop voices ONE cue per real tool START
        (e.g. tavily -> "Let me look that up.", create_artifact -> "Writing that up.")
t=25s   runBounded timer fires -> controller.abort() on the agent's model call
        -> resolves {outcome:{kind:"skip", timedOut:true}, toolUses: dispatched creates only}
        mergeAgentResult: skip + not chunked -> NOT re-queued, no reply
        group-wave loop: past deadline -> any other queued agent gets a "deferred (deadline)" fallback
        ensureNotSilentOnRealWork(): adds a reply ONLY if toolUses has an ok non-catalog entry
        -> server returns {replies: [] (usually), fallbacks: ["response timed out — deferred"]}
t~25s+  client receives it inside its 30s race -> res.replies[0] is undefined
        -> D (F12) client backstop (MeetingBar.tsx ~1113-1136): bargeFallbackAck()
           spoken in the addressed agent's cloned voice, then the frozen speaker resumes
```

So the user hears a **templated acknowledgement, not silence**, picked at random from
(`MeetingBar.tsx` `bargeFallbackAck`, lines 258-266):
- "Got it — I'm on that. I'll bring you the result right after we wrap."
- "Heard you — I'll pull that together and follow up right after the stand-up."
- "On it — I'll get that to you the moment we finish here."
- "Understood — I'll run that down and surface it right after we wrap up."

Exception: if the timed-out attempt had already dispatched a board-task create
(`dispatchedToolUses`, create-task-core.ts:389), `ensureNotSilentOnRealWork` makes a real reply:
"<summary> — I ran out of time to reply in full, but that went through. Let me know if you want more
detail." and THAT is voiced instead.

Honesty gap (reported, NOT changed — owner did not approve a fallback change): the ack promises a
follow-up "after we wrap", but a timed-out sync barge is not re-queued and no worker turn is created
(the aborted attempt's work is cancelled), so nothing delivers that follow-up.

Edge: the 25s is measured from `turnStartMs`, which includes pre-agent work (routing, memory);
`runBounded` keeps a 2s floor, so a turn whose pre-agent work took >23s could still run to ~25s+2s.
Still inside the client's 30s.

## Piece 2 — "Automatic stand-up" toggle (commit 66043785)

**Extends the existing scheduling config, no new store.** `JobCadence.enabled?: boolean` in
`identity.scheduling_config.overrides` (omitted = on = today's behaviour for every user and job).
- `scheduling-config.server.ts`: `isJobEnabled()`, pure `withJobEnabled()` (keeps the user's hours/days;
  switching ON drops the flag and removes the override if what is left equals the default), and
  `setJobEnabled(email, key, enabled)` (server-side read-modify-write).
- `scheduling-config.functions.ts`: `setMyJobEnabledFn({caller, job, enabled})`, caller-scoped exactly
  like `getMySchedulingConfigFn`/`setMySchedulingConfigFn`. `CadenceInput` now accepts `enabled`, so a
  Settings → Scheduling save no longer strips it (without this, any Settings save would switch the
  stand-up back on). `OverridesInput` exported for the test.
- `scheduler.server.ts` `runDueScheduledJobs`: after advancing next_run_at, `if (!isJobEnabled(cadence))
  continue;` — the job is not fired and not counted. Generic: any job turned off is honoured.
- `HuddleView.tsx` Meeting menu: checkbox item "Automatic stand-up (daily 8:00)" + On/Off, loaded from
  `getMySchedulingConfigFn` each time the menu opens; disabled until loaded. Menu width w-56 -> w-64 so the
  label fits. "Daily stand-up" (manual start) unchanged.
- `SchedulingPanel.tsx`: one extra muted line when a job is switched off.
- `auto-job-label.ts` (new): the label text from the effective cadence.

**Test.** `bun test scripts/standup-toggle.test.ts` (`npm run test:standup-toggle`): 10 pass, 0 fail.
Fake pg pool + mocked job store; the real `scheduling-config.server.ts` SQL paths and the real
`runDueScheduledJobs` run.

| mutation | named test | verdict | exit |
|---|---|---|---|
| delete the scheduler skip guard | T3 | FIRED (control EQUIVALENT) | 0 |
| `isJobEnabled` always true | T3 | FIRED (control EQUIVALENT) | 0 |
| drop `enabled` from the Settings validator | T7 | FIRED (control EQUIVALENT) | 0 |

**Known limits (not changed):**
- Fail-open: if the config read fails, `resolveJobCadence` returns the default (on), so a DB blip
  can let one 8:00 digest through. Same as every other cadence today.
- Settings → Scheduling "reset to default" on the stand-up row clears the override, which switches it
  back on.
- journey's own `ceremony_occurrences` stand-up reminder (12:00 ET, `auto_run=false`, no LLM) and
  journey's digest content pull (`run-standup` with `deliver:false`) do not read this flag.

## Suites / tsc / build (branch 66043785 + type fix)

| check | result |
|---|---|
| `npx tsc --noEmit` | rc=0 |
| `npm run build` | rc=0 |
| barge-deadline | 13 passed, 0 failed |
| standup-toggle | 10 pass, 0 fail |
| scheduler-one-user | 7 passed, 0 failed |
| priority-check | 47 passed, 0 failed |
| schedule-brief-dedupe | 21 passed, 0 failed |
| inbound-email | 72 passed, 0 failed |
| confirm-reask-rotation | ALL PASS |
| meeting-triage-server | 7 passed, 0 failed |
| barge-route | 10 passed, 0 failed |
| cross-app-turn-gate | 92 passed, 0 failed |
| router-winners | 39 passed, 0 failed |
| fireflies-minutes | 72 PASS / 3 FAIL (G3, G5, G8) — **identical on origin/main c1ea08ef** (git archive copy) |
