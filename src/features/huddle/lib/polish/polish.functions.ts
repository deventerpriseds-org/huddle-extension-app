// WHAT:       polishTextFn — the one server call behind the Polish tool. Takes a structured request
//             (polish a draft / revise / rewrite a selected span / merge hand edits) plus writing
//             settings, builds the prompt SERVER-side from polish-core, calls OpenAI Responses, and
//             returns the finished full text.
// WHY:        Polish needs a model call; the client never sends raw prompt text, so this cannot be
//             used as an open proxy to the model. Reuses Huddle's existing OPENAI_API_KEY and model
//             ladder (gpt-5.6-luna = Fast, gpt-5.6-terra = Best) — no new secret, no new provider.
// SUPERSEDES: nothing
// SUPERSEDED-BY: nothing -- current
// EVIDENCE:   scripts/polish-core.test.ts (prompt + splice rules)

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import {
  applyResult,
  buildPolishPrompt,
  normalizeSettings,
  type PolishRequest,
} from "./polish-core";

const Caller = z
  .object({ entra_object_id: z.string().optional(), entra_email: z.string().optional() })
  .optional();
const MAX = 40_000;

const Req = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("polish"), draft: z.string().min(1).max(MAX) }),
  z.object({
    mode: z.literal("revise"),
    text: z.string().min(1).max(MAX),
    instruction: z.string().min(1).max(500),
  }),
  z.object({
    mode: z.literal("span"),
    text: z.string().min(1).max(MAX),
    start: z.number().int().min(0),
    end: z.number().int().min(0),
    instruction: z.string().min(1).max(500),
  }),
  z.object({
    mode: z.literal("merge"),
    draft: z.string().min(1).max(MAX),
    edited: z.string().min(1).max(MAX),
  }),
]);

/** Fast / Best → a rung of the existing model ladder (lib/model-policy.ts LADDER). */
const ENGINE_MODEL = {
  fast: { model: "gpt-5.6-luna", effort: "low" },
  best: { model: "gpt-5.6-terra", effort: "medium" },
} as const;

export type PolishResult = { ok: true; text: string; model: string } | { ok: false; error: string };

export const polishTextFn = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) =>
    z
      .object({
        caller: Caller,
        profileName: z.string().min(1).max(80),
        settings: z.unknown(),
        request: Req,
      })
      .parse(raw),
  )
  .handler(async ({ data }): Promise<PolishResult> => {
    if (!data.caller?.entra_email) return { ok: false, error: "Sign in to use Polish." };
    const req = data.request as PolishRequest;
    if (req.mode === "span" && !(req.start < req.end && req.end <= req.text.length)) {
      return { ok: false, error: "That selection no longer matches the text. Select it again." };
    }
    const key = process.env.OPENAI_API_KEY;
    if (!key)
      return { ok: false, error: "Polish isn't configured on the server yet (missing model key)." };

    const settings = normalizeSettings(data.settings);
    const { system, input } = buildPolishPrompt(data.profileName, settings, req);
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
  });
