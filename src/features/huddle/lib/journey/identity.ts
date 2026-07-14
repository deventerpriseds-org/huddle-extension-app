import { invokeJourneyTool } from "./proxy.functions";

// Resolve a Huddle Entra sign-in email (which may be an alias, e.g. von.ellis@) to the CANONICAL
// journey identity (user_id + profile email, e.g. dev@) that the task-sync writes the mirror under.
// The mirror is scoped by that canonical email, so every read path (board, prioritize, groom,
// stand-up) must resolve first — otherwise an aliased login matches zero rows. Cached per login.

type Caller = { entra_object_id?: string; entra_email?: string } | undefined;

const cache = new Map<string, { userId?: string; email?: string }>();

export async function resolveJourneyIdentity(caller: Caller): Promise<{ userId?: string; email?: string }> {
  const login = caller?.entra_email?.trim().toLowerCase();
  if (!login) return {};
  const hit = cache.get(login);
  if (hit) return hit;
  try {
    const r = await invokeJourneyTool({ toolName: "whoami", args: {}, caller: caller ?? {}, context: { source: "huddle" } });
    if (r.ok) {
      const parsed = JSON.parse(r.output || "{}") as { user_id?: string; email?: string };
      const id = { userId: parsed.user_id, email: parsed.email || undefined };
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
