// memoryMode "conversation" (1:1 DMs only): durable map of (user, 1:1 huddle, agent) → OpenAI
// Conversations object id, plus the get-or-create that mints/reuses it. When active, the agent's
// short-term continuity is carried by OpenAI's server-side conversation thread instead of the
// app-reconstructed 14-message transcript — so "what did we say one turn ago" is native, not a
// capped, noise-diluted window. RAG (search_memory/lookup_facts + auto-retrieval) still layers on top.
//
// Group huddles deliberately do NOT use this (a single shared conversation object would blur the
// multiple agents' identities) — they keep reconstruction.
//
// EVERYTHING here is best-effort and fails to `null`: any DB or OpenAI error means the caller falls
// back to reconstruction for that turn. This is a flag-gated ADD, never a hard dependency.

import { Pool } from "pg";

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
CREATE SCHEMA IF NOT EXISTS chat;
CREATE TABLE IF NOT EXISTS chat.agent_conversations (
  user_email      TEXT NOT NULL,
  huddle_id       TEXT NOT NULL,
  agent_id        TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_email, huddle_id, agent_id)
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

export interface ConversationSeedItem {
  role: "user" | "assistant";
  content: string;
}

/** Create a fresh OpenAI Conversations object, optionally seeded with the prior transcript so the
 *  switch-over from reconstruction doesn't lose the conversation that already happened. Returns the
 *  new `conv_...` id, or null on any failure. */
async function createOpenAIConversation(seed: ConversationSeedItem[]): Promise<string | null> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return null;
  try {
    const items = seed
      .filter((m) => m && typeof m.content === "string" && m.content.trim())
      .slice(-14)
      .map((m) => ({ type: "message", role: m.role, content: m.content }));
    const res = await fetch("https://api.openai.com/v1/conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify(items.length ? { items } : {}),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { id?: string };
    return typeof json.id === "string" && json.id.startsWith("conv_") ? json.id : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the OpenAI conversation id for this (user, 1:1 huddle, agent), minting one on first use
 * (seeded with `seed` so existing context carries over) and reusing it thereafter. Returns null on
 * any DB/OpenAI failure — the caller MUST fall back to reconstruction when null.
 */
export async function getOrCreateConversationId(args: {
  userEmail: string | null;
  huddleId: string;
  agentId: string;
  seed: ConversationSeedItem[];
}): Promise<string | null> {
  const email = args.userEmail?.trim();
  if (!email) return null; // no stable key → can't persist/reuse; fall back
  try {
    await ensureBootstrapped();
    const pool = getPool();
    const existing = await pool.query<{ conversation_id: string }>(
      `SELECT conversation_id FROM chat.agent_conversations
        WHERE user_email = $1 AND huddle_id = $2 AND agent_id = $3`,
      [email, args.huddleId, args.agentId],
    );
    if (existing.rows[0]?.conversation_id) return existing.rows[0].conversation_id;

    const convId = await createOpenAIConversation(args.seed);
    if (!convId) return null;

    // Idempotent insert: a concurrent turn may have created one first — keep the winner and return
    // whatever is stored, so both turns use the SAME conversation object.
    const upsert = await pool.query<{ conversation_id: string }>(
      `INSERT INTO chat.agent_conversations (user_email, huddle_id, agent_id, conversation_id)
         VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_email, huddle_id, agent_id) DO UPDATE SET updated_at = now()
       RETURNING conversation_id`,
      [email, args.huddleId, args.agentId, convId],
    );
    return upsert.rows[0]?.conversation_id ?? convId;
  } catch {
    return null;
  }
}

/**
 * Drop the stored conversation id for (user, 1:1 huddle, agent) so the NEXT turn mints a fresh
 * Conversations object. Used to self-heal a POISONED conversation: if a tool/function call was stored
 * in the OpenAI conversation thread but its output never got submitted (turn hit maxHops, the deadline,
 * or aborted mid-hop), every later turn 400s with "No tool output found for function call …". Clearing
 * the row makes the agent recover on its next message. Best-effort; failure is non-fatal (the caller
 * still falls back to reconstruction for the current turn).
 */
export async function clearConversationId(args: {
  userEmail: string | null;
  huddleId: string;
  agentId: string;
}): Promise<void> {
  const email = args.userEmail?.trim();
  if (!email) return;
  try {
    await ensureBootstrapped();
    await getPool().query(
      `DELETE FROM chat.agent_conversations
        WHERE user_email = $1 AND huddle_id = $2 AND agent_id = $3`,
      [email, args.huddleId, args.agentId],
    );
  } catch {
    /* best-effort */
  }
}
