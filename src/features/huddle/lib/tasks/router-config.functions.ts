import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

// Load/save the scrum-master's editable "capability prompt" — what the app can and can't do today.
// The grooming router obeys it (e.g. no payments until Plaid). Scoped by the signed-in user's email
// (same caller trust model as sendHuddleMessage). tasks.server is imported dynamically so `pg` stays
// server-only.

const Caller = z.object({ entra_email: z.string().optional() }).optional();

export const loadCapabilityPrompt = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => z.object({ caller: Caller }).parse(raw))
  .handler(async ({ data }): Promise<{ prompt: string; stored: boolean }> => {
    const { getCapabilityPrompt, DEFAULT_CAPABILITY_PROMPT } = await import("./tasks.server");
    const email = data.caller?.entra_email;
    if (!email) return { prompt: DEFAULT_CAPABILITY_PROMPT, stored: false };
    try {
      const prompt = await getCapabilityPrompt(email);
      return { prompt, stored: true };
    } catch {
      return { prompt: DEFAULT_CAPABILITY_PROMPT, stored: false };
    }
  });

export const saveCapabilityPrompt = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) =>
    z.object({ caller: Caller, prompt: z.string().max(8000) }).parse(raw),
  )
  .handler(async ({ data }): Promise<{ ok: boolean; error: string }> => {
    const email = data.caller?.entra_email;
    if (!email) return { ok: false, error: "Sign-in required to save." };
    try {
      const { setCapabilityPrompt } = await import("./tasks.server");
      await setCapabilityPrompt(email, data.prompt);
      return { ok: true, error: "" };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
