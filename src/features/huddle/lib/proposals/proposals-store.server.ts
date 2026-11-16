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
import type { NewProposal, PriorProposal, ProposalRow, ProposalSourceRef, ProposalState, ProposalStore, UpsertOutcome } from "./proposals";
import type { TriageOutcome, TriageStore } from "./meeting-triage";

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
                        CHECK (state IN ('proposed','approved','completed','dismissed','untriaged','delegated')),
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
-- AC-correspondence-redesign R5.13: meeting triage adds two states. CREATE TABLE IF NOT EXISTS above never
-- changes the CHECK of a table that already exists, so an explicit, idempotent migration: replace the state
-- CHECK only when it does not yet allow 'untriaged'. A concurrent bootstrap that loses the race is harmless
-- (duplicate_object is swallowed; the winner's constraint is the same).
DO $mig$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'chat.task_proposals'::regclass AND contype = 'c'
       AND pg_get_constraintdef(oid) LIKE '%state%' AND pg_get_constraintdef(oid) LIKE '%untriaged%'
  ) THEN
    ALTER TABLE chat.task_proposals DROP CONSTRAINT IF EXISTS task_proposals_state_check;
    BEGIN
      ALTER TABLE chat.task_proposals ADD CONSTRAINT task_proposals_state_check
        CHECK (state IN ('proposed','approved','completed','dismissed','untriaged','delegated'));
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
  END IF;
END
$mig$;
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

/** COLS with every column qualified by the alias `p` (for joins). */
const COLS_P = `p.id, p.owner_email, p.state, p.title, p.original_title, p.norm_title, p.edited, p.evidence, p.assignee, p.due_text,
  to_char(p.due_date, 'YYYY-MM-DD') AS due_date, p.sources, p.task_id,
  to_char(p.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
  to_char(p.decided_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS decided_at`;

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

