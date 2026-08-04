// Server-side, GLOBAL per-agent ElevenLabs voice-id overrides. A voice belongs to the AGENT (not a
// user), so this is keyed by agent_id alone — editable from Settings and applied to every synth path
// (1:1, ceremony, group) without a redeploy. Mirrors the identity pool/bootstrap pattern; the agents.ts
// `voiceId` remains the built-in DEFAULT when no override row exists.
import { Pool } from "pg";
import { AGENT_BY_ID, type AgentId } from "../../data/agents";

let _pool: Pool | null = null;
function getPool(): Pool {
  if (_pool) return _pool;
  const url = process.env.AZURE_PG_URL;
  if (!url) throw new Error("AZURE_PG_URL not configured");
  _pool = new Pool({
    connectionString: url,
    ssl: { rejectUnauthorized: false },
    max: 3,
    idleTimeoutMillis: 20_000,
    connectionTimeoutMillis: 10_000,
  });
  return _pool;
}

const BOOTSTRAP_SQL = `
CREATE SCHEMA IF NOT EXISTS identity;
CREATE TABLE IF NOT EXISTS identity.agent_voice (
  agent_id   TEXT PRIMARY KEY,
  voice_id   TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

let bootstrapped: Promise<void> | null = null;
async function ensureBootstrapped() {
  if (bootstrapped) return bootstrapped;
  bootstrapped = (async () => {
    await getPool().query(BOOTSTRAP_SQL);
  })();
  try {
    await bootstrapped;
  } catch (e) {
    bootstrapped = null;
    throw e;
  }
}

// Small in-process cache so the per-sentence synth path doesn't hit the DB on every call. Cleared on any
// write so a saved change takes effect immediately (within this server instance; other instances refresh
// on TTL). Date.now() is fine here — this is a normal server runtime, not a Workflow script.
const CACHE_TTL_MS = 20_000;
let _cache: { at: number; map: Record<string, string> } | null = null;

async function loadOverrides(): Promise<Record<string, string>> {
  if (_cache && Date.now() - _cache.at < CACHE_TTL_MS) return _cache.map;
  await ensureBootstrapped();
  const r = await getPool().query<{ agent_id: string; voice_id: string }>(
    `SELECT agent_id, voice_id FROM identity.agent_voice`,
  );
  const map: Record<string, string> = {};
  for (const row of r.rows) map[row.agent_id] = row.voice_id;
  _cache = { at: Date.now(), map };
  return map;
}

/** All saved per-agent voice overrides as an { agentId: voiceId } map (empty when none set). */
export async function getVoiceOverrides(): Promise<Record<string, string>> {
  try {
    return { ...(await loadOverrides()) };
  } catch {
    return {};
  }
}

/** Upsert (non-empty) or clear (empty/undefined → reset to the agents.ts default) an agent's voice. */
export async function setVoiceOverride(agentId: string, voiceId: string | null | undefined): Promise<void> {
  await ensureBootstrapped();
  const v = (voiceId ?? "").trim();
  if (v) {
    await getPool().query(
      `INSERT INTO identity.agent_voice (agent_id, voice_id, updated_at) VALUES ($1,$2, now())
       ON CONFLICT (agent_id) DO UPDATE SET voice_id=EXCLUDED.voice_id, updated_at=now()`,
      [agentId, v],
    );
  } else {
    await getPool().query(`DELETE FROM identity.agent_voice WHERE agent_id=$1`, [agentId]);
  }
  _cache = null; // invalidate so the next resolve/read reflects the change immediately
}

/**
 * The voice id to synthesize with for this agent, right now:
 *   explicit (unsaved test value) → saved override → agents.ts default.
 * Never throws — a config-read failure falls back to the built-in default.
 */
export async function resolveEffectiveVoiceId(agentId: AgentId, explicit?: string): Promise<string | undefined> {
  const ex = explicit?.trim();
  if (ex) return ex;
  try {
    const map = await loadOverrides();
    if (map[agentId]) return map[agentId];
  } catch { /* fall through to default */ }
  return AGENT_BY_ID[agentId]?.voiceId;
}
