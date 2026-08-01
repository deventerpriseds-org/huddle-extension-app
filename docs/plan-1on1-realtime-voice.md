# Plan: journey-speed 1:1 voice — OpenAI Realtime speaks directly (same brain)

Status: PLANNED — 2026-08-01. Supersedes the voice half of `plan-1on1-token-streaming.md` for the
LATENCY complaint. (Text token-streaming remains a separate, lower-priority nicety.)

## The experience the user asked for (ground-truthed, verbatim)
> "the delay for my convo with Flex to **speak** takes way too long. much longer than the journey app."
> "the settings should match journey or the coach in the boost app which has a good natural experience."

So: **voice** latency. When the user talks to an agent in a 1:1, the agent must start speaking fast,
like journey. User chose (AskUserQuestion, 2026-08-01): **"Realtime speaks directly."**

## Why today is slow (measured architecture, not guess)
Current 1:1 voice = `useVoiceCallRealtime` + `useCeremonyVoice`:
1. OpenAI Realtime WebRTC is **ears-only** — `create_response:false`, remote audio track **muted**
   (`e.track.enabled=false`). It does VAD + STT and nothing else.
2. The transcript is sent through `enqueueHuddleTurn` → the full durable **Responses** turn (5–10s).
3. The client **polls** `getTurnUpdates` every **2500ms** for the reply text.
4. The reply is then synthesized by **ElevenLabs** TTS (whole reply) before audio starts.
Three stacked delays (Responses turn + poll + full-reply TTS) before the first sound. SWA buffering
(confirmed 2026-08-01) does NOT matter here — the fix is on the WebRTC channel, which is peer-to-peer
browser↔OpenAI and never touches the SWA function response.

## Reference insights — journey vs boost coach (looked at BOTH, per the user)
Two DIFFERENT proven architectures for natural, low-latency voice:
- **journey = OpenAI Realtime** (WebRTC speech-to-speech). YOU inject instructions + RAG memory +
  tool schemas at ephemeral-token mint; tools execute client-side over the data channel via a shared
  executor. `create_response:true` + `interrupt_response:true` = speaks directly + native barge.
  Heavy client (~1000 lines) but the LLM brain is fully under our control.
- **boost coach = ElevenLabs Conversational AI** (`@elevenlabs/client` `Conversation.startSession`).
  FULLY MANAGED (ElevenLabs does STT+LLM+TTS+turn-taking); client is ~15 lines. Brain = an ElevenLabs
  agent config (`conversation_config.agent.prompt` + `llm:gpt-4o-mini` + `first_message`), voice =
  `tts.voice_id`, tools = ElevenLabs server-tools (webhooks). Signed URL minted server-side
  (`/v1/convai/conversation/get-signed-url?agent_id=`). Natural turn-taking = **`turn_v3` +
  `turn_timeout:8`**; native barge; echo-guard in the UI.

## DIRECTIVE (2026-08-01, corrected): build ONLY Approach A; compare against the EXISTING path
The user: "do it in parallel so I can switch between the approaches to test which is performing better,"
then: "stop trying to create ElevenLabs — you already have a version currently in place with the lag,
that is what I will compare against."
So:
- **DO NOT build any ElevenLabs / ConvAI path.** The CURRENT live 1:1 voice path (today's default,
  `useVoiceCallRealtime` = OpenAI Realtime STT → Responses turn → ElevenLabs TTS — the LAGGY one the
  user is complaining about) is the **comparison BASELINE**. It already exists; leave it as-is.
- **Build ONLY Approach A — OpenAI Realtime speaks directly** (journey-style; same brain via session
  mint). This is the new fast path.
- **Runtime switch:** extend the 1:1 voice backend from the build constant `VOICE_1ON1_BACKEND` to a
  USER-facing persisted setting (zustand+localStorage) + a control in the meeting pane, offering:
  `current` (the existing baseline) vs `realtime-speak` (new Approach A) — so the user flips live and
  compares new-fast vs current-laggy without a redeploy. (The existing ElevenLabs ConvAI orb
  `useVoiceCall` stays available but is NOT the focus.)
