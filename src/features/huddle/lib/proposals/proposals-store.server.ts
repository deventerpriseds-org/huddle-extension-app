// WHAT:       Azure PG store for TASK PROPOSALS: one row per proposed to-do (`chat.task_proposals`, states
//             proposed / approved / completed / dismissed) plus one row per (source item, to-do) seen
//             (`chat.task_proposal_refs`), which is the dedup memory across every state.
// WHY:        AC docs/ac/AC-correspondence-checklist.md AC-5.4/5.5/5.8/5.11-5.13/5.21: proposals must survive a
//             reload, a second device and a container restart (the client's checklistState does not), stay
//             owner-scoped, leave the active queue once decided but keep their history for audit and dedup,
//             and Approve must create exactly one task even when tapped twice or on two devices.
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   scripts/task-proposals-sql.test.ts (real PostgreSQL); docs/qc-evidence/IMPL-task-proposals.md.
//
// Shared pool + lazy idempotent bootstrap, the minutes-store.server.ts pattern. Stores the to-do text, the
// short verbatim evidence span and source REFERENCES (kind, provider id, time, subject/chat name for the
// owner's own display) -- never a message body, never a sender address. Nothing here logs content.
import type { Pool, PoolClient } from "pg";
import { getSharedPool } from "../db/shared-pool.server";
import type { NewProposal, ProposalRow, ProposalSourceRef, ProposalState, ProposalStore, UpsertOutcome } from "./proposals";

let _pool: Pool | null = null;
function getPool(): Pool {
  if (_pool) return _pool;
  if (!process.env.AZURE_PG_URL) throw new Error("AZURE_PG_URL not configured");
  _pool = getSharedPool();
  return _pool;
}

