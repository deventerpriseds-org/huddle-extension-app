// WHAT:       runPolish — the ONE Polish engine: coerce settings, build the prompt from polish-core,
//             call OpenAI Responses, splice/clean the result. Plus loadPolishProfiles: the built-in
//             profiles merged with a user's own (eds-tools phase 2; the synced workspace blob is the fallback
//             and the one-time seed).
// WHY:        Option A (docs/polish/CONTRACT-polish-ecosystem.md): Huddle's own screen (polishTextFn)
//             and Nexus (via /api/public/polish) must run the SAME engine, so it lives here once.
// SUPERSEDES: the model-call body that lived inline in polish.functions.ts polishTextFn (moved, not changed).
// SUPERSEDED-BY: nothing -- current. (2026-11-08: runPolish now asks the shared eds-tools service first;
//             the local engine below is the fallback — deventerpriseds-org/eds-tools docs/PLAN.md phase 1.)
// EVIDENCE:   scripts/polish-core.test.ts; reuses OPENAI_API_KEY + JOURNEY_PROXY_TOKEN (no new secret)
import {
  applyResult,
  BUILTIN_PROFILES,
  buildPolishPrompt,
  normalizeSettings,
  type PolishProfile,
  type PolishRequest,
} from "./polish-core";

/** Fast / Best → a rung of the existing model ladder (lib/model-policy.ts LADDER). */
const ENGINE_MODEL = {
  fast: { model: "gpt-5.6-luna", effort: "low" },
  best: { model: "gpt-5.6-terra", effort: "medium" },
} as const;

export type PolishResult = { ok: true; text: string; model: string } | { ok: false; error: string };

/** The shared tools service (deventerpriseds-org/eds-tools, phase 1 of Option A). EDS_TOOLS_URL overrides. */
export const EDS_TOOLS_DEFAULT_URL = "https://eds-tools-fn.azurewebsites.net";

/** What the shared service's answer means for Huddle: use it, or fall back to the local engine. A
 *  reachable service that REFUSED the request (4xx other than auth) is final, not a fallback trigger:
 *  the local engine would refuse the same input, and retrying would hide a real defect. */
export function edsToolsOutcome(status: number | "network", body: unknown): "use" | "fallback" {
  if (status === "network") return "fallback";
  const ok =
    !!body && typeof body === "object" && typeof (body as { ok?: unknown }).ok === "boolean";
  if (!ok) return "fallback";
  if (status === 401 || status === 403 || status === 503 || status >= 500) {
    // 502 with {ok:false} is the service's own MODEL failure — the same model would fail locally too.
    return status === 502 ? "use" : "fallback";
  }
  return "use";
}

/** Phase 1 of the shared tools service: ask eds-tools first, fall back to Huddle's own engine when the
 *  service is unreachable or misconfigured. Settings are coerced HERE (with the profile as base) so both
 *  paths polish with exactly the same settings. */
export async function runPolish(
  profileName: string,
  rawSettings: unknown,
  req: PolishRequest,
  base?: PolishProfile,
  fetchImpl: typeof fetch = fetch,
): Promise<PolishResult & { engine?: "eds-tools" | "local" }> {
  const settings = normalizeSettings(rawSettings, base);
  const secret = (process.env.JOURNEY_PROXY_TOKEN ?? "").trim();
  const url = (process.env.EDS_TOOLS_URL ?? EDS_TOOLS_DEFAULT_URL).trim().replace(/\/+$/, "");
  if (secret && url) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 42_000);
    try {
      const res = await fetchImpl(`${url}/api/polish`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-webhook-secret": secret,
          "x-eds-app": "huddle",
        },
        body: JSON.stringify({ profileName, settings, request: req }),
        signal: ctl.signal,
      });
      const body = (await res.json().catch(() => null)) as PolishResult | null;
      if (edsToolsOutcome(res.status, body) === "use" && body)
        return { ...body, engine: "eds-tools" };
      console.warn("[polish] eds-tools fallback", res.status);
    } catch (e) {
      console.warn("[polish] eds-tools unreachable; local fallback", (e as Error)?.name);
    } finally {
      clearTimeout(timer);
    }
  }
  return { ...(await runPolishLocal(profileName, settings, req, base)), engine: "local" };
}

