// Server-only ElevenLabs Conversational AI integration.
//
// Pattern (from the realtime-voice-agent recipe): the browser never sees the
// API key. The server creates/reuses one Conversational-AI "agent" per Huddle
// agent (OpenAI brain + the agent's ElevenLabs voice + persona prompt), then
// mints a short-lived signed WebSocket URL the browser connects to. Barge-in,
// turn-taking, and TTS are handled by ElevenLabs.
//
// Secrets (server-only):
//   ELEVENLABS_API_KEY          — required
//   ELEVENLABS_DEFAULT_VOICE_ID — fallback voice when an agent has no real voice id
//   ELEVENLABS_AGENT_LLM        — optional; defaults to gpt-4o-mini (fast + cheap)

const EL_BASE = "https://api.elevenlabs.io/v1/convai";
const DEFAULT_LLM = "gpt-4o-mini";

/** First non-empty value among the given env var names (exact-name tolerant). */
function firstEnv(names: string[]): string {
  for (const n of names) {
    const v = (process.env[n] ?? "").trim();
    if (v) return v;
  }
  return "";
}

// Canonical names are ELEVENLABS_API_KEY / ELEVENLABS_DEFAULT_VOICE_ID, but we
// accept common variants so a differently-named secret still lights up voice.
function elKey(): string {
  return firstEnv(["ELEVENLABS_API_KEY", "ELEVEN_LABS_API_KEY", "ELEVENLABS_KEY", "XI_API_KEY"]);
}

function defaultVoiceId(): string {
  return firstEnv([
    "ELEVENLABS_DEFAULT_VOICE_ID",
    "ELEVENLABS_VOICE_ID",
    "ELEVEN_LABS_VOICE_ID",
    "ELEVENLABS_VOICEID",
    "DEFAULT_VOICE_ID",
  ]);
}

function agentLlm(): string {
  return (process.env.ELEVENLABS_AGENT_LLM ?? "").trim() || DEFAULT_LLM;
}

export function elevenLabsConfigured(): boolean {
  return !!elKey();
}

/**
 * Huddle agent `voiceId`s are human placeholders ("terry", "iris") until real
 * ElevenLabs voices are assigned. A real EL voice id is a ~20-char alphanumeric
 * token — only use the agent's value if it looks real; otherwise fall back to
 * the configured default voice (or undefined → the EL agent's own default).
 */
export function resolveVoiceId(agentVoiceId: string | undefined): string | undefined {
  const v = (agentVoiceId ?? "").trim();
  if (/^[A-Za-z0-9]{18,}$/.test(v)) return v;
  const d = defaultVoiceId();
  return d || undefined;
}

// Per-worker cache: huddle agent id → ElevenLabs agent id. Just an optimization;
// the deterministic name lookup below is the real dedup across worker restarts.
const agentIdCache = new Map<string, string>();

