import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import type { AgentWorkflowConfig } from "./agent-workflow-config.server";

// Client-callable server fns for the "required vs discretionary" WIP toggle (Settings → Account).
// Mirrors user-context.functions.ts's caller-resolution pattern exactly.

const Caller = z.object({ entra_object_id: z.string().optional(), entra_email: z.string().optional() }).optional();

async function callerEmail(caller: { entra_object_id?: string; entra_email?: string } | undefined): Promise<string | null> {
  if (!caller?.entra_email) return null;
  const { resolveTaskEmail } = await import("../journey/identity");
  return (await resolveTaskEmail(caller)) ?? caller.entra_email;
}

const Caps = z.object({
  approach: z.number().int().min(1).max(10),
  review: z.number().int().min(1).max(10),
  question: z.number().int().min(0).max(10),
});
const PartialCaps = Caps.partial();

const ConfigInput = z.object({
  default_required: z.boolean().optional(),
  agent_overrides: z.record(z.string(), z.boolean()).optional(),
  default_caps: Caps.optional(),
  agent_cap_overrides: z.record(z.string(), PartialCaps).optional(),
  // "No hardcoded config": whether agents may use OpenAI's built-in code interpreter / image
  // generation (i.e. produce real .docx/.pptx/.xlsx/.png rather than only markdown) is a preference
  // the owner can change, not a constant. It rides THIS existing config surface rather than a new
  // one — same table, same server fn, same per-agent override shape as the caps above.
  builtin_tools_enabled: z.boolean().optional(),
  builtin_tools_agent_overrides: z.record(z.string(), z.boolean()).optional(),
});

export const getMyWorkflowConfigFn = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => z.object({ caller: Caller }).parse(raw))
  .handler(async ({ data }): Promise<{ config: AgentWorkflowConfig | null }> => {
    const email = await callerEmail(data.caller);
    if (!email) return { config: null };
    try {
      const { getAgentWorkflowConfig } = await import("./agent-workflow-config.server");
      return { config: await getAgentWorkflowConfig(email) };
    } catch {
      return { config: null };
    }
  });

export const setMyWorkflowConfigFn = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => z.object({ caller: Caller, config: ConfigInput }).parse(raw))
  .handler(async ({ data }): Promise<{ config: AgentWorkflowConfig | null; error?: string }> => {
    const email = await callerEmail(data.caller);
    if (!email) return { config: null, error: "sign-in required" };
    try {
      const { setAgentWorkflowConfig } = await import("./agent-workflow-config.server");
      return { config: await setAgentWorkflowConfig(email, data.config) };
    } catch (e) {
      return { config: null, error: e instanceof Error ? e.message : String(e) };
    }
  });
