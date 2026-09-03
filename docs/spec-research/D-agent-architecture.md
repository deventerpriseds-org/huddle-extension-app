# D — How Huddle's agents ACTUALLY run today (model / text / voice)

WHAT:       A source-grounded map of the runtime paths a Huddle agent takes to answer a
            typed message and to answer on a voice call, with exact model ids.
WHY:        Repeated re-derivation of "which model / is ConvAI used" from comments and
            filenames. Every claim here carries file:line + verbatim snippet.
EVIDENCE:   repo /home/user/huddle-extension-app @ origin/main 3148bcd
STATUS:     COMPLETE — written incrementally; every section confirmed against source.

Verdict vocabulary: CONFIRMED (read the code) / REFUTED / NOT-FOUND / NOT-VERIFIED.

---

## 1. TEXT path — what actually answers a typed message

### 1.1 Where `agentsCfg` comes from — CLIENT-SIDE zustand, persisted to localStorage

**CONFIRMED.** `agentsCfg` is NOT env, NOT a DB table. It is read off the turn payload the
browser sends, and the browser gets it from a persisted zustand store.

`src/features/huddle/lib/huddle.functions.ts:856`
```ts
  const agentsCfg = data.agents ?? {};
```

`src/features/huddle/lib/huddle.functions.ts:1900`
```ts
    const agentBackend = agentsCfg[nextId] ?? { backend: "lovable" as const };
```

The store: `src/features/huddle/lib/agent-backends.ts` — `useBackendsStore`, zustand + `persist`:
```ts
    {
      name: "huddle-backends",
      storage: createJSONStorage(() =>
        typeof window !== "undefined" ? window.localStorage : (undefined as unknown as Storage),
      ),
```
So config is **per-browser localStorage**, per-agent (`agents: Record<AgentId, AgentBackend>`),
seeded from `defaultBackendsConfig()`, and editable in the Settings UI (see §4).

**Consequence:** the `?? { backend: "lovable" }` at :1900 is a *defensive* fallback for an agent id
absent from the payload — it is NOT the real default for the 15 shipped agents. See 1.2.

### 1.2 The REAL default backend for each of the 15 agents = **openai** (not lovable)

**CONFIRMED.** `defaultAgents()` in `agent-backends.ts` keys off `ASSISTANT_IDS`:
```ts
  for (const a of AGENTS) {
    const id = ASSISTANT_IDS[a.id];
    out[a.id] = id
      ? {
          backend: "openai",
          assistantId: id,
          model: defaultModelFor(a.id),
          ...
      : {
          backend: "lovable",
```
`src/features/huddle/data/assistant-ids.json` contains **all 15** agent ids
(flex-grimes, charleston-lewis, troy-lennox, ezra-miles, faith-hartley, sam-trent, elle-rowan,
cole-blake, tess-sutton, iris-chase, eli-vaughn, liam-kingsley, terry-locke, finn-reid, cam-post),
and `src/features/huddle/data/agents.ts` declares exactly those 15 `id:` entries (lines 80–344).

⇒ **Every one of the 15 agents defaults to `backend: "openai"`.** The Lovable branch is reachable
only for an agent with no assistant id, or by the owner flipping the per-agent Backend dropdown.
NOT-VERIFIED: whether any live browser's persisted config has been flipped to lovable (that is
localStorage state, not source).

### 1.3 The per-agent `model` field is a CEILING, not the model that runs

**CONFIRMED.** `agent-backends.ts`:
```ts
const DEFAULT_AGENT_CEILING = "o3";
function defaultModelFor(_id: AgentId): string {
  return DEFAULT_AGENT_CEILING;
}
```
and the comment above it (a claim, but the code matches): "The per-agent Model setting is the
agent's CEILING (the most capable tier it may auto-escalate to; `withAgentCeilings` reads it as the
cap, and every turn STARTS on Luna and climbs by difficulty toward it".
A `merge()` migration force-set every agent to `o3` once: `if (persistedVersion < 8) { combined.model = "o3"; }`.

### 1.4 Router model default

**CONFIRMED.** `agent-backends.ts` `defaultBackendsConfig()`:
```ts
    router: {
      backend: "openai",
      model: DEFAULT_ROUTER_MODEL.openai,
```
`src/features/huddle/lib/model-catalog.ts:117-120`
```ts
export const DEFAULT_ROUTER_MODEL: Record<RouterBackend, string> = {
  openai: "gpt-5.5",
  lovable: "openai/gpt-5.5",
};
```
⇒ the ROUTER (who-answers decision) runs on **gpt-5.5** by default.

