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
    // Parameterized multi-row INSERT. 13 columns per row.
    const cols = 13;
    const values: unknown[] = [];
    const tuples: string[] = [];
    turns.forEach((t, i) => {
      const b = i * cols;
      tuples.push(
        `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},$${b + 9},$${b + 10},$${b + 11},$${b + 12},$${b + 13})`,
      );
      values.push(
        runId,
        huddleId,
        email,
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
         (run_id, huddle_id, user_email, seq, speaker, agent_id, text, kind, interrupted, block_id, sentence_index, block_total, ts)
       VALUES ${tuples.join(",")}`,
      values,
    );
    return { ok: true, inserted: turns.length };
  } catch (err) {
    console.error("[ceremony-transcript] append failed:", err);
    return { ok: false, inserted: 0 };
  }
}

// Ordered rows for one run, scoped to the caller's email — a wrong owner returns [].
export async function getCeremonyRun(email: string, runId: string): Promise<CeremonyTranscriptRow[]> {
  if (!email || !runId) return [];
  try {
    await ensureBootstrapped();
    const r = await getPool().query<CeremonyTranscriptRow>(
      `SELECT id, run_id, huddle_id, user_email, seq, speaker, agent_id, text, kind,
              interrupted, block_id, sentence_index, block_total, ts, created_at
       FROM chat.ceremony_transcript
       WHERE user_email = $1 AND run_id = $2
       ORDER BY seq ASC, id ASC`,
      [email, runId],
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
    const r = await getPool().query<CeremonyRunSummary>(
      `SELECT run_id,
              MAX(huddle_id)          AS huddle_id,
              MIN(ts)                 AS started_at,
              COUNT(*)::int           AS turn_count
       FROM chat.ceremony_transcript
       WHERE user_email = $1
       GROUP BY run_id
       ORDER BY MIN(created_at) DESC
       LIMIT $2`,
      [email, limit],
    );
    return r.rows;
  } catch (err) {
    console.error("[ceremony-transcript] listRuns failed:", err);
    return [];
  }
}
