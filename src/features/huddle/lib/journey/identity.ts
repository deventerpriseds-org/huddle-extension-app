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
      return id;
    }
  } catch {
    /* fall through to the raw login email */
  }
  return {};
}

/** The email to scope mirror reads by — the canonical journey email, or the raw login as a fallback. */
export async function resolveTaskEmail(caller: Caller): Promise<string | undefined> {
  const { email } = await resolveJourneyIdentity(caller);
  return email ?? caller?.entra_email;
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