### 1.5 The model that ACTUALLY runs a persona turn — resolved per turn, not the config field

**CONFIRMED.** Chain inside `runHuddleTurn` (`src/features/huddle/lib/huddle.functions.ts`):

1. Base, line **4075**:
```ts
        usedModel = agentBackend.model?.trim() || snapshot?.model || "gpt-5.6-luna";
```
2. Overridden by the difficulty resolver, lines **4087-4092**:
```ts
          const resolved = resolveByDifficulty(
            routed.difficulty ?? 2,
            winner.id,
            effectiveModelPolicy(data.agents, data.modelPolicy),
            { manual: deepManual },
          );
```
   with the Sol spend-gate immediately after (**4095-4098**):
```ts
          if (resolved.needsConfirm && !deepManual) {
            chosenModel = resolved.budgetModel; // never auto-spend Sol without confirm/override
            chosenEffort = "high";
          }
```
3. Handed to the API call, line **4221** inside `personaArgs`, consumed at **4237**
   `persona = await callOpenAIResponses({ ...personaArgs, ... })`:
```ts
        const personaArgs = {
          model: usedModel,
```

The ladder that resolver uses — `src/features/huddle/lib/model-policy.ts:187-192`:
```ts
const DIFF_RUNG: Record<number, { model: string; effort: Effort; deep?: boolean }> = {
  1: { model: "gpt-5.6-luna", effort: "low" },
  2: { model: "gpt-5.6-luna", effort: "high" },
  3: { model: "o3", effort: "high", deep: true },
  4: { model: "o3", effort: "high", deep: true },
};
```
Default per-agent ceiling is `o3` (rank 4, top), so nothing is capped down by default.

⇒ **A normal typed message runs `gpt-5.6-luna` (low or high effort). A router-scored "deep"
message (difficulty 3-4) runs `o3` at high effort.** `gpt-5.6-terra` / `gpt-5.6-sol` are reached
only via `resolveModel` (the task-type path, used by auto-work) or a manual override.

### 1.6 Lovable path model — hardcoded literal

**CONFIRMED.** `huddle.functions.ts:4270-4271`:
```ts
        usedBackend = "lovable";
        usedModel = "openai/gpt-5.5";
```
The Lovable branch **ignores** the per-agent config model entirely and hardcodes `openai/gpt-5.5`.
Provider: `createLovableAiGatewayProvider` (`@/lib/ai-gateway.server`), line 1013-1017. This branch
runs only when the OpenAI branch is not taken (no `OPENAI_API_KEY`, or backend explicitly lovable
with a lovable key).

### 1.7 Router model actually sent

**CONFIRMED.** `huddle.functions.ts:851-855` — the *server-side* default if the client sends no
router config:
```ts
  const routerCfg = data.router ?? {
    backend: "openai" as const,
    model: "gpt-5.6-luna",
    fastMode: false,
  };
```
The real browser always sends one, and the store default is `gpt-5.5` (§1.4). Used at **1069/1129**
(`model: routerCfg.model`) via `routeMessageLLM`.

### 1.8 `gpt-4o-mini` IS LIVE — in every background/automation path

**CONFIRMED — this contradicts "everything migrated to 5.6".** These are real, reachable call
sites, each constructing a turn payload whose *router* is pinned to `gpt-4o-mini`:

| file:line | snippet |
|---|---|
| `lib/tasks/reminders.ts:231` | `router: { backend: "openai", model: "gpt-4o-mini", ... }` |
| `lib/tasks/grooming.server.ts:90` | `router: { backend: "openai", model: "gpt-4o-mini", ... }` |
| `lib/tasks/review-digest.server.ts:53` | same |
| `lib/tasks/review-recheck.server.ts:45` | same |
| `lib/tasks/standup.server.ts:95` | same |
| `lib/tasks/autowork.server.ts:98` and `:472` | same |
| `lib/tasks/ceremonies.server.ts:59` | `model: "gpt-4o-mini",` |

And two direct *reviewer* models (not routers — these grade content):
```
lib/tasks/review-gate.server.ts:28   const REVIEWER_MODEL = "gpt-4o-mini";
lib/tasks/approach-gate.server.ts:23 const REVIEWER_MODEL = "gpt-4o-mini";
```
Two env-overridable ones:
```
lib/tasks/groom.ts:179              model: process.env.GROOM_MODEL || "gpt-4o-mini",
lib/tasks/ceremony-script.server.ts:117  model: process.env.CEREMONY_MODEL || "gpt-4o-mini",
```

### 1.9 Auto-work (agent doing background task work) model

