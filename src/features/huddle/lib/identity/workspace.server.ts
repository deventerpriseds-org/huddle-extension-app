// Server-only workspace_state helpers. Kept in a *.server.ts so it can't
// leak into client bundles; imported dynamically from workspace.functions.ts.
import { Pool } from "pg";

let _pool: Pool | null = null;

export function getPool(): Pool {
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

CREATE TABLE IF NOT EXISTS identity.workspace_state (
  entra_object_id TEXT PRIMARY KEY
    REFERENCES identity.profiles(entra_object_id) ON DELETE CASCADE,
  state           JSONB NOT NULL DEFAULT '{}'::jsonb,
  version         INT   NOT NULL DEFAULT 3,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

let bootstrapped: Promise<void> | null = null;
export async function ensureWorkspaceBootstrapped() {
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