- **Delivery:** one path to build (A) + the runtime switch; deploy → user A/B's A vs the current path.

### Tool-latency + reversibility (user guidance 2026-08-01)
User: "the execute-tool approach in journey is slow; if it's too slow in this new build we will need to
switch back." Design consequences (hard):
- **Do NOT copy journey's `execute-tool` architecture** (a separate edge-function hop + cold start =
  the slowness). Approach A's executor runs the tool **directly in-process in ONE Huddle server-fn hop**,
  calling the SAME modules the text turn uses (`invokeJourneyTool`, `tavilySearch`, task/reminder/
  prioritize fns) — no extra dispatch layer. Only tools that inherently proxy to journey carry journey's
  own latency (unavoidable, same as text). So A's tool round-trip should be ≤ journey's, not equal.
- **Instrument the tool round-trip** (ms from `function_call_arguments.done` → `function_call_output`
  sent) and log it, so "too slow" is measured, not guessed. Surface it in the diagnostic.
- **Reversibility is REQUIRED:** the runtime switch must let the user flip back to the baseline
  instantly if A (or its tool latency) underperforms. Keep the baseline path fully intact; A is additive.
- Note: conversational (no-tool) replies have NO tool hop → they get the full ~0.3–0.8s speak-directly
  win regardless; the latency risk is specific to tool-requiring answers.

**A-side decision detail: journey's OpenAI-Realtime approach.** Reason (same-brain, extend-don't-duplicate):
Huddle has 12+ distinct agents, each a rich snapshot prompt + shared Huddle tools + RAG. OpenAI Realtime
lets us inject the EXACT snapshot + memory + the SAME tool schemas and run tools through the SAME Huddle
executor — one brain. ElevenLabs ConvAI would require a PARALLEL per-agent definition on the ElevenLabs
platform (prompt + webhook tools + a generic non-snapshot LLM) — a second brain to maintain, a real
"duplicate, don't extend" violation, and not truly same-brain.

**Steal from boost regardless of engine:**
1. **Turn-taking as a first-class tunable** — boost's `turn_timeout`/`turn_v3` ≙ tuning our
   `semantic_vad` eagerness (the barge-sensitivity knob the user flagged). Expose + tune it.
2. **Echo guard** — boost's Call.jsx mutes the mic / similarity-filters the user transcript against
   recent agent text while the agent speaks (kills speakerphone self-interruption). Huddle lacks this;
   add it (helps the "he ignores me / false barge" class of issues too).
3. ~~ConvAI fast-path for tool-less agents~~ **DROPPED (user directive 2026-08-01): there are NO
   tool-less agents. Flex and EVERY agent must have the full tool set + everything else Iris has.**
   So a single, uniform OpenAI-Realtime path for all agents — no per-agent engine split.

## HARD REQUIREMENT — same STRUCTURE for every agent, governance intact (user clarification 2026-08-01)
Corrected intent (the user was explicit): this is **NOT** "give Flex every tool flat." Tool/capability
USE remains governed by the **owner / executioner / capability rules** (Terry owns grooming, exclusive
capabilities in `agents.ts` via `lib/capabilities.ts`, etc.). The requirement is that **every agent is
wired through the SAME data-driven STRUCTURE**, because those ownership/capability assignments **can
rotate or be altered at any time** — so the mechanism must be identical for all agents and must
propagate a rotation automatically, with zero per-agent code, to the VOICE path just as it does to text.
This is exactly the repo's standing "Systematic capability, never a patch" / "data-driven ownership" rule.

Ground-truth: `runAgentTurn` already builds `mergedTools` (huddle.functions.ts:1916) through that
governed structure — a base suite EVERY agent gets (create_huddle_task, artifacts, delegate,
flag-blocker, confirm-intent, reminders, **prioritize**, + RAG memory + journey-proxy tools
(calendar/schedule/send_push/…) + web search) PLUS ownership-gated additions (`ownsGrooming ?
GROOM_BACKLOG_TOOL : []`, exclusive capabilities) and per-agent data (`snapshotTools`/file_search KBs).
**The realtime voice session MUST derive each agent's tools from this SAME governed builder** — not a
hand-picked flat list — so: (a) Flex-by-voice has the identical STRUCTURE to Iris-by-voice; (b) what
each can actually USE follows the current ownership/capability DATA; (c) if an owner/capability rotates,
BOTH text and voice change together with no code edit. Verify: the SAME builder feeds text and voice;
an ownership rotation (e.g. move grooming off Terry) flips the tool's presence in BOTH paths for the
new owner and removes it for the old — proving structure-parity, not a flat grant.