**CONFIRMED.** `huddle.functions.ts:6322-6324`:
```ts
      ? resolveModel(w.objective, workerPersona, effectiveModelPolicy(payload.agents, undefined))
      : null;
    const model = workerResolved?.model || payload.agents?.[workerPersona]?.model || "gpt-5.6-luna";
```
`resolveModel` uses `DEFAULT_MODEL_POLICY.general` — so a background "produce"/"research" objective
resolves to **`gpt-5.6-terra`/high**, "deep_strategy" to `gpt-5.6-sol`/high, cheap task types to
`gpt-5.6-luna`/low (model-policy.ts:66-77).

### 1.10 MODEL TABLE — id → where used → live default?

| model id | where (file:line) | live default? |
|---|---|---|
| `gpt-5.6-luna` | `model-policy.ts:188-189` DIFF_RUNG 1-2; `huddle.functions.ts:4075` floor; `:6324` worker floor; `:853` server router fallback | **YES — the default brain for a normal typed turn** |
| `o3` | `agent-backends.ts` `DEFAULT_AGENT_CEILING = "o3"`; `model-policy.ts:190-191` DIFF_RUNG 3-4 | **YES — default per-agent ceiling AND the model for deep (difficulty 3-4) turns** |
| `gpt-5.5` | `model-catalog.ts:118` `DEFAULT_ROUTER_MODEL.openai` | **YES — the ROUTER model (who-answers decision)** |
| `openai/gpt-5.5` | `huddle.functions.ts:4271` hardcoded | YES *on the Lovable branch only* (not taken by default) |
| `gpt-4o-mini` | 9 background call sites, §1.8 | **YES — grooming, ceremonies, reminders, autowork routers + 2 reviewer models** |
| `gpt-5.6-terra` | `model-policy.ts:71-76` general policy; `:206` `budgetModel` | YES via `resolveModel` (auto-work) and as the Sol-gate budget fallback |
| `gpt-5.6-sol` | `model-policy.ts:75` `deep_strategy`; `:210` manual "sol" | Reachable but **gated**: `needsConfirm` forces a drop to Terra unless the user manually chose it (`huddle.functions.ts:4095-4098`) |
| `gpt-4o` | `openai-responses.server.ts:224` PRIORITY_MODELS set; `SettingsSheet.tsx:330` display fallback string; `agent-inspect.functions.ts:43` display string | **NO — not a runtime default anywhere.** Set membership + UI label only |
| `o3-mini`, `gpt-5.4*`, `gpt-5.2`, `gpt-5`, `gpt-5-mini/nano`, `google/gemini-*` | `model-catalog.ts:23-113` | **NO — dropdown catalog entries only** |
| `gpt-4o-mini-transcribe` | `realtime.functions.ts:104`, `realtime-audio.ts:36`, `transcribe.functions.ts:35` | **YES — live STT model** (see §2) |

### 1.11 Resolution order for "which model runs this turn"

**CONFIRMED**, reading `model-policy.ts:200-229` + `huddle.functions.ts:4075-4110`:
1. `deepManual` manual override (user picked a rung) — wins outright, no gate.
2. Router difficulty 1-4 → `DIFF_RUNG` (luna-low / luna-high / o3-high / o3-high).
3. Capped down by the agent ceiling = `tierOf(per-agent Settings model)` overlaid by
   `withAgentCeilings` (`model-policy.ts:154-164`); default `o3` = no cap.
4. Sol spend-gate: `needsConfirm && !deepManual` → drop to `budgetModel` = `gpt-5.6-terra`.
5. On any throw, keep `usedModel` from step 4075 (`agentBackend.model` → `snapshot.model` → `gpt-5.6-luna`).

---

## 2. VOICE path — what actually happens on a call

### 2.1 Default 1:1 engine = `realtime-speak`

**CONFIRMED.** `src/features/huddle/lib/voice/voice-engine-store.ts:21-28`:
```ts
export const useVoiceEngineStore = create<VoiceEngineState>()(
  persist(
    (set) => ({
      mode: "realtime-speak",
      userChose: false,
```
plus a v0→v1 migration (`:35-41`) that moves un-chosen `"baseline"` browsers onto `realtime-speak`.
Persisted to localStorage key `huddle-voice-engine`.

### 2.2 The Realtime session mint — model, modalities, VAD, STT

**CONFIRMED.** `src/features/huddle/lib/voice/realtime.functions.ts`.

Model, line **21**:
```ts
export const REALTIME_MODEL = "gpt-realtime";
```
Minted at `https://api.openai.com/v1/realtime/client_secrets` (line **121**), body `{ session: sessionBody }`.

