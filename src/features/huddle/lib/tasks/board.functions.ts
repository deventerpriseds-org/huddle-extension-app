import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import type { BoardTaskRow } from "./tasks.server";

// The Kanban board reads the Azure-PG mirror (the real journey backlog, incl. what grooming
// assigned/ranked) and writes changes back to journey via the huddle-proxy update_task — so a
// drag between columns/lanes is a canonical journey edit that syncs back into the mirror.
// tasks.server + journey proxy are imported dynamically so pg / server-only deps never bundle.

const Caller = z.object({ entra_object_id: z.string().optional(), entra_email: z.string().optional() }).optional();

export const getBoardTasks = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => z.object({ caller: Caller }).parse(raw))
  .handler(async ({ data }): Promise<{ tasks: BoardTaskRow[] }> => {
    if (!data.caller?.entra_email) return { tasks: [] };
    try {
      const { resolveTaskEmail } = await import("../journey/identity");
      const email = await resolveTaskEmail(data.caller);
      if (!email) return { tasks: [] };
      const { getBoardTasks: read } = await import("./tasks.server");
      return { tasks: await read(email) };
    } catch {
      return { tasks: [] };
    }
  });

// Persist a card move. status → column change; assigned_agent → swimlane(assignee) change;
// category → swimlane(category) change. Written to journey; the mirror catches up via sync (~1-3s).
export const updateBoardTask = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) =>
    z
      .object({
        caller: Caller,
        taskId: z.string().min(1),
        status: z.string().optional(),
        assigned_agent: z.string().optional(),
        category: z.string().optional(),
      })
      .parse(raw),
  )
  .handler(async ({ data }): Promise<{ ok: boolean; error: string }> => {
    if (!data.caller?.entra_email) return { ok: false, error: "Sign-in required." };
    const args: Record<string, unknown> = { task_id: data.taskId };
    if (data.status !== undefined) args.status = data.status;
    if (data.assigned_agent !== undefined) args.assigned_agent = data.assigned_agent;
    if (data.category !== undefined) args.category = data.category;
    try {
      const { invokeJourneyTool } = await import("../journey/proxy.functions");
      const r = await invokeJourneyTool({
        toolName: "update_task",
        args,
        caller: data.caller,
        context: { source: "huddle" },
      });
      return { ok: r.ok, error: r.error ?? "" };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
