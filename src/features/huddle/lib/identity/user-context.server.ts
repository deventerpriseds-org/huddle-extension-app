// Executive Profile store — the persistent "user context / strategic relevance" every agent frames its
// work around. Email-scoped (same scoping as tasks/artifacts, via resolveTaskEmail) so the editor and the
// agent turn read/write the SAME row. Auto-bootstraps on first use. Azure PG (RAG_AI_Agents).
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
CREATE SCHEMA IF NOT EXISTS identity;
CREATE TABLE IF NOT EXISTS identity.user_context (
  email          TEXT PRIMARY KEY,
  goals          TEXT,
  ventures       TEXT,
  positioning    TEXT,
  audience       TEXT,
  income_targets TEXT,
  notes          TEXT,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Identity unification: key on the stable user_id (entra_object_id) with email retained as a fallback +
-- display. Resolved in-store from the passed email via resolveScopeByEmail, so both of a user's emails
-- converge to one context row regardless of which email a caller presents.
ALTER TABLE identity.user_context ADD COLUMN IF NOT EXISTS user_id TEXT;
CREATE INDEX IF NOT EXISTS user_context_userid_idx ON identity.user_context(user_id);
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

export interface UserContext {
  goals: string | null;
  ventures: string | null;
  positioning: string | null;
  audience: string | null;
  income_targets: string | null;
  notes: string | null;
}

const EMPTY: UserContext = {
  goals: null,
  ventures: null,
  positioning: null,
  audience: null,
  income_targets: null,
  notes: null,
};

function clean(v: unknown): string | null {
  const s = typeof v === "string" ? v.trim() : "";
  return s ? s.slice(0, 4000) : null;
}

/** Read the executive profile for an email. Returns null when nothing is set (→ zero prompt overhead). */
export async function getUserContext(email: string): Promise<UserContext | null> {
  await ensureBootstrapped();
  const { resolveScopeByEmail } = await import("./identity.server");
  const { userId, emails } = await resolveScopeByEmail(email);
  const r = await getPool().query<UserContext>(
    userId
      ? `SELECT goals, ventures, positioning, audience, income_targets, notes
           FROM identity.user_context
          WHERE user_id = $1 OR (user_id IS NULL AND lower(email) = ANY($2))
          ORDER BY (user_id IS NOT NULL) DESC, updated_at DESC
          LIMIT 1`
      : `SELECT goals, ventures, positioning, audience, income_targets, notes
           FROM identity.user_context WHERE lower(email) = lower($1) LIMIT 1`,
    userId ? [userId, emails] : [email],
  );
  if (r.rowCount === 0) return null;
  const row = r.rows[0];
  const anySet = Object.values(row).some((v) => typeof v === "string" && v.trim());
  return anySet ? row : null;
}

/** Whole-object upsert of the executive profile for an email. */
export async function setUserContext(email: string, patch: Partial<UserContext>): Promise<UserContext> {
  await ensureBootstrapped();
  const { resolveScopeByEmail } = await import("./identity.server");
  const { userId } = await resolveScopeByEmail(email);
  const next: UserContext = {
    goals: clean(patch.goals),
    ventures: clean(patch.ventures),
    positioning: clean(patch.positioning),
    audience: clean(patch.audience),
    income_targets: clean(patch.income_targets),
    notes: clean(patch.notes),
  };
  await getPool().query(
    `INSERT INTO identity.user_context (email, goals, ventures, positioning, audience, income_targets, notes, user_id, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now())
     ON CONFLICT (email) DO UPDATE SET
       goals=EXCLUDED.goals, ventures=EXCLUDED.ventures, positioning=EXCLUDED.positioning,
       audience=EXCLUDED.audience, income_targets=EXCLUDED.income_targets, notes=EXCLUDED.notes,
       user_id=COALESCE(EXCLUDED.user_id, identity.user_context.user_id),
       updated_at=now()`,
    [email, next.goals, next.ventures, next.positioning, next.audience, next.income_targets, next.notes, userId],
  );
  return next;
}

/** Render the executive profile as a shared instruction block. Returns "" when nothing is set, so
 *  agents pay zero prompt cost until the user fills in their profile. Appended alongside HOUSE_STYLE at
 *  BOTH instruction-assembly sites (the documented both-branches requirement). */
export function renderExecutiveContext(ctx: UserContext | null): string {
  if (!ctx) return "";
  const lines: string[] = [];
  if (ctx.goals) lines.push(`Standing goals: ${ctx.goals}`);
  if (ctx.ventures) lines.push(`Current ventures / initiatives: ${ctx.ventures}`);
  if (ctx.positioning) lines.push(`Positioning / brand: ${ctx.positioning}`);
  if (ctx.audience) lines.push(`Target audience: ${ctx.audience}`);
  if (ctx.income_targets) lines.push(`Income / revenue targets: ${ctx.income_targets}`);
  if (ctx.notes) lines.push(`Other context: ${ctx.notes}`);
  if (!lines.length) return "";
  return (
    "\n\nWho you serve — this user is an executive with these standing objectives. Frame every substantive " +
    "output to move these forward, and weigh recommendations by their impact on them:\n- " +
    lines.join("\n- ") +
    "\nWhen relevant, make the tie explicit — e.g. how a finding affects their revenue, brand/thought-" +
    "leadership, or career — rather than leaving it implied."
  );
}

export { EMPTY as EMPTY_USER_CONTEXT };