The SPEAKING (agentId present) session body, lines **86-118**:
```ts
        sessionBody = {
          type: "realtime",
          model: REALTIME_MODEL,
          output_modalities: ["text"],
          audio: {
            input: {
              transcription: {
                model: "gpt-4o-mini-transcribe",
                language: "en",
              },
              turn_detection: {
                type: "semantic_vad",
                eagerness: data.eagerness ?? "medium",
                create_response: true,
                interrupt_response: true,
              },
            },
          },
          tool_choice: "auto",
          tools: toolset.tools,
          instructions,
        };
```

- `output_modalities: ["text"]` — OpenAI generates **no audio**.
- STT model: **`gpt-4o-mini-transcribe`**, `language: "en"`.
- Turn detection: **`semantic_vad`**, eagerness default `"medium"`, `interrupt_response: true` (barge).
- `noise_reduction` deliberately OMITTED; no STT `prompt` (both documented in the comment at :92-102).

### 2.3 BRAIN vs EAR — **Realtime is the BRAIN on the default engine.** (REFUTES the "ear only" reading)

**CONFIRMED, and this is the important correction.** Two different sessions exist in this one file:

| path | trigger | `create_response` | role |
|---|---|---|---|
| SPEAKING (`data.agentId` present) — used by `realtime-speak`, the DEFAULT | line 75 `if (data.agentId) {` | **`create_response: true`** (line 110) | **BRAIN** — Realtime generates the reply text, with the agent's snapshot instructions + RAG memory + governed tools baked in at mint (`assembleRealtimeInstructions`, `buildRealtimeToolset`, lines 76-79) |
| EARS-ONLY minimal mint (no `agentId`) | falls through to `sessionBody = { type:"realtime", model: REALTIME_MODEL }` (lines 70-73) | not set here — the client sends its own `session.update` | STT/VAD only; the reply comes from the app pipeline |

The file's own comment (line 23-26) states this split: *"when `agentId` is present, mint a SPEAKING
session (create_response:true) with the agent's same brain … When absent, mint today's minimal
EARS-ONLY session (back-compat: group ceremonies + the current 1:1 baseline are unchanged)"*.

⇒ The org-level CLAUDE.md note "Huddle `useVoiceCallRealtime` — `create_response:false` — Realtime
does VAD/STT/barge detection only" describes the **`baseline`** engine, which is NOT the default any
more. The default 1:1 call runs Realtime AS BRAIN with ElevenLabs supplying only the VOICE.

### 2.4 `useVoiceCallRealtimeSpeak` end-to-end (the default 1:1 call)

**CONFIRMED**, `src/features/huddle/hooks/useVoiceCallRealtimeSpeak.ts`:

1. **Mint** (line 364): `const session = await getRealtimeSession({ data: { agentId, caller, huddleId: \`dm-${agentId}\`, memoryQuery: recentText, webSearch: agentCfg?.webSearch, journey: agentCfg?.journey?.enabled } });`
   — the per-agent Settings flags (webSearch / journey) are threaded into the voice session.
2. **WebRTC** (line 526):
```ts
          `https://api.openai.com/v1/realtime/calls?model=${encodeURIComponent(REALTIME_MODEL)}`,
```
   Mic track added; the remote audio track is explicitly killed:
```ts
        pc.ontrack = (e) => { e.track.enabled = false; };
```
   (line ~381; comment: "Text-out session → no OpenAI audio track; defensively disable any remote track (we voice via EL)").
3. **Data channel** `oai-events` carries the streamed reply text and tool calls.
4. **Speak** — `pumpSpeech` drains complete sentences (`MIN_SPEAK_CHARS = 18`, line ~236) into
   `speak()` (line 206) which calls `synthesizeSpeech({ data: { text: s, agentId } })` (line 222).
5. **Tools** run in-process via `runRealtimeTool` (line ~503, `[realtime-speak] tool ${name} ${r.ms}ms`).

### 2.5 ElevenLabs synthesis — model + voice settings

**CONFIRMED.** `src/features/huddle/lib/voice/elevenlabs.server.ts:166`:
```ts
const TTS_MODEL = (process.env.ELEVENLABS_TTS_MODEL ?? "").trim() || "eleven_flash_v2_5";
```
⇒ **`eleven_flash_v2_5`**, env-overridable via `ELEVENLABS_TTS_MODEL`.

Voice settings, lines **182-188**:
```ts
const VOICE_SETTINGS = {
  stability: num(process.env.ELEVENLABS_TTS_STABILITY, 0.4),
  similarity_boost: num(process.env.ELEVENLABS_TTS_SIMILARITY, 0.8),
  style: num(process.env.ELEVENLABS_TTS_STYLE, 0.3),
  use_speaker_boost: (process.env.ELEVENLABS_TTS_SPEAKER_BOOST ?? "true").trim() !== "false",
  speed: num(process.env.ELEVENLABS_TTS_SPEED, 1.0),
};
```
Sent at line **206** with `output_format=mp3_44100_128` (line 202):
```ts
      body: JSON.stringify({ text, model_id: TTS_MODEL, voice_settings: VOICE_SETTINGS }),
