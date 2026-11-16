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