## The fix — journey's PROVEN Realtime pattern + boost's turn-tuning & echo-guard insights.
## Reference: journey `RealtimeVoiceAssistant` + `generate-realtime-token`; boost `Call.jsx` +
## `appConvai.ts`. "Extend, don't duplicate."
Let the OpenAI Realtime session GENERATE the spoken reply and stream it over the ALREADY-OPEN WebRTC
audio track. Same brain is preserved by baking the agent's instructions + memory + tools + voice into
the session at ephemeral-token-mint time, exactly as journey does. Tool calls come back over the data
channel and are executed by the SAME executors the text turn uses.

journey's session mint (the blueprint), from `generate-realtime-token/index.ts`:
```
session: {
  type: "realtime", model: <realtime model>,
  output_modalities: ["audio"],                 // native voice (ElevenLabs path = ["text"])
  audio: {
    input:  { transcription:{...}, turn_detection:{ type:"semantic_vad", eagerness:"medium",
                                                    create_response:true, interrupt_response:true } },
    output: { voice: <perAgentVoice> },
  },
  tool_choice: "auto",
  tools: <agent tool schemas>,
  instructions: <core + personalization + RAG memory>,   // == same brain
}
```
`create_response:true` + `interrupt_response:true` = the model speaks directly AND barge is native.

## Performance expectation
- Today: ~5–10s (Responses) + ≤2.5s (poll) + full-reply ElevenLabs TTS before first sound.
- After: **~0.3–0.8s to first audio** (Realtime streams speech as it generates), native barge-in.
  A tool-using reply adds one tool round-trip (~0.5–1.5s) BEFORE the spoken answer — still far below
  today, and identical to journey's behavior.