```
Configurable **only by env var** (SWA app settings) — no UI control for stability/similarity/speed.

**Voice id** resolution — `lib/voice/tts.functions.ts:36-37`:
```ts
      const { resolveEffectiveVoiceId } = await import("./voice-config.server");
      const voiceId = (await resolveEffectiveVoiceId(data.agentId, data.voiceId)) ?? agent.voiceId;
```
i.e. explicit test value → saved per-agent override (DB) → `agents.ts` default. And
`elevenlabs.server.ts:56-61` `resolveVoiceId` rejects placeholder ids (`/^[A-Za-z0-9]{18,}$/`)
falling back to `ELEVENLABS_DEFAULT_VOICE_ID`.

### 2.6 The three voice surfaces are NOT the same engine

**CONFIRMED.** All three end in ElevenLabs `synthesizeSpeech` (same TTS model + voice settings), but
the BRAIN and the ear differ:

| surface | hook | ear (STT/VAD) | brain — who writes the words | voice |
|---|---|---|---|---|
| **1:1 call, default** (`realtime-speak`) | `useVoiceCallRealtimeSpeak.ts` | OpenAI Realtime `gpt-realtime`, `semantic_vad`, `gpt-4o-mini-transcribe` | **OpenAI Realtime itself** (`create_response: true`, `realtime.functions.ts:110`) | EL `eleven_flash_v2_5` |
| **1:1 call, `baseline`** | `useVoiceCallRealtime.ts` — but see 2.7: it owns NO Realtime code; it delegates to `useCeremonyVoice` | the CEREMONY session (ears-only, `create_response:false`) | **the app's own text pipeline** — `enqueueHuddleTurn` (`:177 enqueue: () => enqueueHuddleTurn({ data: payload })`), i.e. the §1 model ladder | EL `eleven_flash_v2_5` |
| **Ceremony / stand-up** | `useCeremonyVoice.ts` | Realtime session minted with **no agentId** → ears-only; `session.update` at `:617-620` sends `audio: { input: realtimeAudioInput({ createResponse: false }) }` | **the app's own text pipeline** | EL, per-agent (`:361 synthesizeSpeech`) |
| **Group voice** | `useGroupVoice.ts` | **no Realtime at all** — browser VAD + `transcribeAudio` HTTP (`transcribe.functions.ts:35 form.append("model", "gpt-4o-mini-transcribe")`) | `sendHuddleMessage` (`:190`) — the §1 group router + model ladder | EL, per-agent (`:224`) |

`src/features/huddle/lib/voice/realtime-audio.ts` is **ceremony-only** (its own header, lines 1-4)
and names the fork explicitly at lines 15-16:
```
//  - create_response:   1:1 = true (Realtime is the brain) | ceremony = false (ears-only). Flipping the
//                       1:1 to false would make the agent go SILENT; this is the brain/ear fork.
```
Ceremony STT config (`realtime-audio.ts:33-45`) differs from the 1:1 in exactly one knob:
`noise_reduction: { type: "near_field" }` — which `realtime.functions.ts` deliberately OMITS for the
1:1 (comment at :92-96, citing a live 2026-08-01 over-sensitivity regression).

### 2.7 CORRECTION — the `baseline` 1:1 engine literally IS the ceremony engine

**CONFIRMED by code, not by its comment.** `useVoiceCallRealtime.ts:19` *claims*
`"modalities:["text"], create_response:false"`, but that file contains **no Realtime code at all** —
`grep -n "getRealtimeSession|dc.send|session\.|transcription|turn_detection|REALTIME_MODEL"
hooks/useVoiceCallRealtime.ts` returns **zero hits**. What it actually does:

`useVoiceCallRealtime.ts:247`
```ts
  const ceremony = useCeremonyVoice({ onBargeDetected });
```
and its `connect()`:
```ts
      await ceremony.startListening();
