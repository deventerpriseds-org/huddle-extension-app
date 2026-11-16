// WHAT:       The ONE Postgres connection pool for the whole Huddle server. Every store's getPool() returns it.
// WHY:        Huddle had 17 separate pools (max 2-3 each, up to ~48 connections per server instance) on a database
//             server that allows 50 (10 reserved) and is SHARED with other apps' connectors (~16 held). Busy moments
//             exhausted it: "remaining connection slots are reserved for roles with the SUPERUSER attribute" on
//             saves, loads and turns (owner screenshot 2026-11-08; azure-pg-query run 42500451689). Owner chose
//             option A: one shared pool.
// SUPERSEDES: the per-module `new Pool(...)` in 17 *.server.ts files.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   scripts/shared-pool.test.ts; .claude/actions.md ACT:db-connection-exhaustion.
import { Pool } from "pg";

/** Connections Huddle may hold per server instance. 8 x 2 instances stays well inside the ~24 left for Huddle. */
export const SHARED_POOL_MAX = 8;

let _shared: Pool | null = null;

export function getSharedPool(): Pool {
  if (_shared) return _shared;
  const url = process.env.AZURE_PG_URL;
  if (!url) throw new Error("AZURE_PG_URL not configured");
  _shared = new Pool({
    connectionString: url,
    // Azure Postgres requires TLS; skip only the cert-chain check (encryption still applies).
    ssl: { rejectUnauthorized: false },
    max: SHARED_POOL_MAX,
    idleTimeoutMillis: 20_000,
    // A request waits up to this long for a free connection instead of failing at once.
    connectionTimeoutMillis: 15_000,
  });
  // An idle connection dropped by the server must not crash the process; the pool replaces it.
  _shared.on("error", (e) => console.error("[shared-pool] idle client error:", e.message));
  return _shared;
}