async function elFetch(path: string, init?: RequestInit): Promise<Response> {
  const key = elKey();
  if (!key) throw new Error("ELEVENLABS_API_KEY not configured");
  return fetch(EL_BASE + path, {
    ...init,
    headers: {
      "xi-api-key": key,
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
}

/** Find an existing EL agent by its exact (deterministic) name. */
async function findAgentByName(name: string): Promise<string | null> {
  const res = await elFetch(`/agents?page_size=100&search=${encodeURIComponent(name)}`, {
    method: "GET",
  });
  if (!res.ok) {
    throw new Error(`ElevenLabs /agents list ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const body = (await res.json()) as { agents?: Array<{ agent_id: string; name: string }> };
  const match = (body.agents ?? []).find((a) => a.name === name);
  return match?.agent_id ?? null;
}

export interface HuddleVoiceAgent {
  id: string;
  name: string;
  voiceId: string;
  systemPrompt: string;
}

export interface EnsureAgentResult {
  elAgentId: string;
  voiceId?: string;
  created: boolean;
}

const VOICE_SCENE =
  "\n\nYou are on a LIVE VOICE CALL. Speak in 1–2 short conversational sentences at a time — plain spoken language, no markdown, no bullet lists, no headings. Be natural and let the other person interrupt you.";

/**
 * Create-or-reuse the ElevenLabs Conversational-AI agent that voices this
 * Huddle agent. Reuse is keyed on a deterministic name (`huddle:<agentId>`) so
 * we never create duplicates, even after a worker restart clears the cache.
 */
export async function ensureElevenLabsAgent(agent: HuddleVoiceAgent): Promise<EnsureAgentResult> {
  const voiceId = resolveVoiceId(agent.voiceId);

  const cached = agentIdCache.get(agent.id);
  if (cached) return { elAgentId: cached, voiceId, created: false };

  const name = `huddle:${agent.id}`;
  const existing = await findAgentByName(name);
  if (existing) {
    agentIdCache.set(agent.id, existing);
    return { elAgentId: existing, voiceId, created: false };
  }

  const firstName = agent.name.split(" ")[0];
  const body = {
    name,
    conversation_config: {
      agent: {
        prompt: { prompt: agent.systemPrompt + VOICE_SCENE, llm: agentLlm() },
        first_message: `Hey, ${firstName} here — what do you want to dig into?`,
        language: "en",
      },
      ...(voiceId ? { tts: { voice_id: voiceId } } : {}),
    },
  };

  const res = await elFetch("/agents/create", { method: "POST", body: JSON.stringify(body) });
  if (!res.ok) {
    throw new Error(`ElevenLabs /agents/create ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const created = (await res.json()) as { agent_id?: string };
  if (!created.agent_id) throw new Error("ElevenLabs /agents/create returned no agent_id");
  agentIdCache.set(agent.id, created.agent_id);
  return { elAgentId: created.agent_id, voiceId, created: true };
}

/** Mint a short-lived signed WebSocket URL for the browser to connect with. */
export async function getSignedUrl(elAgentId: string): Promise<string> {
  const res = await elFetch(
    `/conversation/get-signed-url?agent_id=${encodeURIComponent(elAgentId)}`,
    { method: "GET" },
  );
  if (!res.ok) {
    throw new Error(`ElevenLabs get-signed-url ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const body = (await res.json()) as { signed_url?: string };
  if (!body.signed_url) throw new Error("ElevenLabs get-signed-url returned no signed_url");
  return body.signed_url;
}

// Low-latency model for the turn-based group-voice loop — Flash trades a little
// fidelity for ~75ms first-byte, which is what keeps multi-agent turns feeling live.
const TTS_MODEL = (process.env.ELEVENLABS_TTS_MODEL ?? "").trim() || "eleven_flash_v2_5";

// Voice rendering settings. Without these, ElevenLabs uses the voice's saved defaults, which on the
// Flash model read flat/robotic. Slightly lower stability + speaker boost make it more natural and
// less monotone; `speed` fixes "too slow" (1.0 = normal, >1 faster). All env-tunable so the feel can
// be dialed in from SWA app settings WITHOUT a code change / redeploy — confirm by ear and adjust.
const num = (v: string | undefined, d: number) => {
  const n = Number((v ?? "").trim());
  return Number.isFinite(n) ? n : d;
};
const VOICE_SETTINGS = {
  stability: num(process.env.ELEVENLABS_TTS_STABILITY, 0.4),
  similarity_boost: num(process.env.ELEVENLABS_TTS_SIMILARITY, 0.8),
  style: num(process.env.ELEVENLABS_TTS_STYLE, 0.3),
  use_speaker_boost: (process.env.ELEVENLABS_TTS_SPEAKER_BOOST ?? "true").trim() !== "false",
  speed: num(process.env.ELEVENLABS_TTS_SPEED, 1.0),
};

/**
 * One-shot text→speech in a given agent's voice, for the uniform streaming group
 * meeting (as opposed to the Conversational-AI orb used for 1:1). Returns raw mp3
 * bytes as base64; the browser decodes and plays them. Voice falls back to the
 * configured default until real per-agent voice ids are assigned.
 */
export async function textToSpeech(text: string, agentVoiceId?: string): Promise<string> {
  const key = elKey();
  if (!key) throw new Error("ELEVENLABS_API_KEY not configured");
  const voiceId = resolveVoiceId(agentVoiceId);
  if (!voiceId) throw new Error("No ElevenLabs voice available (set ELEVENLABS_DEFAULT_VOICE_ID)");
  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`,
    {
      method: "POST",
      headers: { "xi-api-key": key, "content-type": "application/json" },
      body: JSON.stringify({ text, model_id: TTS_MODEL, voice_settings: VOICE_SETTINGS }),
    },
  );
  if (!res.ok) {
    throw new Error(`ElevenLabs TTS ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const buf = new Uint8Array(await res.arrayBuffer());
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < buf.length; i += chunk) {
    bin += String.fromCharCode(...buf.subarray(i, i + chunk));
  }
  return btoa(bin);
}
