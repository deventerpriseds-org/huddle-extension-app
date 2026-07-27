import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import type { UserContext } from "./user-context.server";

// Client-callable server fns for the Executive Profile (Settings → Account). Email-scoped via the same
// resolution the task board / artifacts use, so a user only ever reads/writes their own context. The
// server-only store (pg) is imported dynamically so it never bundles into the client.

const Caller = z.object({ entra_object_id: z.string().optional(), entra_email: z.string().optional() }).optional();

async function callerEmail(caller: { entra_object_id?: string; entra_email?: string } | undefined): Promise<string | null> {
  if (!caller?.entra_email) return null;
  const { resolveTaskEmail } = await import("../journey/identity");
  return (await resolveTaskEmail(caller)) ?? caller.entra_email;
}

const CtxInput = z.object({
  goals: z.string().optional(),
  ventures: z.string().optional(),
  positioning: z.string().optional(),
  audience: z.string().optional(),
  income_targets: z.string().optional(),
  notes: z.string().optional(),
});

export const getMyContextFn = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => z.object({ caller: Caller }).parse(raw))
  .handler(async ({ data }): Promise<{ context: UserContext | null }> => {
    const email = await callerEmail(data.caller);
    if (!email) return { context: null };
    try {
      const { getUserContext } = await import("./user-context.server");
      return { context: await getUserContext(email) };
    } catch {
      return { context: null };
    }
  });

export const setMyContextFn = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => z.object({ caller: Caller, context: CtxInput }).parse(raw))
  .handler(async ({ data }): Promise<{ context: UserContext | null; error?: string }> => {
    const email = await callerEmail(data.caller);
    if (!email) return { context: null, error: "sign-in required" };
    try {
      const { setUserContext } = await import("./user-context.server");
      return { context: await setUserContext(email, data.context) };
    } catch (e) {
      return { context: null, error: e instanceof Error ? e.message : String(e) };
    }
  });