## Same-brain parity — the mapping (journey → Huddle)
| journey | Huddle |
|---|---|
| `generate-realtime-token` bakes instructions+memory+tools+voice | **extend `getRealtimeSession`** to accept `{agentId, caller, huddleId}` and assemble the same session body (reuse the snapshot-instruction + house-style + `searchChunks` memory assembly the text path uses; the agent's tool schemas; a per-agent OpenAI voice) |
| `execute-tool` edge fn (one executor for chat+voice+phone) | **extract** `runAgentTurn`'s inline tool-dispatch switch into a shared `executeAgentTool(name,args,{agentId,caller,huddleId})` module; `runAgentTurn` calls it (no behavior change) AND a new realtime tool-executor server fn calls it → true parity, no fork |
| `RealtimeVoiceAssistant` unmute + function_call + transcript | **new reply mode in `useCeremonyVoice`** (additive, flag-gated): unmute remote track, session minted with create_response:true, handle `response.function_call_arguments.done` → server executor → `function_call_output` + `response.create`, capture `response.audio_transcript.done` → write reply to the `dm-<agent>` store (transcript unification kept) |
| ttsProvider flag | reuse the existing `VOICE_1ON1_BACKEND` flag pattern — add `"realtime"` mode; ElevenLabs/Responses path stays as reversible fallback |

## Voice identity (decided, reversible)
Fast path uses OpenAI Realtime voices, not the ElevenLabs cloned voices. To keep agents DISTINCT,
map each agent → a distinct OpenAI voice (alloy/ash/ballad/coral/echo/sage/shimmer/verse/cedar/marin)
in `agents.ts` data (not hardcoded per-agent logic). Agents still sound different, just not their
current cloned voices. ElevenLabs remains the fallback via the flag, so this is reversible if the user
dislikes the new voices after a live listen.

## Ordered implementation (file-by-file)
1. `lib/voice/agent-voice.ts` (or a field in `agents.ts`) — data-driven agent→OpenAI-voice map.
2. `lib/huddle.functions.ts` — extract the tool-dispatch switch (~line 2200–2400) into an exported
   `executeAgentTool(name, args, ctx)` used by `runAgentTurn` unchanged. Also export a reusable
   `assembleAgentInstructions(agentId, {memory})` from the existing snapshot+house-style+memory build.
3. `lib/voice/realtime.functions.ts` — extend `getRealtimeSession({agentId,caller,huddleId})` to POST
   the full session body (instructions+memory+tools+voice+create_response:true). Back-compat: no
   agentId → today's minimal ears-only mint (ceremony/group unaffected).
4. `routes/api/public/realtime-tool.ts` (or a server fn) — thin auth'd wrapper calling
   `executeAgentTool` for the realtime data-channel tool-calls.
5. `hooks/useCeremonyVoice.ts` — additive `replyMode:"realtime"` path: unmute track, handle
   function_call + audio_transcript events, response.create after tool output. `create_response:false`
   ears-only path stays the DEFAULT for group ceremonies (unchanged).
6. `hooks/useVoiceCallRealtime.ts` — when realtime reply mode is on, DON'T enqueue a Responses turn;
   the reply comes from the WebRTC channel. Still write user + agent transcript to the store.
7. `components/MeetingBar.tsx` — flip the 1:1 voice path to the realtime reply mode via the flag.
8. **(boost insight) Turn-taking tuning** — expose the `semantic_vad` eagerness (and any turn-timeout
   equivalent) as a tunable rather than a buried constant; set a natural default matched to journey/
   boost feel. This is the barge-sensitivity knob the user flagged.
9. **(boost insight) Echo guard** — while the agent's audio is playing, mute the mic OR similarity-
   filter the incoming user transcript against the recent agent text (boost's Call.jsx pattern) so the
   agent never barges on its own voice through the speaker. Reduces false barges / "he ignores me".

## Backward-compat / blast radius
Group ceremony voice keeps the ears-only + our-engine path (create_response stays false there).
Text chat turns untouched. `executeAgentTool` extraction is a pure refactor (same executors). The
realtime reply mode is flag-gated and reversible to the ElevenLabs/Responses path.

## Risks (and mitigations) — the "first shot" checklist
- **Tool parity drift** → mitigated by the SHARED executor (not a fork). Verify the same tool call
  (e.g. `get_calendar_events`) returns identical output via both paths.
- **Instruction/brain drift** → reuse the exact snapshot+house-style+memory assembly; don't rewrite.
- **Voice-identity regression** → distinct OpenAI voices + reversible flag; confirm live.
- **Barge** → native (`interrupt_response:true`); the existing manual freeze/resume becomes redundant
  on this path (keep for the fallback path).
- **Auth/secret** → the realtime-tool route reuses caller identity + existing tokens; NO new secret.
- **Cost** → Realtime audio is pricier per minute than text; acceptable for the 1:1 voice UX. Note it.

## Verification (before claiming anything)
- tsc + build clean.
- Shared-executor parity: unit/one-shot call `executeAgentTool("get_calendar_events",…)` == the text
  path's result.
- Headless diagnostic (extend `voice-1on1-diagnostic`): after connect, assert an
  `response.audio_transcript.delta`/`.done` arrives and the remote track is UNMUTED and receiving
  audio (bytes > 0) — i.e. the model actually spoke — within ~2s of the (fake) utterance.
- Live: the user talks to Flex and hears a reply start in <1s; asks Iris for the schedule in voice and
  gets the SAME answer as text chat (same-brain, tools work). Only THEN mark done.
```

---

## Acceptance Criteria (independent author, 2026-08-01) — build spec
Observation channels: DIAG = GH-runner headless diagnostic (extend `voice-1on1-diagnostic.e2e.mjs`;
CCR egress can't reach the SWA); PG = `azure-pg-query.yml`; CODE = static trace; HUMAN = live retest only.

**A. Latency & audio**
1. No-tool reply: first audio-delta arrives ≤1.5s after end-of-turn. (DIAG/HUMAN)
2. Audio streams as ≥2 delta events then a done (not one blob). (DIAG)
3. Remote WebRTC track UNMUTED (enabled=true) and inbound-rtp bytesReceived>0 while speaking. (DIAG getStats)
4. Tool reply: audio begins after the tool round-trip, still streams. (DIAG/HUMAN)

**B. Same brain — instructions & memory**
5. Mint's `instructions` contains the agent's verbatim snapshot prompt (not thin). (CODE/DIAG)
6. Auto-retrieved RAG memory (same searchChunks/embed as text) present in session instructions. (CODE/HUMAN)
7. Voice & text call the SAME `assembleAgentInstructions` builder. (CODE)

**C. Same brain — STRUCTURE parity via the governed builder (hard requirement, corrected)**
8. For a given agent, the minted `tools` == exactly what the SAME governed `mergedTools` builder yields
   for that agent (base suite + ownership-gated additions + its snapshot/KB data) — derived, not a
   hand-picked flat list. (CODE)
9. Flex and Iris go through the IDENTICAL builder/structure; their minted toolsets differ ONLY where the
   ownership/capability DATA differs (e.g. grooming for the current owner, per-agent KBs) — not by any
   per-agent code branch. (CODE)
10. Ownership rotation propagates: reassigning an exclusive capability (e.g. grooming) in the data flips
    that tool's presence in BOTH the text mergedTools AND the voice mint for the new owner, and removes
    it from the old — with no code change. (CODE, before/after the data change)
11. A tool the agent IS entitled to use → mid-call function_call → shared executor → function_call_output
    → response.create → spoken answer uses REAL data. A tool it is NOT entitled to (ownership-gated) is
    absent from its session, exactly as in text. (DIAG/HUMAN/CODE)

**D. Shared executor not a fork**
12. Both text engine & realtime-tool fn call one `executeAgentTool(name,args,ctx)`. (CODE)
13. Text turn behavior unchanged pre/post refactor. (CODE/PG)
14. Realtime tool fn enforces caller email-scope (A never sees B's data). (CODE, adversarial)

**E. Transcript unification**
15. Both user utterance + agent reply written to `dm-<agent>` store, once each. (PG/DIAG)
16. Realtime mode SKIPS the old enqueueHuddleTurn+poll → no duplicate reply row. (CODE/PG)

**F. Barge / echo / turn-taking**
17. User speech mid-reply → native interrupt cancels; audio stops promptly. (DIAG/HUMAN)
18. Agent doesn't self-barge on its own speaker output (echo guard). (DIAG/HUMAN-real-speakerphone)
19. Natural end-of-turn: doesn't talk over user, doesn't idle. (HUMAN; DIAG confirms config accepted)
20. semantic_vad eagerness / turn-timeout is a NAMED tunable, not a buried literal. (CODE)

**G. Voice identity**
21. Per-agent OpenAI voice is DATA-driven (agents.ts), audibly distinct. (CODE/DIAG/HUMAN)

**H. Regression guards**
22. GROUP ceremony voice unchanged (ears-only, track muted, engine+ElevenLabs). (CODE/DIAG)
23. `getRealtimeSession` with NO agentId → today's minimal ears-only mint. (CODE/DIAG)
24. Plain text chat turn unchanged. (CODE/PG)
25. Flag revert to ElevenLabs/Responses restores the old path (reversible). (CODE/DIAG)
26. NO new org secret. (CODE/workflow review)

**I. Build**
27. tsc --noEmit zero errors. 28. production build succeeds.

**J. Error/degradation**
29. Mint failure → visible error, never a silent dead mic. (DIAG)
30. 429/quota surfaced, not swallowed. (DIAG/CODE)
31. Data channel dies → visible error/disconnected state, not stuck "connected". (DIAG)

**HUMAN-only (mechanism-proof ≠ live confirmation):** AC-1,4,11,17 (real speech), 18 (real speakerphone),
19 (turn feel), 21 (voices sound acceptable). Mark PARTIAL until the user retests live.
