import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import type { JobCadence, JobTypeKey, SchedulingConfig } from "./scheduling-config.server";

// Client-callable server fns for the recurring-job cadence Settings panel. Mirrors
// agent-workflow-config.functions.ts's caller-resolution pattern exactly.

const Caller = z.object({ entra_object_id: z.string().optional(), entra_email: z.string().optional() }).optional();

async function callerEmail(caller: { entra_object_id?: string; entra_email?: string } | undefined): Promise<string | null> {
  if (!caller?.entra_email) return null;
  const { resolveTaskEmail } = await import("../journey/identity");
  return (await resolveTaskEmail(caller)) ?? caller.entra_email;
}

const JOB_TYPE_KEYS = ["groom", "autowork", "standup", "reviewDigest", "reviewRecheck"] as const;

const CadenceInput = z.object({
  tz: z.string(),
  hours: z.array(z.number().int().min(0).max(23)),
  daysOfWeek: z.array(z.number().int().min(0).max(6)).optional(),
});

const OverridesInput = z.record(z.enum(JOB_TYPE_KEYS), CadenceInput.optional());

export const getMySchedulingConfigFn = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => z.object({ caller: Caller }).parse(raw))
  .handler(async ({ data }): Promise<{ config: SchedulingConfig | null; defaults: Record<JobTypeKey, JobCadence> }> => {
    const { SCHEDULING_DEFAULTS } = await import("./scheduling-config.server");
    const email = await callerEmail(data.caller);
    if (!email) return { config: null, defaults: SCHEDULING_DEFAULTS };
    try {
      const { getSchedulingConfig } = await import("./scheduling-config.server");
      return { config: await getSchedulingConfig(email), defaults: SCHEDULING_DEFAULTS };
    } catch {
      return { config: null, defaults: SCHEDULING_DEFAULTS };
    }
  });

export const setMySchedulingConfigFn = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => z.object({ caller: Caller, overrides: OverridesInput }).parse(raw))
  .handler(async ({ data }): Promise<{ config: SchedulingConfig | null; error?: string }> => {
    const email = await callerEmail(data.caller);
    if (!email) return { config: null, error: "sign-in required" };
    try {
      const { setSchedulingConfig } = await import("./scheduling-config.server");
      return { config: await setSchedulingConfig(email, data.overrides) };
    } catch (e) {
      return { config: null, error: e instanceof Error ? e.message : String(e) };
    }
  });