const BOOTSTRAP_SQL = `
CREATE SCHEMA IF NOT EXISTS chat;
CREATE TABLE IF NOT EXISTS chat.task_proposals (
  id                  TEXT PRIMARY KEY CHECK (id LIKE 'prop-%'),
  owner_email         TEXT NOT NULL,
  state               TEXT NOT NULL DEFAULT 'proposed'
                        CHECK (state IN ('proposed','approved','completed','dismissed')),
  title               TEXT NOT NULL,              -- current text (the owner's edit wins)
  original_title      TEXT NOT NULL,              -- what extraction proposed
  norm_title          TEXT NOT NULL,              -- normalizeTaskTitle(original_title): the dedup key
  edited              BOOLEAN NOT NULL DEFAULT false,
  evidence            TEXT NOT NULL,              -- verbatim span of the source (validator-checked)
  assignee            TEXT,                       -- only when the span names a person
  due_text            TEXT,                       -- only the span's own date words
  due_date            DATE,
  sources             JSONB NOT NULL DEFAULT '[]'::jsonb,
  task_id             TEXT,                       -- the journey task Approve created or linked
  approve_lease_until TIMESTAMPTZ,                -- compare-and-set claim while Approve runs
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at          TIMESTAMPTZ
);
-- ONE active proposal per to-do per owner (cross-source dedup, OQ-9).
CREATE UNIQUE INDEX IF NOT EXISTS task_proposals_active_title_idx
  ON chat.task_proposals (owner_email, norm_title) WHERE state = 'proposed';
CREATE INDEX IF NOT EXISTS task_proposals_owner_state_idx ON chat.task_proposals (owner_email, state);
-- Every (source item, to-do) ever seen, whatever its proposal's state: the dedup memory (AC-5.12, 5.21).
CREATE TABLE IF NOT EXISTS chat.task_proposal_refs (
  owner_email    TEXT NOT NULL,
  source         TEXT NOT NULL CHECK (source IN ('email','teams','transcript')),
  source_item_id TEXT NOT NULL,
  norm_title     TEXT NOT NULL,
  proposal_id    TEXT NOT NULL REFERENCES chat.task_proposals(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_email, source, source_item_id, norm_title)
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

const COLS = `id, owner_email, state, title, original_title, norm_title, edited, evidence, assignee, due_text,
  to_char(due_date, 'YYYY-MM-DD') AS due_date, sources, task_id,
  to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
  to_char(decided_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS decided_at`;

type DbRow = {
  id: string;
  owner_email: string;
  state: ProposalState;
  title: string;
  original_title: string;
  norm_title: string;
  edited: boolean;
  evidence: string;
  assignee: string | null;
  due_text: string | null;
  due_date: string | null;
  sources: ProposalSourceRef[] | null;
  task_id: string | null;
  created_at: string;
  decided_at: string | null;
};

const toRow = (r: DbRow): ProposalRow => ({
  id: r.id,
  owner: r.owner_email,
  state: r.state,
  title: r.title,
  originalTitle: r.original_title,
  normTitle: r.norm_title,
  edited: r.edited,
  evidence: r.evidence,
  assignee: r.assignee,
  dueText: r.due_text,
  dueDate: r.due_date,
  // jsonb does not keep key order: rebuild each ref in one fixed shape.
  sources: (Array.isArray(r.sources) ? r.sources : []).map((s) => ({
    source: s.source,
    sourceItemId: s.sourceItemId,
    at: s.at ?? null,
    context: s.context ?? null,
  })),
  taskId: r.task_id,
  createdAt: r.created_at,
  decidedAt: r.decided_at,
});

const lower = (xs: string[]) => [...new Set(xs.map((x) => x.trim().toLowerCase()).filter(Boolean))];

async function inTx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await getPool().connect();
  try {
    await c.query("BEGIN");
    const out = await fn(c);
    await c.query("COMMIT");
    return out;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

class Retry extends Error {}

async function upsertOnce(p: NewProposal): Promise<UpsertOutcome> {
  const owner = p.owner.trim().toLowerCase();
  const refJson = JSON.stringify([{ source: p.ref.source, sourceItemId: p.ref.sourceItemId, at: p.ref.at, context: p.ref.context ?? null }]);
  return inTx(async (c) => {
    // 1. Seen before, in ANY state: nothing changes (a dismissed to-do is never re-proposed from the same
    //    source; an edited one is never overwritten by a re-read).
    const seen = await c.query<{ proposal_id: string }>(
      `SELECT proposal_id FROM chat.task_proposal_refs
        WHERE owner_email = $1 AND source = $2 AND source_item_id = $3 AND norm_title = $4`,
      [owner, p.ref.source, p.ref.sourceItemId, p.normTitle],
    );
    if (seen.rows[0]) return { kind: "seen", id: seen.rows[0].proposal_id } as const;
    // 2. The same to-do is already ACTIVE from another source: attach this ref (OQ-9, one proposal).
    const active = await c.query<{ id: string }>(
      `SELECT id FROM chat.task_proposals WHERE owner_email = $1 AND norm_title = $2 AND state = 'proposed' FOR UPDATE`,
      [owner, p.normTitle],
    );
    if (active.rows[0]) {
      const id = active.rows[0].id;
      const ref = await c.query(
        `INSERT INTO chat.task_proposal_refs (owner_email, source, source_item_id, norm_title, proposal_id)
         VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
        [owner, p.ref.source, p.ref.sourceItemId, p.normTitle, id],
      );
      if (!ref.rowCount) throw new Retry(); // a concurrent writer recorded it first: re-evaluate
      await c.query(`UPDATE chat.task_proposals SET sources = sources || $2::jsonb, updated_at = now() WHERE id = $1`, [id, refJson]);
      return { kind: "attached", id } as const;
    }
    // 3. New proposal.
    const ins = await c.query(
      `INSERT INTO chat.task_proposals
         (id, owner_email, title, original_title, norm_title, evidence, assignee, due_text, due_date, sources)
       VALUES ($1,$2,$3,$3,$4,$5,$6,$7,$8::date,$9::jsonb)
       ON CONFLICT DO NOTHING`,
      [p.id, owner, p.title, p.normTitle, p.evidence, p.assignee, p.dueText, p.dueDate, refJson],
    );
    if (!ins.rowCount) throw new Retry(); // concurrent creator of the same to-do: re-evaluate (attach)
    await c.query(
      `INSERT INTO chat.task_proposal_refs (owner_email, source, source_item_id, norm_title, proposal_id)
       VALUES ($1,$2,$3,$4,$5)`,
      [owner, p.ref.source, p.ref.sourceItemId, p.normTitle, p.id],
    );
    return { kind: "created", id: p.id } as const;
  });
}

