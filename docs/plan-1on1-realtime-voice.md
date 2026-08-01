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

**Decision: primary = journey's OpenAI-Realtime approach.** Reason (same-brain, extend-don't-duplicate):
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

## HARD REQUIREMENT — full tool parity for EVERY agent (user: "flex and all agents should have tools
## and everything else iris has")
Ground-truth: `runAgentTurn` already builds `mergedTools` (huddle.functions.ts:1916) UNCONDITIONALLY
for every agent — create_huddle_task, artifacts, delegate, flag-blocker, confirm-intent, reminders,
**prioritize**, + RAG memory + journey-proxy tools (calendar/schedule/send_push/…) + web search. The
only per-agent variance is `snapshotTools` (file_search KNOWLEDGE BASES — Flex has none; that's data,
not a capability tier) and grooming (Terry-exclusive by the ownership model). So "everything Iris has"
= this base suite, which every agent already gets in TEXT.
**The realtime voice session MUST inject this SAME per-agent `mergedTools` assembly** (via the extracted
shared builder) so a voice reply from Flex has identical tool access to a voice reply from Iris. Verify
parity explicitly: the SAME tool call succeeds for Flex-by-voice, Iris-by-voice, and Iris-by-text.
(File_search KBs and Terry's grooming stay as-is — deliberate data/ownership, not a parity gap. If the
user later wants Flex to also have a knowledge base, that's a separate additive data change.)

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
