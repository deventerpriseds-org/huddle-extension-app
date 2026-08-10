import { invokeJourneyTool } from "./proxy.functions";

// Resolve a Huddle Entra sign-in email (which may be an alias, e.g. von.ellis@) to the CANONICAL
// journey identity (user_id + profile email, e.g. dev@) that the task-sync writes the mirror under.
// The mirror is scoped by that canonical email, so every read path (board, prioritize, groom,
// stand-up) must resolve first — otherwise an aliased login matches zero rows. Cached per login.
//
// This is ALSO the single source of the user's canonical TIMEZONE: the profile carries it, whoami
// returns it, and resolveTimeZone() below hands it to every display edge (the shared formatInTz in
// lib/time.ts) so times are localized in ONE place, never re-converted by a tool or the model.

type Caller = { entra_object_id?: string; entra_email?: string } | undefined;

const cache = new Map<string, { userId?: string; email?: string; timeZone?: string }>();

export async function resolveJourneyIdentity(
  caller: Caller,
  browserTimeZone?: string,
): Promise<{ userId?: string; email?: string; timeZone?: string }> {
  const login = caller?.entra_email?.trim().toLowerCase();
  if (!login) return {};
  const hit = cache.get(login);
  // Serve from cache once we have a timezone; if a cached entry lacks one but we now have a browser
  // zone to seed, fall through and re-resolve (whoami will persist it canonically).
  if (hit && (hit.timeZone || !browserTimeZone)) return hit;
  const { cacheJourneyIdentity, getCachedJourneyIdentity } = await import("../identity/identity.server");
  try {
    const r = await invokeJourneyTool({
      toolName: "whoami",
      // Pass the browser zone so whoami can SEED profiles.timezone when it's still null (first login
      // from a browser) — makes the canonical value self-populate without a settings screen.
      args: browserTimeZone ? { timeZone: browserTimeZone } : {},
      caller: caller ?? {},
      context: { source: "huddle" },
    });
    if (r.ok) {
      const parsed = JSON.parse(r.output || "{}") as { user_id?: string; email?: string; timezone?: string };
      const id = {
        userId: parsed.user_id,
        email: parsed.email || undefined,
        timeZone: parsed.timezone || undefined,
      };
      cache.set(login, id);
      await cacheJourneyIdentity(login, id); // durable last-known-good (self-guarded; never throws)
      return id;
    }
  } catch {
    /* whoami errored — fall through to the DURABLE cache below */
  }
  // whoami unavailable (error or non-ok): serve the last-known-good resolution instead of returning {}
  // (which made resolveTaskEmail fall back to the RAW login email, scoping the same user under a second
  // email and blanking the UI on a transient blip — 2026-08-05). Deliberately NOT written to the
  // in-memory cache, so the next call re-attempts whoami and recovers fresh the instant it's back.
  const cached = await getCachedJourneyIdentity(login);
  if (cached && (cached.userId || cached.email)) return cached;
  return {};
}

/**
 * The STABLE identity key for scoping Huddle-owned state: the user's `entra_object_id`, resolved
 * whoami-independently. Order: the caller's own object id (interactive paths) → the local profile_emails
 * map by login email (server/cadence paths) → null. FAIL-CLOSED: returns null rather than guessing, so a
 * caller never silently scopes state under the wrong email. (Phase 0 of docs/plan-user-id-unification.md —
 * added but not yet consumed; Phase 1 switches stores to key on this.)
 */
export async function resolveUserId(caller: Caller): Promise<string | null> {
  const oid = caller?.entra_object_id?.trim();
  if (oid) return oid;
  const { resolveObjectIdByEmail } = await import("../identity/identity.server");
  return resolveObjectIdByEmail(caller?.entra_email);
}

/**
 * The email to scope every email-keyed store by. Resolution, most-authoritative first:
 *   1. journey whoami / durable identity_cache (via resolveJourneyIdentity) → canonical email;
 *   2. LOCAL canonical resolve from profile_emails+identity_cache — so a whoami blip on an un-cached
 *      alias still lands on the SAME canonical email instead of scoping the user under a second one
 *      (the dev@ vs von.ellis@ split that fragmented history);
 *   3. the raw login as last resort.
 * ALWAYS lower-cased/trimmed so a capitalization variant (e.g. Von.Ellis@…) can never open a 3rd bucket.
 */
export async function resolveTaskEmail(caller: Caller): Promise<string | undefined> {
  const { email } = await resolveJourneyIdentity(caller);
  const login = caller?.entra_email?.trim();
  let resolved = email ?? undefined;
  if (!resolved && login) {
    const { resolveCanonicalEmailByLogin } = await import("../identity/identity.server");
    resolved = (await resolveCanonicalEmailByLogin(login)) ?? undefined;
  }
  resolved = resolved ?? login;
  return resolved ? resolved.trim().toLowerCase() : undefined;
}

/**
 * The canonical timezone to render the user's times in: the stored profile zone (authoritative,
 * works on server/cron paths that have no browser) → the browser-supplied zone for this turn →
 * "UTC". This is the ONE value every display edge should localize with.
 */
export async function resolveTimeZone(caller: Caller, browserTimeZone?: string): Promise<string> {
  const { timeZone } = await resolveJourneyIdentity(caller, browserTimeZone);
  return timeZone || browserTimeZone || "UTC";
}