/** Huddle's own copy of the engine — the fallback while eds-tools is phase 1. */
export async function runPolishLocal(
  profileName: string,
  rawSettings: unknown,
  req: PolishRequest,
  base?: PolishProfile,
): Promise<PolishResult> {
  if (req.mode === "span" && !(req.start < req.end && req.end <= req.text.length)) {
    return { ok: false, error: "That selection no longer matches the text. Select it again." };
  }
  const key = process.env.OPENAI_API_KEY;
  if (!key)
    return { ok: false, error: "Polish isn't configured on the server yet (missing model key)." };

  const settings = normalizeSettings(rawSettings, base);
  const { system, input } = buildPolishPrompt(profileName, settings, req);
  const { model, effort } = ENGINE_MODEL[settings.engine];

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 40_000); // stays under the ~45s hosting ceiling
  try {
    const res = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, instructions: system, input, reasoning: { effort } }),
      signal: ctl.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error("[polish] OpenAI", res.status, body.slice(0, 300));
      if (res.status === 429)
        return { ok: false, error: "The model is busy or out of quota. Try again in a minute." };
      return {
        ok: false,
        error: `The model returned an error (${res.status}). Your text is unchanged; try again.`,
      };
    }
    const json = (await res.json()) as {
      output_text?: string;
      output?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }>;
    };
    const text =
      json.output_text ??
      (json.output ?? [])
        .filter((o) => o.type === "message")
        .flatMap((o) => o.content ?? [])
        .filter((c) => c.type === "output_text")
        .map((c) => c.text ?? "")
        .join("");
    if (!text.trim())
      return { ok: false, error: "Nothing came back. Try again or simplify the instruction." };
    return { ok: true, text: applyResult(req, text), model };
  } catch (e) {
    const aborted = (e as { name?: string })?.name === "AbortError";
    return {
      ok: false,
      error: aborted
        ? "That took too long. Try Fast, or polish a shorter piece."
        : "Couldn't reach the model. Your text is unchanged; try again.",
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Clean a stored list into the user's OWN profiles (built-ins are never stored, only merged in). */
function ownProfiles(raw: unknown): PolishProfile[] {
  if (!Array.isArray(raw)) return [];
  const builtinIds = new Set(BUILTIN_PROFILES.map((p) => p.id));
  return raw
    .filter(
      (x): x is Record<string, unknown> =>
        !!x &&
        typeof x === "object" &&
        typeof (x as { id?: unknown }).id === "string" &&
        typeof (x as { name?: unknown }).name === "string" &&
        !builtinIds.has((x as { id: string }).id),
    )
    .map((x) => ({
      ...normalizeSettings(x),
      id: String(x.id),
      name: String(x.name).slice(0, 80),
      custom: true,
    }));
}

type ProfileDoc = { profiles: PolishProfile[]; lastProfileId: string };

/** Phase 2 of the shared tools service: the user's profiles live in eds-tools (GET/PUT
 *  /api/polish/profiles). Returns null when the service is unconfigured, unreachable or refuses —
 *  callers then fall back to Huddle's own workspace blob, so Polish never loses its profiles. */
export async function edsToolsProfiles(
  email: string,
  save?: ProfileDoc,
  fetchImpl: typeof fetch = fetch,
): Promise<(ProfileDoc & { found: boolean }) | null> {
  const secret = (process.env.JOURNEY_PROXY_TOKEN ?? "").trim();
  const url = (process.env.EDS_TOOLS_URL ?? EDS_TOOLS_DEFAULT_URL).trim().replace(/\/+$/, "");
  const user = email.trim().toLowerCase();
  if (!secret || !url || !user) return null;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 8_000);
  try {
    const res = await fetchImpl(`${url}/api/polish/profiles`, {
      method: save ? "PUT" : "GET",
      headers: {
        "Content-Type": "application/json",
        "x-webhook-secret": secret,
        "x-eds-app": "huddle",
        "x-eds-user": user,
      },
      body: save ? JSON.stringify(save) : undefined,
      signal: ctl.signal,
    });
    const body = (await res.json().catch(() => null)) as {
      ok?: boolean;
      found?: boolean;
      profiles?: unknown;
      lastProfileId?: unknown;
    } | null;
    if (res.status !== 200 || !body?.ok) {
      console.warn("[polish] eds-tools profiles", save ? "PUT" : "GET", res.status);
      return null;
    }
    return {
      found: save ? true : body.found === true,
      profiles: ownProfiles(body.profiles),
      lastProfileId: typeof body.lastProfileId === "string" ? body.lastProfileId : "work-email",
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** The user's own profiles as Huddle's workspace blob holds them (the pre-phase-2 home). */
async function blobProfiles(email: string): Promise<ProfileDoc> {
  try {
    const { resolveObjectIdByEmail } = await import("../identity/identity.server");
    const oid = await resolveObjectIdByEmail(email);
    if (!oid) return { profiles: [], lastProfileId: "work-email" };
    const { getPool } = await import("../identity/workspace.server");
    const { rows } = await getPool().query<{ p: unknown; last: unknown }>(
      `SELECT state->'polishProfiles' AS p, state->>'polishProfileId' AS last FROM identity.workspace_state WHERE entra_object_id = $1`,
      [oid],
    );
    return {
      profiles: ownProfiles(rows[0]?.p),
      lastProfileId: typeof rows[0]?.last === "string" ? rows[0].last : "work-email",
    };
  } catch {
    return { profiles: [], lastProfileId: "work-email" };
  }
}

/** The user's OWN profiles + last pick, and where they came from. eds-tools is the source of truth;
 *  the first time it has nothing for a user, Huddle's blob seeds it (once). Unreachable -> blob. */
export async function loadOwnPolishProfiles(
  email: string,
  fetchImpl: typeof fetch = fetch,
  blob: (email: string) => Promise<ProfileDoc> = blobProfiles,
): Promise<ProfileDoc & { source: "eds-tools" | "blob" }> {
  const shared = await edsToolsProfiles(email, undefined, fetchImpl);
  if (shared?.found)
    return { profiles: shared.profiles, lastProfileId: shared.lastProfileId, source: "eds-tools" };
  const local = await blob(email);
  if (shared && (local.profiles.length || local.lastProfileId !== "work-email")) {
    const seeded = await edsToolsProfiles(email, local, fetchImpl);
    if (seeded) return { ...seeded, source: "eds-tools" };
  }
  return { ...local, source: shared ? "eds-tools" : "blob" };
}

/** Built-ins + the user's own profiles (eds-tools first, Huddle's blob as fallback). */
export async function loadPolishProfiles(
  email: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ profiles: PolishProfile[]; lastProfileId: string }> {
  const builtIns = BUILTIN_PROFILES.map((p) => ({ ...p }));
  const own = await loadOwnPolishProfiles(email, fetchImpl);
  return { profiles: [...builtIns, ...own.profiles], lastProfileId: own.lastProfileId };
}