```
⇒ the baseline 1:1 reuses the **ceremony's** WebRTC session verbatim —
`useCeremonyVoice.ts:756 / :903 const session = await getRealtimeSession({ data: {} });` (no
`agentId`, so the minimal ears-only mint at `realtime.functions.ts:70-73`), then
`useCeremonyVoice.ts:617-620`:
```ts
            type: "session.update",
            ...
              audio: { input: realtimeAudioInput({ createResponse: false }) },
```
The reply then comes from `enqueueHuddleTurn` (`useVoiceCallRealtime.ts:177`) — the normal §1 text
brain — and is voiced by `ceremony.voiceTurn` (ElevenLabs). So `create_response:false` IS true for
baseline, but it is set in `useCeremonyVoice.ts`, not in the file whose comment asserts it.
Both 1:1 engines mint through the same `getRealtimeSession`; the `agentId` argument is the entire
brain/ear fork.

---

## 3. ConvAI — is ElevenLabs Conversational AI used at all?

### 3.1 The ConvAI code exists and is complete

**CONFIRMED.** `src/features/huddle/lib/voice/elevenlabs.server.ts`:
```ts
const EL_BASE = "https://api.elevenlabs.io/v1/convai";      // :14
const DEFAULT_LLM = "gpt-4o-mini";                          // :15
export async function ensureElevenLabsAgent(...)            // :114  → POST /agents/create
export async function getSignedUrl(elAgentId: string)       // :151  → GET /conversation/get-signed-url
```
`ensureElevenLabsAgent` creates an EL ConvAI agent named `huddle:<agentId>` with
`prompt: { prompt: agent.systemPrompt + VOICE_SCENE, llm: agentLlm() }` (line 132), where
`agentLlm()` = `process.env.ELEVENLABS_AGENT_LLM || "gpt-4o-mini"` (lines 42-44).

### 3.2 EVERY caller — the complete chain (exhaustive grep of src/ and scripts/)

**CONFIRMED.** `grep -rn "ensureElevenLabsAgent|getSignedUrl|convai|custom_llm" src/ scripts/` returns
exactly one live chain:

```
elevenlabs.server.ts  ensureElevenLabsAgent + getSignedUrl
   ↑ ONLY caller
lib/voice/voice.functions.ts:32-47   startVoiceSession  (server fn)
   ↑ ONLY caller
hooks/useVoiceCall.ts:4,79           const res = await startVoiceSession({ data: { agentId } });
   ↑ ONLY caller — inside connect()
components/MeetingBar.tsx:310         const elevenLabsVoice = useVoiceCall();
```

### 3.3 The branch that would use it is **UNREACHABLE** — ConvAI is dead scaffolding

**CONFIRMED — this is the answer to the question that prompted this doc.**

`src/features/huddle/components/MeetingBar.tsx:131`:
```ts
const VOICE_1ON1_BACKEND: "openai" | "elevenlabs" = "openai";
```
It is a module-level `const` **never reassigned** — `grep -rn "VOICE_1ON1_BACKEND" src/` returns only
its declaration (:131), two reads (:317, :392), and one string in an error message (:2090) plus a
comment reference in `useVoiceCallRealtime.ts:16`. **There is no setter, no env read, no UI control.**

The selector, `MeetingBar.tsx:314-319`:
```ts
  const voice: VoiceCallController =
    engineMode === "realtime-speak"
      ? realtimeSpeakVoice
      : VOICE_1ON1_BACKEND === "openai"
        ? realtimeVoice
        : elevenLabsVoice;
```
`elevenLabsVoice` is selected **only** when `engineMode !== "realtime-speak"` AND
`VOICE_1ON1_BACKEND === "elevenlabs"`. The second conjunct is a compile-time-constant `"openai"`.
⇒ **`elevenLabsVoice` can never be the selected controller.**

The only UI toggle (`MeetingBar.tsx:1891`) flips between the two OpenAI engines, never to ConvAI:
```ts
              const next = engineMode === "realtime-speak" ? "baseline" : "realtime-speak";
