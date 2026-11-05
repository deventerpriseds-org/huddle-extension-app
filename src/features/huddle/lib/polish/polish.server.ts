// WHAT:       runPolish — the ONE Polish engine: coerce settings, build the prompt from polish-core,
//             call OpenAI Responses, splice/clean the result. Plus loadPolishProfiles: the built-in
//             profiles merged with a user's own (from the synced workspace blob).
// WHY:        Option A (docs/polish/CONTRACT-polish-ecosystem.md): Huddle's own screen (polishTextFn)
//             and Nexus (via /api/public/polish) must run the SAME engine, so it lives here once.
// SUPERSEDES: the model-call body that lived inline in polish.functions.ts polishTextFn (moved, not changed).
// SUPERSEDED-BY: nothing -- current
// EVIDENCE:   scripts/polish-core.test.ts; reuses OPENAI_API_KEY (no new secret)
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

export async function runPolish(
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

/** Built-ins + the user's own synced profiles (identity.workspace_state.state.polishProfiles). */
export async function loadPolishProfiles(
  email: string,
): Promise<{ profiles: PolishProfile[]; lastProfileId: string }> {
  const builtIns = BUILTIN_PROFILES.map((p) => ({ ...p }));
  try {
    const { resolveObjectIdByEmail } = await import("../identity/identity.server");
    const oid = await resolveObjectIdByEmail(email);
    if (!oid) return { profiles: builtIns, lastProfileId: "work-email" };
    const { getPool } = await import("../identity/workspace.server");
    const { rows } = await getPool().query<{ p: unknown; last: unknown }>(
      `SELECT state->'polishProfiles' AS p, state->>'polishProfileId' AS last FROM identity.workspace_state WHERE entra_object_id = $1`,
      [oid],
    );
    const raw = Array.isArray(rows[0]?.p) ? (rows[0].p as unknown[]) : [];
    const own: PolishProfile[] = raw
      .filter(
        (x): x is Record<string, unknown> =>
          !!x &&
          typeof x === "object" &&
          typeof (x as { id?: unknown }).id === "string" &&
          typeof (x as { name?: unknown }).name === "string",
      )
      .map((x) => ({
        ...normalizeSettings(x),
        id: String(x.id),
        name: String(x.name).slice(0, 80),
        custom: true,
      }));
    const last = typeof rows[0]?.last === "string" ? rows[0].last : "work-email";
    return { profiles: [...builtIns, ...own], lastProfileId: last };
  } catch {
    return { profiles: builtIns, lastProfileId: "work-email" };
  }
}
