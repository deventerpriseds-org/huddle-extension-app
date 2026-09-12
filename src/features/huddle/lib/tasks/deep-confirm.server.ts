// Cross-turn pending state for the deep-1:1 PRODUCE-vs-QUICK confirm gate. A fresh 1:1 ask the router
// scores DEEP (difficulty ≥3) is rarely something you want answered as a long, high-effort synchronous
// wall of text in a chat — it's usually a PRODUCE task (research/draft/plan → an async artifact the WIP
// pipeline works and you review). So instead of silently running the deep model inline, the runtime
// HOLDS and asks: produce it async, or just a quick take here? The user's next reply resumes on the
// chosen shape — produce → a real produce task + async kick; quick → resume the ORIGINAL ask inline on a
// chat-friendly tier. The original ask is stored here. One pending row per (user, huddle); best-effort
// (any DB error → null, so the turn simply proceeds normally). No new secret; reuses AZURE_PG_URL.
import { Pool } from "pg";
import { isGreenLight } from "./green-light";

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
);
-- Identity unification: key on the stable user_id (entra_object_id) with user_email retained as a
-- fallback + display. Resolved in-store from the passed email via resolveScopeByEmail, so both of a
-- user's emails converge to one pending row regardless of which email a caller presents.
ALTER TABLE chat.deep_confirm ADD COLUMN IF NOT EXISTS user_id TEXT;
CREATE INDEX IF NOT EXISTS deep_confirm_userid_idx ON chat.deep_confirm(user_id);`;
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
    const { resolveScopeByEmail } = await import("../identity/identity.server");
    const { userId } = await resolveScopeByEmail(email);
    await getPool().query(
      `INSERT INTO chat.deep_confirm (user_email, huddle_id, agent_id, ask_text, user_id) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (user_email, huddle_id) DO UPDATE SET agent_id=$3, ask_text=$4, user_id=COALESCE(EXCLUDED.user_id, chat.deep_confirm.user_id), created_at=now()`,
      [email, huddleId, agentId, askText, userId],
    );
  } catch { /* best-effort */ }
}
export async function getPendingDeepConfirm(email: string | null, huddleId: string): Promise<PendingDeep | null> {
  if (!email) return null;
  try {
    await ensure();
    const { resolveScopeByEmail } = await import("../identity/identity.server");
    const { userId, emails } = await resolveScopeByEmail(email);
    const r = await getPool().query<{ ask_text: string; agent_id: string | null; created_at: Date }>(
      userId
        ? `SELECT ask_text, agent_id, created_at FROM chat.deep_confirm
           WHERE (user_id=$1 OR (user_id IS NULL AND lower(user_email)=ANY($2))) AND huddle_id=$3 LIMIT 1`
        : `SELECT ask_text, agent_id, created_at FROM chat.deep_confirm WHERE user_email=$1 AND huddle_id=$2 LIMIT 1`,
      userId ? [userId, emails, huddleId] : [email, huddleId],
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
  try {
    await ensure();
    const { resolveScopeByEmail } = await import("../identity/identity.server");
    const { userId, emails } = await resolveScopeByEmail(email);
    await getPool().query(
      userId
        ? `DELETE FROM chat.deep_confirm WHERE (user_id=$1 OR (user_id IS NULL AND lower(user_email)=ANY($2))) AND huddle_id=$3`
        : `DELETE FROM chat.deep_confirm WHERE user_email=$1 AND huddle_id=$2`,
      userId ? [userId, emails, huddleId] : [email, huddleId],
    );
  } catch { /* best-effort */ }
}

/**
 * Classify a short user reply to a pending deep-1:1 produce-vs-quick confirm. Deterministic (no LLM).
 * - "produce"  → yes, make it a real produce task the team works async → artifact
 * - "quick"    → no, just give me a quick take here (resume inline on a chat-friendly tier)
 * - "cancel"   → drop it entirely
 * - "unrelated"→ the reply isn't answering the confirm; leave the pending and route normally
 */
export function classifyConfirmReply(text: string): "produce" | "quick" | "cancel" | "unrelated" {
  const t = (text || "").trim().toLowerCase();
  // Cancel first (an explicit "no, forget it" shouldn't be caught by the produce "yes" family).
  if (/^(no,?\s*(thanks|nvm|never ?mind|forget it|drop it)|cancel|never ?mind|stop|skip|forget it|drop it)\b/.test(t))
    return "cancel";
  // Quick / chat-friendly take.
  if (/\b(quick|just (a )?(quick|short|brief)|chat|here|inline|short|brief|tl;?dr|just answer|off the cuff|summar)/.test(t))
    return "quick";
  // Produce it async → artifact.
  if (/^(produce|yes|yep|yeah|go|go ahead|do it|make it|build it|research it|draft it|full|work it|proceed|sure|please do|create the task|task it)\b/.test(t))
    return "produce";
  if (/\b(produce|make it a task|as a task|work on it|async|artifact|full (write|work) ?up|deep dive|do the (research|work))/.test(t))
    return "produce";
  // A GREEN LIGHT ANYWHERE IN THE LINE, not just at the start. The two patterns above are anchored
  // with `^`, and that is exactly how the measured defect happened: the ask fired at 01:32, the owner
  // replied "Go for it" (caught by `^go\b`) and then "Okay knock it out" — which starts with "okay",
  // matches neither pattern, and was classified "unrelated", so the gate kept asking a question the
  // owner had answered three times. Verified before the fix: classifyConfirmReply("Okay knock it out")
  // returned "unrelated". Owner: "need to make sure it works and doesn't ignore a green light."
  if (isGreenLight(text)) return "produce";
  return "unrelated";
}

/**
 * The produce-vs-quick ask itself.
 *
 * Two things the owner named, and one honest limitation:
 *  - THE WORDING. "the wording is bad and it needs a cleanup that will help." The old copy opened
 *    "That's a meaty one." and read like a form: it named the mechanism ("take it on as a task, do the
 *    deep work async") instead of the outcome the user cares about, and ended in a quoted command
 *    list. This says what the user gets either way, in the order they'd choose in.
 *  - EVERY AGENT RECITED IT IDENTICALLY, because it is a hardcoded literal returned before any
 *    persona/snapshot call. Fully voicing it through the persona would mean a model call, which is the
 *    exact cost this gate exists to avoid — so instead each agent gets a STABLE variant chosen by its
 *    id: Cole always phrases it one way, Elle another, and no agent's phrasing wanders between turns.
 *    That removes the chorus effect for the price of nothing. It is NOT full persona voicing, and if
 *    that is wanted it needs a cheap model tier here, not a bigger literal.
 *
 * Every variant keeps the produce / quick / cancel contract `classifyConfirmReply` parses, and keeps
 * those three words bold and literal so the reply is easy to give.
 */
const PRODUCE_VS_QUICK_VARIANTS: (() => string)[] = [
  () =>
    "That's a real piece of work, not a chat answer. I can **produce** it — put it on the board, dig in " +
    "properly, and come back with a draft you can mark up. Or a **quick** take right now, off what I " +
    "already know. Which would you rather? (**cancel** if you'd sooner park it.)",
  () =>
    "Happy to run at this properly. Two ways: **produce** — I take it away, do the work, hand you " +
    "something written to react to. Or **quick** — my read right here, right now, off the top. Say " +
    "which, or **cancel** and I'll drop it.",
  () =>
    "This one deserves more than a paragraph. Want me to **produce** it (I'll work it up and bring you " +
    "a draft to pick apart) or give you a **quick** answer here and now? **cancel** if it can wait.",
  () =>
    "I can go two ways on this. **produce**: on the board, worked properly, a draft back to you. " +
    "**quick**: an answer in this thread in a few seconds, no digging. Your call — or **cancel** it.",
];

export function produceVsQuickAsk(agentId: string | null | undefined): string {
  // Stable per agent (a sum over the id), so an agent's phrasing never wanders between turns — a
  // teammate who says it differently every time reads as MORE robotic, not less.
  const id = agentId ?? "";
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h + id.charCodeAt(i)) % 9973;
  return PRODUCE_VS_QUICK_VARIANTS[h % PRODUCE_VS_QUICK_VARIANTS.length]();
}