export const pgProposalStore: ProposalStore & TriageStore = {
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

  async priorRelated(owners, ref, normTitle) {
    await ensureBootstrapped();
    const own = lower(owners);
    const r = await getPool().query<{ id: string; norm_title: string; state: ProposalState; same_item: boolean }>(
      `SELECT p.id, p.norm_title, p.state,
              EXISTS (SELECT 1 FROM chat.task_proposal_refs r
                       WHERE r.proposal_id = p.id AND r.source = $2 AND r.source_item_id = $3) AS same_item
         FROM chat.task_proposals p
        WHERE p.owner_email = ANY($1)
          AND (p.id IN (SELECT proposal_id FROM chat.task_proposal_refs
                         WHERE owner_email = ANY($1) AND source = $2 AND source_item_id = $3)
               OR (p.norm_title = $4 AND p.state = 'dismissed'
                   -- AC-R5.11 + F15: a SKIPPED meeting item (first source a meeting) suppresses only that
                   -- meeting's item (the refs), never the same to-do asked of the owner elsewhere.
                   AND COALESCE(p.sources->0->>'source', '') <> 'transcript'))
        ORDER BY p.created_at, p.id
        LIMIT 100`,
      [own, ref.source, ref.sourceItemId, normTitle],
    );
    return r.rows.map((x): PriorProposal => ({ id: x.id, normTitle: x.norm_title, state: x.state, sameItem: x.same_item }));
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

  // ── Meeting triage (AC-correspondence-redesign R5) ──────────────────────────────────────────────────

  async addTriageRows(rows) {
    await ensureBootstrapped();
    const created: string[] = [];
    const existing: string[] = [];
    for (const p of rows) {
      const owner = p.owner.trim().toLowerCase();
      const refJson = JSON.stringify([{ source: p.ref.source, sourceItemId: p.ref.sourceItemId, at: p.ref.at, context: p.ref.context ?? null }]);
      const out = await inTx(async (c) => {
        // The refs are the memory: an item seen for this meeting before (any state, merged included) is never
        // re-created -- a Skip never reappears (AC-R5.11), an update adds only its NEW items (AC-R5.7).
        const seen = await c.query<{ proposal_id: string }>(
          `SELECT proposal_id FROM chat.task_proposal_refs
            WHERE owner_email = $1 AND source = $2 AND source_item_id = $3 AND norm_title = $4`,
          [owner, p.ref.source, p.ref.sourceItemId, p.normTitle],
        );
        if (seen.rows[0]) return { kind: "existing" as const, id: seen.rows[0].proposal_id };
        // Never attached to an active proposal here: the owner triages first ("then and only then").
        await c.query(
          `INSERT INTO chat.task_proposals (id, owner_email, state, title, original_title, norm_title, evidence, sources)
           VALUES ($1,$2,'untriaged',$3,$3,$4,$5,$6::jsonb)
           ON CONFLICT (id) DO NOTHING`,
          [p.id, owner, p.title, p.normTitle, p.evidence, refJson],
        );
        const ref = await c.query(
          `INSERT INTO chat.task_proposal_refs (owner_email, source, source_item_id, norm_title, proposal_id)
           VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
          [owner, p.ref.source, p.ref.sourceItemId, p.normTitle, p.id],
        );
        return { kind: ref.rowCount ? ("created" as const) : ("existing" as const), id: p.id };
      });
      (out.kind === "created" ? created : existing).push(out.id);
    }
    return { created, existing };
  },

  async triage(owners, id, target, assignee): Promise<TriageOutcome> {
    await ensureBootstrapped();
    const own = lower(owners);
    for (let i = 0; ; i++) {
      try {
        return await inTx(async (c): Promise<TriageOutcome> => {
          // Compare-and-set on `untriaged` (AC-R5.17): the row lock makes a double tap apply exactly once.
          const cur = await c.query<DbRow>(`SELECT ${COLS} FROM chat.task_proposals WHERE id = $2 AND owner_email = ANY($1) FOR UPDATE`, [own, id]);
          const row = cur.rows[0] ? toRow(cur.rows[0]) : null;
          if (!row || row.state !== "untriaged") return { applied: false, row };
          if (target === "proposed") {
            // One proposal per to-do (OQ-9): Mine on a to-do that is already active from another source moves
            // this meeting's ref onto that proposal, and this row leaves the triage queue.
            const act = await c.query<{ id: string }>(
              `SELECT id FROM chat.task_proposals WHERE owner_email = $1 AND norm_title = $2 AND state = 'proposed' FOR UPDATE`,
              [row.owner, row.normTitle],
            );
            if (act.rows[0]) {
              const into = act.rows[0].id;
              const meeting = row.sources[0];
              await c.query(
                `UPDATE chat.task_proposal_refs SET proposal_id = $5
                  WHERE owner_email = $1 AND source = $2 AND source_item_id = $3 AND norm_title = $4 AND proposal_id = $6`,
                [row.owner, meeting?.source ?? "transcript", meeting?.sourceItemId ?? "", row.normTitle, into, row.id],
              );
              const m = await c.query<DbRow>(
                `UPDATE chat.task_proposals SET sources = sources || $2::jsonb, updated_at = now() WHERE id = $1 RETURNING ${COLS}`,
                [into, JSON.stringify(row.sources.slice(0, 1))],
              );
              const done = await c.query<DbRow>(
                `UPDATE chat.task_proposals SET state = 'dismissed', decided_at = now(), updated_at = now() WHERE id = $1 RETURNING ${COLS}`,
                [row.id],
              );
              return { applied: true, row: toRow(done.rows[0]), mergedInto: m.rows[0] ? toRow(m.rows[0]) : null };
            }
          }
          const r = await c.query<DbRow>(
            `UPDATE chat.task_proposals
                SET state = $2::text, assignee = CASE WHEN $2::text = 'delegated' THEN $3::text ELSE assignee END,
                    decided_at = CASE WHEN $2::text = 'proposed' THEN NULL ELSE now() END, updated_at = now()
              WHERE id = $1 AND state = 'untriaged'
              RETURNING ${COLS}`,
            [row.id, target, target === "delegated" ? assignee : null],
          );
          return r.rows[0] ? { applied: true, row: toRow(r.rows[0]) } : { applied: false, row };
        });
      } catch (e) {
        // Mine racing an email proposal of the same to-do (the active-title unique index): re-evaluate (merge).
        if ((e as { code?: string }).code === "23505" && i < 3) continue;
        throw e;
      }
    }
  },

  async listMeetingQueue(owners) {
    await ensureBootstrapped();
    const r = await getPool().query<DbRow & { meeting_id: string }>(
      `SELECT ${COLS_P}, rf.source_item_id AS meeting_id
         FROM chat.task_proposal_refs rf JOIN chat.task_proposals p ON p.id = rf.proposal_id
        WHERE rf.owner_email = ANY($1) AND rf.source = 'transcript' AND p.owner_email = ANY($1)
        ORDER BY p.created_at, p.id
        LIMIT 2000`,
      [lower(owners)],
    );
    return r.rows.map((x) => ({ ...toRow(x), meetingId: x.meeting_id }));
  },

  async listUntriaged(owners) {
    await ensureBootstrapped();
    const r = await getPool().query<DbRow>(
      `SELECT ${COLS} FROM chat.task_proposals WHERE owner_email = ANY($1) AND state = 'untriaged' ORDER BY created_at, id LIMIT 200`,
      [lower(owners)],
    );
    return r.rows.map(toRow);
  },
};
