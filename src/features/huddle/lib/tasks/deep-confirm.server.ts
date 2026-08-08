// Cross-turn pending state for the inescapable Sol confirm-gate. When a DEEP ask would auto-spend on
// Sol-high, the runtime does NOT run it — it asks the user to confirm (default Sol-high) or switch to
// the Terra-high budget, and stores the original ask here. The user's next reply (go / budget / cancel)
// resumes the deferred deep turn on the chosen model. One pending row per (user, huddle); best-effort
// (any DB error → null, so the turn simply proceeds normally). No new secret; reuses AZURE_PG_URL.
import { Pool } from "pg";

let _pool: Pool | null = null;
function getPool(): Pool {
  if (_pool) return _pool;
  const url = process.env.AZURE_PG_URL;
  if (!url) throw new Error("AZURE_PG_URL not configured");
  _pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false }, max: 3, idleTimeoutMillis: 20_000, connectionTimeoutMillis: 10_000 });
  return _pool;
}
const BOOTSTRAP = `
CREATE SCHEMA IF NOT EXISTS chat;
CREATE TABLE IF NOT EXISTS chat.deep_confirm (
  user_email TEXT NOT NULL,
  huddle_id  TEXT NOT NULL,
  agent_id   TEXT,
  ask_text   TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_email, huddle_id)
);`;
let booted: Promise<void> | null = null;
async function ensure() {
  if (booted) return booted;
  booted = (async () => { await getPool().query(BOOTSTRAP); })();
  try { await booted; } catch (e) { booted = null; throw e; }
}

export interface PendingDeep { askText: string; agentId: string | null; createdAt: number }

export async function setPendingDeepConfirm(email: string | null, huddleId: string, agentId: string | null, askText: string): Promise<void> {
  if (!email) return;
  try {
    await ensure();
    await getPool().query(
      `INSERT INTO chat.deep_confirm (user_email, huddle_id, agent_id, ask_text) VALUES ($1,$2,$3,$4)
       ON CONFLICT (user_email, huddle_id) DO UPDATE SET agent_id=$3, ask_text=$4, created_at=now()`,
      [email, huddleId, agentId, askText],
    );
  } catch { /* best-effort */ }
}
export async function getPendingDeepConfirm(email: string | null, huddleId: string): Promise<PendingDeep | null> {
  if (!email) return null;
  try {
    await ensure();
    const r = await getPool().query<{ ask_text: string; agent_id: string | null; created_at: Date }>(
      `SELECT ask_text, agent_id, created_at FROM chat.deep_confirm WHERE user_email=$1 AND huddle_id=$2`,
      [email, huddleId],
    );
    const row = r.rows[0];
    if (!row) return null;
    // Expire stale pendings (>2h) so an abandoned confirm never hijacks a later message.
    if (Date.now() - new Date(row.created_at).getTime() > 2 * 3600_000) { await clearPendingDeepConfirm(email, huddleId); return null; }
    return { askText: row.ask_text, agentId: row.agent_id, createdAt: new Date(row.created_at).getTime() };
  } catch { return null; }
}
export async function clearPendingDeepConfirm(email: string | null, huddleId: string): Promise<void> {
  if (!email) return;
  try { await ensure(); await getPool().query(`DELETE FROM chat.deep_confirm WHERE user_email=$1 AND huddle_id=$2`, [email, huddleId]); } catch { /* best-effort */ }
}

/** Classify a short user reply to a pending deep-confirm. Deterministic (no LLM). */
export function classifyConfirmReply(text: string): "sol" | "budget" | "cancel" | "unrelated" {
  const t = (text || "").trim().toLowerCase();
  if (/^(budget|terra|cheap(er)?|the budget( one)?|use terra)\b/.test(t)) return "budget";
  if (/^(go|yes|ok|okay|proceed|sol|go deep|deep|do it|confirm|yep|yeah|best|use sol|sure)\b/.test(t)) return "sol";
  if (/^(no|cancel|never ?mind|stop|skip|forget it)\b/.test(t)) return "cancel";
  return "unrelated";
}