async function selectOne(owners: string[], id: string): Promise<ProposalRow | null> {
  const r = await getPool().query<DbRow>(`SELECT ${COLS} FROM chat.task_proposals WHERE id = $2 AND owner_email = ANY($1)`, [lower(owners), id]);
  return r.rows[0] ? toRow(r.rows[0]) : null;
}

export const pgProposalStore: ProposalStore = {
  async upsert(p) {
    await ensureBootstrapped();
    for (let i = 0; ; i++) {
      try {
        return await upsertOnce(p);
      } catch (e) {
        // A unique-index race (two passes, same to-do) re-evaluates; three rounds always settle it.
        const code = (e as { code?: string }).code;
        if ((e instanceof Retry || code === "23505") && i < 3) continue;
        throw e;
      }
    }
  },

  async listActive(owners) {
    await ensureBootstrapped();
    const r = await getPool().query<DbRow>(
      `SELECT ${COLS} FROM chat.task_proposals WHERE owner_email = ANY($1) AND state = 'proposed' ORDER BY created_at, id`,
      [lower(owners)],
    );
    return r.rows.map(toRow);
  },

  async getMany(owners, ids) {
    await ensureBootstrapped();
    if (!ids.length) return [];
    const r = await getPool().query<DbRow>(
      `SELECT ${COLS} FROM chat.task_proposals WHERE owner_email = ANY($1) AND id = ANY($2) ORDER BY created_at, id`,
      [lower(owners), ids],
    );
    return r.rows.map(toRow);
  },

  async claimApprove(owners, id, leaseSeconds) {
    await ensureBootstrapped();
    const r = await getPool().query<DbRow>(
      `UPDATE chat.task_proposals
          SET approve_lease_until = now() + make_interval(secs => $3), updated_at = now()
        WHERE id = $2 AND owner_email = ANY($1) AND state = 'proposed'
          AND (approve_lease_until IS NULL OR approve_lease_until < now())
        RETURNING ${COLS}`,
      [lower(owners), id, leaseSeconds],
    );
    if (r.rows[0]) return { claimed: true, row: toRow(r.rows[0]) };
    return { claimed: false, row: await selectOne(owners, id) };
  },

  async finishApprove(id, taskId) {
    await ensureBootstrapped();
    const r = await getPool().query<DbRow>(
      `UPDATE chat.task_proposals
          SET state = 'approved', task_id = $2, decided_at = now(), updated_at = now(), approve_lease_until = NULL
        WHERE id = $1 AND state = 'proposed'
        RETURNING ${COLS}`,
      [id, taskId],
    );
    return r.rows[0] ? toRow(r.rows[0]) : null;
  },

  async releaseApprove(id) {
    await ensureBootstrapped();
    await getPool().query(`UPDATE chat.task_proposals SET approve_lease_until = NULL WHERE id = $1 AND state = 'proposed'`, [id]);
  },

  async decide(owners, id, state) {
    await ensureBootstrapped();
    // Not while an Approve holds the lease: Approve and Dismiss racing must not both win.
    const r = await getPool().query<DbRow>(
      `UPDATE chat.task_proposals SET state = $3, decided_at = now(), updated_at = now()
        WHERE id = $2 AND owner_email = ANY($1) AND state = 'proposed'
          AND (approve_lease_until IS NULL OR approve_lease_until < now())
        RETURNING ${COLS}`,
      [lower(owners), id, state],
    );
    if (r.rows[0]) return { applied: true, row: toRow(r.rows[0]) };
    return { applied: false, row: await selectOne(owners, id) };
  },

  async edit(owners, id, title) {
    await ensureBootstrapped();
    const r = await getPool().query<DbRow>(
      `UPDATE chat.task_proposals SET title = $3, edited = true, updated_at = now()
        WHERE id = $2 AND owner_email = ANY($1) AND state = 'proposed'
          AND (approve_lease_until IS NULL OR approve_lease_until < now())
        RETURNING ${COLS}`,
      [lower(owners), id, title],
    );
    if (r.rows[0]) return { applied: true, row: toRow(r.rows[0]) };
    return { applied: false, row: await selectOne(owners, id) };
  },
};
