# UAT plan — Approach A (Fast: OpenAI Realtime speaks directly), batch-of-agents daily use

Goal: before the user touches it, prove the Fast (A) 1:1 voice path holds up across a BATCH of agents
over a realistic day, and catch the **poor-response failure modes** the user might hit. Verified by the
independent `verifier` subagent against the DEPLOYED app, with **screenshot proof logged per step**.

## Why headless + why typed-drive
The CCR session/subagent egress can't reach `*.azurestaticapps.net`, so UAT runs on a **GH runner**
(open internet) via Playwright (fake mic). We start the Fast (A) voice call (mic connects) then drive
each turn by **typing** into the Chat tab (`sendText` injects a user turn and the model speaks the
reply) — this exercises the SAME realtime speak+tool path without needing real speech, so it's
deterministic and CI-able. Real-speech STT + subjective feel remain a human live check (flagged).

## Setup
- Load `?uat_token=$UAT_BYPASS_TOKEN&huddle=dm-<agent>`; seed
  `localStorage["huddle-voice-engine"] = {"state":{"mode":"realtime-speak"},"version":0}`; **reload**
  (a hash nav won't re-init past the gate); start the voice call; wait for `status=connected`.
- Screenshot at each step → uploaded as a workflow artifact (viewable) AND each screenshot filename +
  observed evidence (reply text, audio bytes, latency ms) logged to the job output.

## The BATCH (covers distinct lanes + tool types + governance)
| Agent | Daily ask (typed) | Expects | Failure mode it catches |
|---|---|---|---|
| iris-chase (EA) | "What's on my schedule today?" | spoken reply using calendar tool data | tool not firing / wrong data / "I can't do that" |
| finn-reid (finance) | "How's my runway looking?" | finance-lane spoken reply | wrong-lane / empty |
| flex-grimes (fitness) | "Give me a quick workout for today." | fitness spoken reply, tools intact | the ORIGINAL complaint agent — regression check |
| troy-lennox (travel) | "Any trips coming up on my calendar?" | calendar tool → spoken | tool parity across agents |
| terry-locke (scrum, owns grooming) | "What should I prioritize?" | prioritize tool → spoken | governance/owner tool present |
| charleston-lewis (dining) | "Suggest dinner tonight." | dining spoken reply | lane coverage |

## Acceptance criteria per agent (binary, from observable evidence)
For EACH agent in the batch:
- **AC-connect:** voice call reaches `status=connected` (getRealtimeSession ok + SDP 201). Screenshot.
- **AC-speaks:** after the typed ask, the remote WebRTC audio track receives bytes (`getStats`
  inbound-rtp audio `bytesReceived > 0`) AND a non-empty agent reply transcript is rendered. Screenshot.
- **AC-not-poor:** the reply is NON-EMPTY and is NOT a refusal/"I can't/no idea how" string and NOT an
  error toast. (This is the core "poor response" guard.) Screenshot of the rendered reply.
- **AC-latency:** time from send → first audio/reply logged; flag if > 4s (soft — recorded, not a hard
  fail, since runner latency ≠ user latency).
- **AC-tool (schedule/priorities/travel asks):** the `[realtime-speak] tool <name> <ms>ms` log appears
  AND the spoken reply reflects real data (not a hallucinated "I don't have access"). Screenshot + log.

## Cross-cutting checks
- **AC-regression:** with the toggle back to Baseline for ONE agent, the current path still connects
  (proves reversibility / baseline intact). Screenshot.
- **AC-no-dupe:** each turn renders exactly one user + one agent bubble in the dm-<agent> thread.
- **AC-error-surfaced:** if any agent errors, a visible error is shown (not a silent dead call).

## Poor-response taxonomy the UAT explicitly flags (per agent, logged + screenshotted)
1. **Silent** — connected but no audio bytes / no reply transcript within the wait window.
2. **Refusal/incapable** — reply matches /can't|cannot|no idea|don't know how|not able|as an AI/.
3. **Empty/too-short** — reply < 2 words.
4. **Tool-dead** — a tool ask returns no tool log or the reply says it lacks access.
5. **Error** — an error toast / status=error.
6. **Slow** — send→reply > 4s (recorded).

## Output / proof
- Workflow uploads `uat-shots/*.png` (one per step per agent) as an artifact — the screenshot proof.
- Job log prints, per agent: connected?, audioBytes, replyText (truncated), toolLog?, latencyMs, and a
  PASS/FAIL against the taxonomy. Final line: `UAT SUMMARY: <n>/<m> agents PASS`.
- The `verifier` subagent reads the log, confirms the screenshot artifact was produced (count > 0),
  and independently judges each agent PASS/FAIL from the logged evidence — reporting only observed facts.

## Not covered here (explicit)
Real-speech STT accuracy, subjective turn-taking/barge feel, and whether the OpenAI voices sound good —
those are the human live A/B. This UAT proves the MECHANISM holds across the batch and surfaces poor
responses before the user spends time.