```

The hook `useVoiceCall()` IS still *mounted* (line 310, "All voice hooks are always called (Rules of
Hooks) — only the selected one is ever connect()ed; the others sit idle"), but `startVoiceSession`
fires only inside `connect()` (`useVoiceCall.ts:67,79`), which nothing calls for that controller.

**VERDICT: Huddle does NOT use ElevenLabs ConvAI agents at runtime.** No `/v1/convai/agents` or
`/conversation/get-signed-url` request can be issued by the running app. ElevenLabs is used
**for TTS only** — `POST /v1/text-to-speech/{voiceId}` (`elevenlabs.server.ts:201-208`), a different
API entirely. The `gpt-4o-mini` `DEFAULT_LLM` at `:15` is therefore also dead — it configures a
ConvAI agent that is never created.

### 3.4 `custom_llm`

**NOT-FOUND — CONFIRMED ABSENT.** `grep -rn "custom_llm" src/ scripts/` returns zero hits across the
whole repo (search covered `src/` and `scripts/`, excluding node_modules). Meaning: even the dead
ConvAI provisioning path uses ElevenLabs' *built-in* LLM selection (`prompt.llm: "gpt-4o-mini"`),
not a bring-your-own-LLM webhook. So there is no ConvAI→Huddle-brain bridge anywhere, live or dead.

---

## 4. Settings surface — what the owner can ACTUALLY change

All rows below are **CONFIRMED** by reading the component + its store/server target.

| Setting | UI | Persists to | Runtime path that reads it |
|---|---|---|---|
| Router backend | `SettingsSheet.tsx:79-85` `onBackendChange` → `setRouter({ backend, model })` | localStorage `huddle-backends` | `huddle.functions.ts:1069/1129` `model: routerCfg.model` |
| Router model | `SettingsSheet.tsx:184` `<Select value={config.router.model} onValueChange={(v) => setRouter({ model: v })}>` (options = `ROUTER_MODELS[backend]`) | same | same |
| Fast mode (priority tier) | `:207` `setRouter({ fastMode: v })` | same | `openai-responses.server.ts:244` `input.fastMode && PRIORITY_MODELS.has(input.model)` |
| Solo-on-coverage / strict prompt / interjections / maxInterjectors | `:223, :256, :273, :292, :307` | same | `routing.ts` `assembleWinners` |
| **Per-agent backend** (Lovable AI / OpenAI Responses) | `:367` `setAgent(a.id, { backend: ... })` | same | `huddle.functions.ts:1900` `agentsCfg[nextId]` → :2896-2913 |
| Per-agent Assistant ID | `:383` `setAgent(a.id, { assistantId })` | same | provenance only (snapshot re-pull); not sent to OpenAI |
| **Per-agent "Max model (ceiling)"** | `:396-401` `<Label>Max model (ceiling)</Label> … setAgent(a.id, { model: v })`, options = `ROUTER_MODELS.openai` | same | `model-policy.ts:154` `withAgentCeilings` → `resolveByDifficulty` cap. **NOT the model that runs** |
| Per-agent RAG (store/chunks/triples/fileSearch/sharing) | `:825` `setAgent(a.id, { rag: {...} })` | same | `huddle.functions.ts:909, 5815` |
| Per-agent instructions override | `:663-667` `setAgent(r.agentId, { instructionsOverride })` | same | wins over snapshot at turn time |
| Memory mode (reconstruction / responses-chain / conversation / researched) | `:474` `setMemoryMode(opt.mode)` | same | `huddle.functions.ts` conversation-store branch |
| Ceremony engine (current / current-optimized) | `:241` `setCeremonyEngine(...)` | same | ceremony path |
| Reply streaming 1:1 / group | `:516, :529` `setStreamReplies(...)` | same | `huddle.functions.ts:4198-4203` `streamOneOnOne` |
| **Per-agent ElevenLabs voice id** | `AgentVoiceField.tsx:44` `setVoiceOverrideFn({ data: { agentId, voiceId } })` | **server-side DB** — `identity.agent_voice` (`voice-config.server.ts:25-29`) | `tts.functions.ts:37` `resolveEffectiveVoiceId` → every synth path (1:1, ceremony, group) |
| 1:1 voice engine (Fast (A) / Baseline) | `MeetingBar.tsx:1891` `const next = engineMode === "realtime-speak" ? "baseline" : "realtime-speak";` | localStorage `huddle-voice-engine` | `MeetingBar.tsx:314-319` controller selection |

**NOT settable in any UI — CONFIRMED by absence:**
- **`modelPolicy`** — `setModelPolicy` exists on the store (`agent-backends.ts`) but `grep -rn
  "setModelPolicy" src/features/huddle/components/ src/routes` returns **zero** hits. The policy is
  only *read* and forwarded (`HuddleView.tsx:1297`, `MeetingBar.tsx:1050, :1714`
  `modelPolicy: cfg.modelPolicy`). So the task-type → tier table and the difficulty ladder are
  effectively code constants today, contradicting the repo's "no hardcoded config" rule.
- **ElevenLabs TTS model + stability/similarity/style/speed** — env only
  (`elevenlabs.server.ts:166, 182-188`).
- **Realtime `eagerness`** — `realtime.functions.ts:109` accepts it as an input and defaults to
  `"medium"`, but `grep -rn "eagerness" src/features/huddle --include=*.tsx` finds **no UI control**;
  `useVoiceCallRealtimeSpeak.ts` never passes it. NOT-VERIFIED that any caller sets it — none found.
- **`VOICE_1ON1_BACKEND`** — a source constant (`MeetingBar.tsx:131`), requires a code change.
- **`AgentSettingsDrawer.tsx`** is read-only for model: `:393 <Field label="Model" value={debug.resolvedModel} />`.
  It does NOT edit model/backend (it hosts prompt inspection + `AgentVoiceField`).

---

## THE ONE-PARAGRAPH ANSWER

When you type a message, a router (running **GPT-5.5**) reads the room and decides which agents
should answer and how hard the question is, on a 1-4 scale. Each chosen agent then answers with
OpenAI's Responses API — **all fifteen agents are on OpenAI by default**, not the "Lovable" gateway
the code's fallback line suggests. Which brain it uses is decided fresh every single turn from that
difficulty score: an ordinary message runs **gpt-5.6-luna** (cheap and fast, with more "thinking" for
a difficulty-2 message), and a hard one jumps to **o3**. The "Max model" dropdown in Settings is not
the model it uses — it is a *speed limit*, and it is set to o3 (the top) for every agent, so nothing
is capped today. Sol (`gpt-5.6-sol`) is deliberately hard to reach: if the resolver picks it without
you explicitly asking, the code drops down to Terra instead, so it never spends the expensive tier by
accident. Separately, all the background housekeeping — grooming your backlog, stand-up scripts,
reminders, the auto-work reviewers — still routes on the old **gpt-4o-mini**. On a voice call it is a
different arrangement entirely: your microphone goes straight to OpenAI's **`gpt-realtime`** model
over a direct browser connection, it transcribes you with **gpt-4o-mini-transcribe**, and — this is
the part that surprises people — **that Realtime model writes the reply itself**, because the session
is minted with `create_response: true`. It is told to produce text only, never audio, and every
finished sentence is handed to **ElevenLabs (`eleven_flash_v2_5`)** to be spoken in that agent's
cloned voice. So on a 1:1 call the agent's normal text brain (the Luna/o3 ladder) is not the thing
answering you — a different model is, wearing the same instructions and the same voice. Group
meetings and stand-ups work the older way: they only *listen* with Realtime (or plain transcription)
and send the words through the normal text pipeline, then speak the replies with ElevenLabs.

## WHERE THE ConvAI PATH FITS (OR DOESN'T)

**It doesn't. ElevenLabs Conversational AI is not used by Huddle at runtime — it is complete,
working-looking, permanently-unreachable scaffolding.** The code is all there: `elevenlabs.server.ts`
creates a ConvAI agent per Huddle agent (`POST /v1/convai/agents/create`, named `huddle:<agentId>`,
with its own `gpt-4o-mini` brain) and mints a signed WebSocket URL
(`GET /v1/convai/conversation/get-signed-url`) for the browser SDK. But following the callers gives
exactly one chain — `elevenlabs.server` ← `voice.functions.ts startVoiceSession` ←
`useVoiceCall.ts connect()` ← `MeetingBar.tsx:310` — and that controller is only selected when the
constant `VOICE_1ON1_BACKEND === "elevenlabs"`. That constant is hardcoded to `"openai"` at
`MeetingBar.tsx:131`, is never reassigned anywhere in the repo, and has no env or UI path. The one
voice toggle the user has flips between the two *OpenAI* engines. So the hook is mounted but never
connected, and no ConvAI HTTP request can be issued by the running app. The practical consequences:
(1) ElevenLabs' role in Huddle today is **TTS only** — a completely different API
(`POST /v1/text-to-speech/{voiceId}`), which is very much live on all three voice surfaces;
(2) the `gpt-4o-mini` `DEFAULT_LLM` in `elevenlabs.server.ts:15` is dead — it only ever configured a
ConvAI agent that is never created; (3) there is **no `custom_llm` anywhere in the repo**, so even
the dormant path would have used ElevenLabs' own hosted LLM rather than Huddle's brain — meaning
turning ConvAI on would *replace* the agents' routing, memory and tools, not extend them. If ConvAI
is ever wanted, it is a two-line change to reach, but it is a fork in the architecture, not a
feature flag.

---
*Status: COMPLETE. Every claim above carries file:line + verbatim snippet and was read this session.*
