// Azure PG identity schema + query helpers for user profiles and their emails.
// Auto-bootstraps schema on first use. Case-insensitive uniqueness is enforced
// with functional lower(...) indexes so it works on Azure PG without extensions.
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

CREATE TABLE IF NOT EXISTS identity.profiles (
  entra_object_id TEXT PRIMARY KEY,
  username        TEXT NOT NULL,
  display_name    TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS identity.profile_emails (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entra_object_id TEXT NOT NULL REFERENCES identity.profiles(entra_object_id) ON DELETE CASCADE,
  email           TEXT NOT NULL,
  source          TEXT NOT NULL CHECK (source IN ('entra','manual')),
  added_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS profile_emails_owner_idx
  ON identity.profile_emails(entra_object_id);

CREATE UNIQUE INDEX IF NOT EXISTS profiles_username_lower_key
  ON identity.profiles (lower(username));
CREATE UNIQUE INDEX IF NOT EXISTS profile_emails_email_lower_key
  ON identity.profile_emails (lower(email));

-- Durable last-known-good cache of the journey identity resolution (whoami), keyed by the sign-in
-- (login) email. Purpose: when journey whoami transiently fails, resolveJourneyIdentity serves the
-- last successful { user_id, canonical email, timezone } from here INSTEAD of falling back to the raw
-- login email — which was scoping the same user under two emails (dev@ vs von.ellis@) and blanking the
-- UI on a whoami blip (2026-08-05). Additive/read-model only; safe to truncate (repopulates on the next
-- successful whoami).
CREATE TABLE IF NOT EXISTS identity.identity_cache (
  login_email TEXT PRIMARY KEY,
  user_id     TEXT,
  email       TEXT,
  time_zone   TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
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

export interface ProfileRow {
  entra_object_id: string;
  username: string;
  display_name: string | null;
  created_at: string;
  updated_at: string;
}

export interface EmailRow {
  id: string;
  entra_object_id: string;
  email: string;
  source: "entra" | "manual";
  added_at: string;
}

export interface ProfileBundle {
  profile: ProfileRow;
  emails: EmailRow[];
}

const USERNAME_RE = /^[a-z0-9_-]{3,30}$/;

export function normalizeUsername(v: string): string {
  return v.trim().toLowerCase();
}

export function validateUsername(v: string): string {
  const u = normalizeUsername(v);
  if (!USERNAME_RE.test(u)) {
    throw new Error(
      "Username must be 3-30 chars: lowercase letters, digits, underscore, hyphen.",
    );
  }
  return u;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export function validateEmail(v: string): string {
  const e = v.trim().toLowerCase();
  if (!EMAIL_RE.test(e) || e.length > 254) throw new Error("Invalid email address.");
  return e;
}

function suggestFromEmail(email: string | null): string {
  const local = (email ?? "user").split("@")[0].toLowerCase();
  const cleaned = local.replace(/[^a-z0-9_-]/g, "") || "user";
  return cleaned.slice(0, 24) || "user";
}

async function fetchBundle(oid: string): Promise<ProfileBundle | null> {
  const pool = getPool();
  const p = await pool.query<ProfileRow>(
    `SELECT entra_object_id, username, display_name, created_at, updated_at
     FROM identity.profiles WHERE entra_object_id = $1`,
    [oid],
  );
  if (p.rowCount === 0) return null;
  const e = await pool.query<EmailRow>(
    `SELECT id, entra_object_id, email, source, added_at
     FROM identity.profile_emails
     WHERE entra_object_id = $1
     ORDER BY (source='entra') DESC, added_at ASC`,
    [oid],
  );
  return { profile: p.rows[0], emails: e.rows };
}

export async function getOrCreateProfile(claims: {
  oid: string;
  email: string | null;
  name: string | null;
}): Promise<ProfileBundle> {
  await ensureBootstrapped();
  const existing = await fetchBundle(claims.oid);
  if (existing) {
    // Backfill Entra sign-in email if the token has one and it's not stored.
    if (claims.email) {
      const normalized = claims.email.trim().toLowerCase();
      const has = existing.emails.some((r) => r.email.toLowerCase() === normalized);
      if (!has) {
        try {
          await getPool().query(
            `INSERT INTO identity.profile_emails (entra_object_id, email, source)
             VALUES ($1, $2, 'entra')
             ON CONFLICT (lower(email)) DO NOTHING`,
            [claims.oid, normalized],
          );
        } catch {
          // If the email is claimed by another profile, ignore — surfaced elsewhere.
        }
        const refreshed = await fetchBundle(claims.oid);
        if (refreshed) return refreshed;
      }
    }
    return existing;
  }

  // Auto-provision with a unique username derived from the Entra email.
  const base = suggestFromEmail(claims.email);
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    let username = base;
    let attempt = 0;
    // Try base, base2, base3, ... until unique.
    while (true) {
      const conflict = await client.query(
        `SELECT 1 FROM identity.profiles WHERE lower(username) = lower($1)`,
        [username],
      );
      if (conflict.rowCount === 0) break;
      attempt += 1;
      username = `${base}${attempt + 1}`;
      if (attempt > 100) {
        username = `${base}-${claims.oid.slice(0, 6)}`;
        break;
      }
    }
    await client.query(
      `INSERT INTO identity.profiles (entra_object_id, username, display_name)
       VALUES ($1, $2, $3)`,
      [claims.oid, username, claims.name],
    );
    if (claims.email) {
      await client.query(
        `INSERT INTO identity.profile_emails (entra_object_id, email, source)
         VALUES ($1, $2, 'entra')
         ON CONFLICT (lower(email)) DO NOTHING`,
        [claims.oid, claims.email.trim().toLowerCase()],
      );
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }

  const bundle = await fetchBundle(claims.oid);
  if (!bundle) throw new Error("Failed to create profile");
  return bundle;
}

export async function setUsername(oid: string, next: string): Promise<ProfileBundle> {
  await ensureBootstrapped();
  const username = validateUsername(next);
  const pool = getPool();
  const taken = await pool.query(
    `SELECT 1 FROM identity.profiles WHERE lower(username) = lower($1) AND entra_object_id <> $2`,
    [username, oid],
  );
  if (taken.rowCount && taken.rowCount > 0) {
    throw new Error("That username is already taken.");
  }
  await pool.query(
    `UPDATE identity.profiles SET username = $1, updated_at = now() WHERE entra_object_id = $2`,
    [username, oid],
  );
  const bundle = await fetchBundle(oid);
  if (!bundle) throw new Error("Profile not found");
  return bundle;
}

export async function setDisplayName(oid: string, next: string | null): Promise<ProfileBundle> {
  await ensureBootstrapped();
  const trimmed = next?.trim() || null;
  if (trimmed && trimmed.length > 80) throw new Error("Display name too long (max 80).");
  await getPool().query(
    `UPDATE identity.profiles SET display_name = $1, updated_at = now() WHERE entra_object_id = $2`,
    [trimmed, oid],
  );
  const bundle = await fetchBundle(oid);
  if (!bundle) throw new Error("Profile not found");
  return bundle;
}

export async function addEmail(oid: string, email: string): Promise<ProfileBundle> {
  await ensureBootstrapped();
  const normalized = validateEmail(email);
  const pool = getPool();
  const conflict = await pool.query<{ entra_object_id: string }>(
    `SELECT entra_object_id FROM identity.profile_emails WHERE lower(email) = lower($1)`,
    [normalized],
  );
  if (conflict.rowCount && conflict.rowCount > 0) {
    const ownerOid = conflict.rows[0].entra_object_id;
    if (ownerOid === oid) {
      // Already linked to this profile — no-op.
      const bundle = await fetchBundle(oid);
      if (!bundle) throw new Error("Profile not found");
      return bundle;
    }
    throw new Error("That email is already linked to another account.");
  }
  await pool.query(
    `INSERT INTO identity.profile_emails (entra_object_id, email, source)
     VALUES ($1, $2, 'manual')`,
    [oid, normalized],
  );
  const bundle = await fetchBundle(oid);
  if (!bundle) throw new Error("Profile not found");
  return bundle;
}

/**
 * Resolve an email to its owning profile's stable `entra_object_id` via the local profile_emails map.
 * This is the LOCAL, whoami-independent identity key: both of a user's emails (dev@ / von.ellis@) point
 * at one object_id. Returns null when the email isn't linked to any profile (fail-closed for callers).
 */
export async function resolveObjectIdByEmail(email: string | undefined | null): Promise<string | null> {
  const e = (email ?? "").trim();
  if (!e) return null;
  try {
    await ensureBootstrapped();
    const r = await getPool().query<{ entra_object_id: string }>(
      `SELECT entra_object_id FROM identity.profile_emails WHERE lower(email) = lower($1) LIMIT 1`,
      [e],
    );
    return r.rowCount && r.rowCount > 0 ? r.rows[0].entra_object_id : null;
  } catch {
    return null; // identity DB unavailable — caller decides (fail-closed)
  }
}

/** Persist the last successful journey-identity resolution for a login email (best-effort upsert). */
export async function cacheJourneyIdentity(
  loginEmail: string,
  id: { userId?: string; email?: string; timeZone?: string },
): Promise<void> {
  const login = (loginEmail ?? "").trim().toLowerCase();
  if (!login) return;
  try {
    await ensureBootstrapped();
    await getPool().query(
      `INSERT INTO identity.identity_cache (login_email, user_id, email, time_zone, updated_at)
       VALUES ($1,$2,$3,$4, now())
       ON CONFLICT (login_email) DO UPDATE SET
         user_id = COALESCE(EXCLUDED.user_id, identity.identity_cache.user_id),
         email = COALESCE(EXCLUDED.email, identity.identity_cache.email),
         time_zone = COALESCE(EXCLUDED.time_zone, identity.identity_cache.time_zone),
         updated_at = now()`,
      [login, id.userId ?? null, id.email ?? null, id.timeZone ?? null],
    );
  } catch {
    /* best-effort — a cache write failure must never break identity resolution */
  }
}

/** Read the durable last-known-good journey identity for a login email (used when whoami fails). */
export async function getCachedJourneyIdentity(
  loginEmail: string,
): Promise<{ userId?: string; email?: string; timeZone?: string } | null> {
  const login = (loginEmail ?? "").trim().toLowerCase();
  if (!login) return null;
  try {
    await ensureBootstrapped();
    const r = await getPool().query<{ user_id: string | null; email: string | null; time_zone: string | null }>(
      `SELECT user_id, email, time_zone FROM identity.identity_cache WHERE login_email = $1`,
      [login],
    );
    if (!r.rowCount) return null;
    return { userId: r.rows[0].user_id ?? undefined, email: r.rows[0].email ?? undefined, timeZone: r.rows[0].time_zone ?? undefined };
  } catch {
    return null;
  }
}

export async function removeEmail(oid: string, emailId: string): Promise<ProfileBundle> {
  await ensureBootstrapped();
  const pool = getPool();
  const row = await pool.query<{ source: string }>(
    `SELECT source FROM identity.profile_emails
     WHERE id = $1 AND entra_object_id = $2`,
    [emailId, oid],
  );
  if (row.rowCount === 0) throw new Error("Email not found on this account.");
  if (row.rows[0].source === "entra") {
    throw new Error("Can't remove the email you sign in with.");
  }
  await pool.query(
    `DELETE FROM identity.profile_emails WHERE id = $1 AND entra_object_id = $2`,
    [emailId, oid],
  );
  const bundle = await fetchBundle(oid);
  if (!bundle) throw new Error("Profile not found");
  return bundle;
}
