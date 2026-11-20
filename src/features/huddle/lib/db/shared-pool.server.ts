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

// ── Trinnex memory pool (Trinnex workspace, AC-M1/M3) ─────────────────────────────────────────────────
// A SECOND database (`Trinnex_Memory`) on the SAME server, so it lives in this file: the server allows 50
// connections shared with other apps (see header), and scripts/shared-pool.test.ts keeps every pool here.
// Kept at 2 per instance: Trinnex traffic is one owner's ingestion + Iris/Eli searches. Absent
// TRINNEX_PG_URL means "not set up yet" -- trinnexPgConfigured() is false and nothing is opened.

/** Connections the Trinnex pool may hold per server instance. */
export const TRINNEX_POOL_MAX = 2;

let _trinnex: Pool | null = null;

/** The personal memory database. Trinnex must never open a pool on it (AC-M1, AC-M6). */
export const PERSONAL_MEMORY_DB = "RAG_AI_Agents";

/** Database name the way a pg-style URL resolves it: WHATWG URL, pathname decoded with decodeURIComponent,
 *  query string and #fragment ignored (pg-connection-string sets `database` from the path even when the query
 *  has one), surrounding whitespace and slashes trimmed. Null when unparseable (incl. pg's "/socket db" form). */
function urlParts(url: string): { host: string; port: string; db: string } | null {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return null;
  }
  let path: string;
  try {
    // pg's socket: form carries the database in ?db= (pg-connection-string); every other form in the path.
    path = decodeURIComponent(u.protocol === "socket:" ? (u.searchParams.get("db") ?? "") : u.pathname);
  } catch {
    return null; // malformed percent-escape: refuse rather than guess what pg would do
  }
  const db = path.trim().replace(/^[\s/]+|[\s/]+$/g, "").trim();
  let host = u.hostname;
  try {
    host = decodeURIComponent(host);
  } catch {
    /* keep raw */
  }
  return { host: host.trim().toLowerCase(), port: u.port || "5432", db };
}

/**
 * Why a TRINNEX_PG_URL must not be opened, as a CODE (logged, never the URL), or null when it is safe.
 * Fail closed: an unparseable URL is refused. RT-I1/RT-I2 (percent-encoded name, #fragment) and every
 * whitespace / %2F / case spelling of the personal database are refused.
 */
export function trinnexUrlRefusal(url: string | null | undefined, personalUrl: string | null | undefined): string | null {
  const raw = (url ?? "").trim();
  if (!raw) return "not_configured";
  const t = urlParts(raw);
  if (!t) return "unparseable_url";
  if (!t.db) return "no_database";
  const isPersonal = (name: string) => name.trim().toLowerCase() === PERSONAL_MEMORY_DB.toLowerCase();
  // The whole name, and every slash-separated part of it (a decoded %2F), compared case-insensitively.
  if (isPersonal(t.db) || t.db.split("/").some(isPersonal)) return "personal_db_name";
  const pRaw = (personalUrl ?? "").trim();
  if (pRaw) {
    if (pRaw === raw) return "same_as_azure_pg_url";
    const p = urlParts(pRaw);
    if (p && p.host === t.host && p.port === t.port && p.db.toLowerCase() === t.db.toLowerCase()) return "same_as_azure_pg_url";
  }
  return null;
}

const _loggedRefusals = new Set<string>();
function refusal(): string | null {
  const code = trinnexUrlRefusal(process.env.TRINNEX_PG_URL, process.env.AZURE_PG_URL);
  if (code && code !== "not_configured" && !_loggedRefusals.has(code)) {
    _loggedRefusals.add(code);
    console.error(`[trinnex-pool] refused code=${code}; Trinnex memory is off`);
  }
  return code;
}

/** True only when TRINNEX_PG_URL is set AND passes the personal-database guard. Never throws. */
export function trinnexPgConfigured(): boolean {
  return refusal() === null;
}

export function getTrinnexPool(): Pool {
  if (_trinnex) return _trinnex;
  const code = refusal();
  if (code === "not_configured") throw new Error("TRINNEX_PG_URL not configured");
  // Never the personal memory database: a mis-assembled setting must fail, not silently mix the two.
  if (code) throw new Error(`TRINNEX_PG_URL refused (code=${code}); Trinnex memory is off`);
  const url = process.env.TRINNEX_PG_URL!.trim();
  _trinnex = new Pool({
    connectionString: url,
    ssl: { rejectUnauthorized: false },
    max: TRINNEX_POOL_MAX,
    idleTimeoutMillis: 20_000,
    connectionTimeoutMillis: 15_000,
  });
  _trinnex.on("error", (e) => console.error("[trinnex-pool] idle client error:", e.message));
  return _trinnex;
}
