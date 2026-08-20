// Durable, reviewable ceremony/stand-up transcripts. The live interactive transcript renders from
// the ephemeral zustand `meeting.transcript` (store.ts, no persist middleware), so once a ceremony
// ends — or the tab reloads — the whole group session is gone and a live DB query returns ZERO agent
// lines. This store PERSISTS every ceremony turn (scripted agent sentences, user barge utterances,
// interruptions, barge answers) to Azure PG so a run is durably reviewable afterwards.
//
// Same Azure-PG bootstrap pattern as tasks.server.ts / turns.server.ts / identity.server.ts — a
// module-local pool with lazy CREATE SCHEMA/TABLE IF NOT EXISTS on first use. Every read is
// email-scoped so one user can never read another's transcript.
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

CREATE TABLE IF NOT EXISTS chat.ceremony_transcript (
  id             BIGSERIAL PRIMARY KEY,
  run_id         TEXT NOT NULL,
  huddle_id      TEXT NOT NULL,
  user_email     TEXT NOT NULL,
  seq            INT NOT NULL,
  speaker        TEXT NOT NULL CHECK (speaker IN ('user','agent','system')),
  agent_id       TEXT,
  text           TEXT NOT NULL,
  kind           TEXT DEFAULT '',
  interrupted    BOOLEAN DEFAULT false,
  block_id       TEXT,
  sentence_index INT,
  block_total    INT,
  ts             TIMESTAMPTZ,
  created_at     TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ceremony_transcript_run_idx
  ON chat.ceremony_transcript (user_email, run_id, seq);
CREATE INDEX IF NOT EXISTS ceremony_transcript_recent_idx
  ON chat.ceremony_transcript (user_email, created_at DESC);

-- Tool-call tracking (added 2026-08-02): a kind='tool' row records an ACTUAL tool invocation during a
-- ceremony turn, so a reviewer can prove "the agent SAID it parked but no update_task row exists" vs
-- "row exists, tool_ok=false". Additive columns — ADD COLUMN IF NOT EXISTS keeps existing rows intact.
ALTER TABLE chat.ceremony_transcript ADD COLUMN IF NOT EXISTS tool_name  TEXT;
ALTER TABLE chat.ceremony_transcript ADD COLUMN IF NOT EXISTS tool_args  JSONB;
ALTER TABLE chat.ceremony_transcript ADD COLUMN IF NOT EXISTS tool_ok    BOOLEAN;
ALTER TABLE chat.ceremony_transcript ADD COLUMN IF NOT EXISTS tool_error TEXT;
-- Identity unification: key on the stable user_id (entra_object_id) with user_email retained as a
-- fallback + display. Resolved in-store from the passed email via resolveScopeByEmail, so both of a
-- user's emails converge to one transcript regardless of which email a caller presents.
ALTER TABLE chat.ceremony_transcript ADD COLUMN IF NOT EXISTS user_id TEXT;
CREATE INDEX IF NOT EXISTS ceremony_transcript_userid_idx ON chat.ceremony_transcript(user_id);
`;

let bootstrapped: Promise<void> | null = null;
async function ensureBootstrapped(): Promise<void> {
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

export type CeremonySpeaker = "user" | "agent" | "system";

// One transcript turn as sent from the client. `seq` is a strictly-increasing per-run cursor stamped
// in insertion order by the client, so the run replays in the exact order it was spoken.
export interface CeremonyTurnInput {
  seq: number;
  speaker: CeremonySpeaker;
  agentId?: string | null;
  text: string;
  kind?: string | null;
  interrupted?: boolean | null;
  blockId?: string | null;
  sentenceIndex?: number | null;
  blockTotal?: number | null;
  ts?: number | null; // epoch ms
}

export interface CeremonyTranscriptRow {
  id: string;
  run_id: string;
  huddle_id: string;
  user_email: string;
  seq: number;
  speaker: CeremonySpeaker;
  agent_id: string | null;
  text: string;
  kind: string | null;
  interrupted: boolean | null;
  block_id: string | null;
  sentence_index: number | null;
  block_total: number | null;
  ts: string | null;
  created_at: string;
}

export interface CeremonyRunSummary {
  run_id: string;
  huddle_id: string;
  started_at: string | null;
  turn_count: number;
}

// Batch-append transcript turns for a run. Fire-and-forget safe: NEVER throws to the caller — a DB
// failure must not stall or break a live ceremony. Returns {ok:false} on any error instead.
export async function appendCeremonyTurns(
  email: string,
  runId: string,
  huddleId: string,
  turns: CeremonyTurnInput[],
): Promise<{ ok: boolean; inserted: number }> {
  if (!email || !runId || !huddleId || turns.length === 0) return { ok: true, inserted: 0 };
  try {
    await ensureBootstrapped();
    // Resolve the stable user_id ONCE for the whole batch (dual-write: user_id primary + user_email fallback).
    const { resolveScopeByEmail } = await import("../identity/identity.server");
    const { userId } = await resolveScopeByEmail(email);
    // Parameterized multi-row INSERT. 14 columns per row.
    const cols = 14;
    const values: unknown[] = [];
    const tuples: string[] = [];
    turns.forEach((t, i) => {
      const b = i * cols;
      tuples.push(
        `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},$${b + 9},$${b + 10},$${b + 11},$${b + 12},$${b + 13},$${b + 14})`,
      );
      values.push(
        runId,
        huddleId,
        email,
        userId,
        t.seq,
        t.speaker,
        t.agentId ?? null,
        t.text,
        t.kind ?? "",
        t.interrupted ?? false,
        t.blockId ?? null,
        t.sentenceIndex ?? null,
        t.blockTotal ?? null,
        t.ts != null ? new Date(t.ts).toISOString() : null,
      );
    });
    await getPool().query(
      `INSERT INTO chat.ceremony_transcript
         (run_id, huddle_id, user_email, user_id, seq, speaker, agent_id, text, kind, interrupted, block_id, sentence_index, block_total, ts)
       VALUES ${tuples.join(",")}`,
      values,
    );
    return { ok: true, inserted: turns.length };
  } catch (err) {
    console.error("[ceremony-transcript] append failed:", err);
    return { ok: false, inserted: 0 };
  }
}

// One tool invocation made during a ceremony turn (server-side — the model's tool calls run in
// runHuddleTurn, not on the client, so the client-buffered spoken transcript can't see them).
export interface CeremonyToolCallInput {
  agentId?: string | null;
  toolName: string;
  args?: unknown;
  ok: boolean;
  error?: string | null;
  summary?: string | null;
  ts?: number | null; // epoch ms
}

// Persist ONE tool call against a run. Fire-and-forget safe: NEVER throws — a tracking-write failure
// must never break a live ceremony turn. The row is speaker='agent', kind='tool'; seq is max(seq)+1
// for the run so a tool row sorts just after whatever had been said when it fired.
export async function appendCeremonyToolCall(
  email: string,
  runId: string,
  huddleId: string,
  call: CeremonyToolCallInput,
): Promise<{ ok: boolean }> {
  if (!email || !runId || !huddleId || !call?.toolName) return { ok: false };
  try {
    await ensureBootstrapped();
    const { resolveScopeByEmail } = await import("../identity/identity.server");
    const { userId } = await resolveScopeByEmail(email);
    await getPool().query(
      `INSERT INTO chat.ceremony_transcript
         (run_id, huddle_id, user_email, user_id, seq, speaker, agent_id, text, kind, ts,
          tool_name, tool_args, tool_ok, tool_error)
       SELECT $1, $2, $3, $11,
              COALESCE((SELECT MAX(seq) FROM chat.ceremony_transcript WHERE run_id = $1 AND user_email = $3), 0) + 1,
              'agent', $4, $5, 'tool', $6, $7, $8, $9, $10`,
      [
        runId,
        huddleId,
        email,
        call.agentId ?? null,
        call.summary ?? `${call.toolName} ${call.ok ? "ok" : "FAILED"}`,
        call.ts != null ? new Date(call.ts).toISOString() : null,
        call.toolName,
        call.args != null ? JSON.stringify(call.args) : null,
        call.ok,
        call.error ?? null,
        userId,
      ],
    );
    return { ok: true };
  } catch (err) {
    console.error("[ceremony-transcript] tool-call append failed:", err);
    return { ok: false };
  }
}

// E (F13) — tool-lifecycle START marker. The existing appendCeremonyToolCall records a tool at its
// END (ok/summary known). For HONEST, event-driven progress narration the client also needs to know a
// tool has just STARTED (so it can voice "running a search…" the instant the search actually begins,
// never on a guess). We persist a kind='tool_start' row keyed to the run; the client polls
// getCeremonyToolEvents during a barge and voices ONE cue per real start. Fire-and-forget safe: a
// tracking-write failure must NEVER break a live ceremony turn. tool_ok is left NULL (not yet known).
export async function appendCeremonyToolStart(
  email: string,
  runId: string,
  huddleId: string,
  call: { agentId?: string | null; toolName: string; ts?: number | null },
): Promise<{ ok: boolean }> {
  if (!email || !runId || !huddleId || !call?.toolName) return { ok: false };
  try {
    await ensureBootstrapped();
    const { resolveScopeByEmail } = await import("../identity/identity.server");
    const { userId } = await resolveScopeByEmail(email);
    await getPool().query(
      `INSERT INTO chat.ceremony_transcript
         (run_id, huddle_id, user_email, user_id, seq, speaker, agent_id, text, kind, ts, tool_name)
       SELECT $1, $2, $3, $8,
              COALESCE((SELECT MAX(seq) FROM chat.ceremony_transcript WHERE run_id = $1 AND user_email = $3), 0) + 1,
              'agent', $4, $5, 'tool_start', $6, $7`,
      [
        runId,
        huddleId,
        email,
        call.agentId ?? null,
        `${call.toolName} started`,
        call.ts != null ? new Date(call.ts).toISOString() : null,
        call.toolName,
        userId,
      ],
    );
    return { ok: true };
  } catch (err) {
    console.error("[ceremony-transcript] tool-start append failed:", err);
    return { ok: false };
  }
}

// E (F13) — lean tool-lifecycle feed for the client narration driver. Returns the tool START ('tool_start')
// and END ('tool') rows for a run newer than `sinceId` (a `> id` cursor), oldest-first, email-scoped so a
// wrong owner gets []. Deliberately narrow (id/agent/tool/phase/ok only) so it stays cheap to poll every
// ~700ms during a barge — it is NOT the full-transcript read (getCeremonyRun).
export interface CeremonyToolEvent {
  id: string;
  agentId: string | null;
  toolName: string;
  phase: "start" | "end";
  ok: boolean | null;
}
export async function getCeremonyToolEvents(
  email: string,
  runId: string,
  sinceId: string,
): Promise<CeremonyToolEvent[]> {
  if (!email || !runId) return [];
  try {
    await ensureBootstrapped();
    const { resolveScopeByEmail } = await import("../identity/identity.server");
    const { userId, emails } = await resolveScopeByEmail(email);
    const r = await getPool().query<{
      id: string;
      agent_id: string | null;
      tool_name: string | null;
      kind: string | null;
      tool_ok: boolean | null;
    }>(
      userId
        ? `SELECT id, agent_id, tool_name, kind, tool_ok
           FROM chat.ceremony_transcript
           WHERE (user_id = $1 OR (user_id IS NULL AND lower(user_email) = ANY($2)))
             AND run_id = $3 AND kind IN ('tool_start','tool') AND id > $4
           ORDER BY id ASC
           LIMIT 50`
        : `SELECT id, agent_id, tool_name, kind, tool_ok
           FROM chat.ceremony_transcript
           WHERE user_email = $1 AND run_id = $2 AND kind IN ('tool_start','tool') AND id > $3
           ORDER BY id ASC
           LIMIT 50`,
      userId ? [userId, emails, runId, sinceId || "0"] : [email, runId, sinceId || "0"],
    );
    return r.rows
      .filter((row) => !!row.tool_name)
      .map((row) => ({
        id: String(row.id),
        agentId: row.agent_id,
        toolName: row.tool_name as string,
        phase: row.kind === "tool_start" ? ("start" as const) : ("end" as const),
        ok: row.tool_ok,
      }));
  } catch (err) {
    console.error("[ceremony-transcript] getToolEvents failed:", err);
    return [];
  }
}

// Ordered rows for one run, scoped to the caller's email — a wrong owner returns [].
export async function getCeremonyRun(email: string, runId: string): Promise<CeremonyTranscriptRow[]> {
  if (!email || !runId) return [];
  try {
    await ensureBootstrapped();
    const { resolveScopeByEmail } = await import("../identity/identity.server");
    const { userId, emails } = await resolveScopeByEmail(email);
    const r = await getPool().query<CeremonyTranscriptRow>(
      userId
        ? `SELECT id, run_id, huddle_id, user_email, seq, speaker, agent_id, text, kind,
                  interrupted, block_id, sentence_index, block_total, ts, created_at
           FROM chat.ceremony_transcript
           WHERE (user_id = $1 OR (user_id IS NULL AND lower(user_email) = ANY($2))) AND run_id = $3
           ORDER BY seq ASC, id ASC`
        : `SELECT id, run_id, huddle_id, user_email, seq, speaker, agent_id, text, kind,
                  interrupted, block_id, sentence_index, block_total, ts, created_at
           FROM chat.ceremony_transcript
           WHERE user_email = $1 AND run_id = $2
           ORDER BY seq ASC, id ASC`,
      userId ? [userId, emails, runId] : [email, runId],
    );
    return r.rows;
  } catch (err) {
    console.error("[ceremony-transcript] getRun failed:", err);
    return [];
  }
}

// Distinct runs for a user, newest first — run_id + huddle_id + started_at (min ts) + turn count.
export async function listCeremonyRuns(email: string, limit = 20): Promise<CeremonyRunSummary[]> {
  if (!email) return [];
  try {
    await ensureBootstrapped();
    const { resolveScopeByEmail } = await import("../identity/identity.server");
    const { userId, emails } = await resolveScopeByEmail(email);
    const r = await getPool().query<CeremonyRunSummary>(
      // Exclude 1:1 voice-call transcripts (huddle_id 'dm-<agent>') — the ceremony_transcript table is
      // reused as the durable store for 1:1 voice calls (ACT-huddle-32), but those are NOT ceremony runs
      // and must not appear in the ceremony run list.
      userId
        ? `SELECT run_id,
                  MAX(huddle_id)          AS huddle_id,
                  MIN(ts)                 AS started_at,
                  COUNT(*)::int           AS turn_count
           FROM chat.ceremony_transcript
           WHERE (user_id = $1 OR (user_id IS NULL AND lower(user_email) = ANY($2)))
             AND huddle_id NOT LIKE 'dm-%'
           GROUP BY run_id
           ORDER BY MIN(created_at) DESC
           LIMIT $3`
        : `SELECT run_id,
                  MAX(huddle_id)          AS huddle_id,
                  MIN(ts)                 AS started_at,
                  COUNT(*)::int           AS turn_count
           FROM chat.ceremony_transcript
           WHERE user_email = $1
             AND huddle_id NOT LIKE 'dm-%'
           GROUP BY run_id
           ORDER BY MIN(created_at) DESC
           LIMIT $2`,
      userId ? [userId, emails, limit] : [email, limit],
    );
    return r.rows;
  } catch (err) {
    console.error("[ceremony-transcript] listRuns failed:", err);
    return [];
  }
}
