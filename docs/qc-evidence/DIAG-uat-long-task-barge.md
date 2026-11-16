# DIAG — UAT "Voice barge (4-long-task)" returns reply=""

<!--
WHAT:       Root-cause diagnosis of the intermittent verify-uat failure on the 4-long-task voice barge.
WHY:        Same commit 132c2fc passed (run 43778338023) then failed (43779327711); fe495ec failed (43780744770).
SUPERSEDES: nothing
SUPERSEDED-BY: nothing -- current
EVIDENCE:   verify-uat job logs 133009656926 (pass), 133012711718 (fail), 133017130718 (fail); sections below.
-->

Report only. No code on main was changed by this diagnosis.

## Finding 1 — "" is a 45s harness TIMEOUT, not an empty agent reply

**Source:** `.claude/skills/test-agent-serverfn/scripts/huddle-checks.mjs` `voiceBarge()` (lines 86-119).

- It counts rows `[data-testid="transcript-turn"][data-turn-agent="true"][data-turn-kind="answer"]`
  before playing the clip, then `waitForFunction` for BOTH a new user barge row AND a new answer row,
  `timeout: 45000`. On timeout it swallows the error, waits 1.2s, and reads `answers[answersBefore] || ""`.
- So `reply=""` means **no new answer row existed 46.2s after the clip started**. It cannot distinguish
  "agent replied nothing" from "agent replied late".

**Observed timings (check-line timestamps in the job logs):**

| run (job) | 3-quick check | 4-long-task check | gap | outcome |
|---|---|---|---|---|
| 43778338023 (133009656926) PASS | 00:07:45.88 | 00:08:22.57 | **36.7s** | answer row at ceremony clock 01:17 (3-quick was 00:40 → ~37s) |
| 43779327711 (133012711718) FAIL | 00:17:58.03 | 00:18:51.25 | **53.2s** | reply="" |
| 43780744770 (133017130718) FAIL | 00:32:20.00 | 00:33:13.38 | **53.4s** | reply="" |

53.2/53.4s = 2.5s post-answer settle + TTS fetch + clip play + **45s timeout** + 1.2s. Both failures hit
the ceiling exactly. The passing run's answer itself took ~30s+ after the clip — i.e. the long-task
barge was already running at ~2/3 of the harness budget when it passed.

Also: the ceremony completed normally in all three runs (44-45 turns, ~350-360s), so the room did not
freeze; the long-task barge simply answered after the harness stopped looking (or not at all —
settled by the DB rows in Finding 2).

## Finding 2 — what the backend did (chat.ceremony_transcript, azure-pg-query run 43782390954)

**The client gives up at 30s and drops the answer silently.** `MeetingBar.tsx` `runBargeSequence`
(lines 1037-1058) races the synchronous `sendHuddleMessage({ceremonyBarge:true})` against a
**30_000ms** client timer. On timeout the `catch` (1155-1171) resumes the frozen speaker and returns:
no `answer` row, no `barge_route` row, and no fallback ack (the D/F12 backstop at 1113-1136 only
covers an EMPTY reply that arrives in time). The server's own sync-path deadline is
`TURN_DEADLINE_MS = 36_000` (`huddle.functions.ts:756`), so a turn finishing between ~30s and 36s
completes on the server but is thrown away by the client.

**`barge_route` is the marker.** It is written by the client only AFTER the server reply arrives
(MeetingBar 1077-1091). Present means the reply came back inside 30s. Absent means the client timed out.

Long-task barge, offsets from the user's `barge` row `ts` (client clock), kinds/tools/timings only:

| run | barge ts | tool sequence (offset) | barge_route | answer | verdict |
|---|---|---|---|---|---|
| PASS bd4804bf (00:07) | 00:07:53.806 | tavily x2 start +12.7s, **both fail 432** · delegate_to_specialist +23.3s ok | **+26.8s** | +27.5s (4 sentences) | inside 30s |
| FAIL 8af57c17 (00:17) | 00:18:05.969 | tavily start +8.9s, **fail 432** · create_artifact start **+31.8s**, ok +32.0s | **none** | none | server still working at +31.8s; client gave up at +30s |
| FAIL 125152d2 (00:32) | 00:32:28.453 | tavily x3 start +9.1s, **all fail 432** · search_memory +14.2s ok · nothing after | **none** | none | no reply inside 30s |

Supporting rows:
- PASS's delegation created the durable worker turn `worker-orc…` in `chat.pending_turns` at
  00:08:17.074 (done 00:09:38) and its follow-up `integrate-…` at 00:09:39. The failing runs have no
  worker turn: they never delegated.
- The other three barges in every run (hail ack, park via get_tasks, quick question) answered in
  0.2-9s, with a `barge_route` row each time.
- All 3 runs reached the 4-long-task barge at the same point (barge seq 26-27), so the harness
  sequence is identical. Only the long-task branch differs.

**Tavily 432 in every run, including the pass.** Error text prefix: `Tavily API error 432:
{"detail":{"error":"This request excee…` (Tavily's plan/usage-limit response). The research tool is
dead, so the model improvises after the first failed search. Which improvisation it picks is
nondeterministic:
- delegate (fast handoff, about 23s in, passes)
- write the brief itself with `create_artifact` (the artifact body is generated as tool arguments,
  ~22.7s of generation between +9s and +31.8s; fails)
- retry search plus memory, then keep going (fails)

## Finding 3 — 132c2fc / correspondence ingest is NOT on this path

- **Same build, different outcome.** deploy-swa 43778083483 put 132c2fc live at 00:04:41. The PASS run
  (00:05:54) and FAIL run 1 (00:15:56) both ran against that same build. A deterministic code change
  cannot pass and then fail on the same build. It can only make the race more likely.
- **The barge does not run in the heartbeat.** It is a synchronous `sendHuddleMessage` HTTP call
  (MeetingBar: "Kept SYNCHRONOUS (no turnId ⇒ non-durable)"). The heartbeat (`/api/public/run-turn`)
  runs `drainQueuedTurns`, `fireDueReminders` and `runDueScheduledJobs` concurrently
  (`Promise.all`). Correspondence ingest is started inside `runDueScheduledJobs` and runs alongside
  them. So the ingest does not run BEFORE durable turns, and it shares no time budget with the barge
  request in any case.
- **The ingest is idle work.** `chat.correspondence_ledger` holds email n=138 and teams n=149, all
  `pending` and all first written 00:05:04-00:05:31, the first tick after deploy. Nothing has been
  processed since, because the bell and proposals processors are off. `correspondence_cursor.checked_at`
  is 00:38 for both sources, so later ticks are throttled or unchanged eTag reads.
- **The failing runs were not slower to start.** Barge to first tool call took 8.9s and 9.1s in the
  two failures versus 12.7s in the pass. There is no sign of a starved event loop or slow PG. The time
  went into the model's post-Tavily branch.
- **`build_checklist` proposals param:** gated by `proposalsConfig() !== null`. Proposals are OFF, so
  the schema offered is the same as before 132c2fc. `build_checklist` was never called in any of the 3
  runs.
