## Problem

Azure Database for PostgreSQL (Flexible Server) blocks `CREATE EXTENSION citext` unless the DBA explicitly allow-lists it via the `azure.extensions` server parameter. Our bootstrap in `identity.server.ts` runs `CREATE EXTENSION IF NOT EXISTS citext` and fails, so the entire Account tab errors out with "Couldn't load account". This also blocks profile creation, which blocks the workspace persistence work.

## Fix

Drop the citext dependency entirely and enforce case-insensitivity in application code + functional unique indexes. This works on any Postgres without server-parameter changes.

### Changes to `src/features/huddle/lib/identity/identity.server.ts`

1. Remove `CREATE EXTENSION IF NOT EXISTS citext` from `BOOTSTRAP_SQL`.
2. Change columns:
   - `identity.profiles.username` → `TEXT NOT NULL` (drop `UNIQUE` inline; replace with functional index).
   - `identity.profile_emails.email` → `TEXT NOT NULL` (drop `UNIQUE` inline; replace with functional index).
3. Add functional unique indexes:
   ```sql
   CREATE UNIQUE INDEX IF NOT EXISTS profiles_username_lower_key
     ON identity.profiles (lower(username));
   CREATE UNIQUE INDEX IF NOT EXISTS profile_emails_email_lower_key
     ON identity.profile_emails (lower(email));
   ```
4. Add a one-shot migration step (idempotent) that handles databases already created before this fix — if the tables exist with `citext` columns, alter them to `TEXT`:
   ```sql
   DO $$
   BEGIN
     IF EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema='identity' AND table_name='profiles'
                  AND column_name='username' AND udt_name='citext') THEN
       ALTER TABLE identity.profiles ALTER COLUMN username TYPE TEXT;
     END IF;
     IF EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema='identity' AND table_name='profile_emails'
                  AND column_name='email' AND udt_name='citext') THEN
       ALTER TABLE identity.profile_emails ALTER COLUMN email TYPE TEXT;
     END IF;
   END$$;
   ```
   (In our case bootstrap failed before the tables were created, so this is defensive.)
5. Update every query that compares username/email to use `lower(col) = lower($n)` or pass an already-lowercased value. Callers already normalize via `normalizeUsername`/`validateEmail`, so the DB side just needs `lower(col) =` on the read side:
   - `getOrCreateProfile`: username-conflict `SELECT 1 FROM identity.profiles WHERE lower(username) = $1` (pass `username` already lower-cased — it is).
   - `setUsername`: `WHERE lower(username) = $1 AND entra_object_id <> $2`.
   - `addEmail`: conflict `SELECT ... WHERE lower(email) = $1`.
   - Insert paths: values are already lower-cased by validators; nothing else changes.

No other files need changes. `entra-verify.server.ts`, `profile.functions.ts`, `useProfile.ts`, and `AccountSettingsPanel.tsx` are untouched.

## Verification

1. Reload the Account tab while signed in — bootstrap runs on the fixed schema, profile auto-provisions, panel renders with username + Entra email.
2. Try adding a second email with mixed case; confirm duplicate rejection is case-insensitive.
3. Confirm `useWorkspaceSync` no longer 500s (its bootstrap references `identity.profiles` via FK — schema now creates cleanly).
