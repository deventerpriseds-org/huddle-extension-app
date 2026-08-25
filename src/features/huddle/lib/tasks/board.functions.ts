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
  .handler(async ({ data }): Promise<{ tasks: BoardTaskRow[]; debug?: { login?: string; resolved?: string; mirror?: string } }> => {
    const login = data.caller?.entra_email;
    if (!login) return { tasks: [], debug: { login: "(none)", resolved: "(none)" } };
    try {
      const { resolveTaskEmail } = await import("../journey/identity");
      const email = await resolveTaskEmail(data.caller);
      const { getBoardTasks: read, getMirrorStats } = await import("./tasks.server");
      const tasks = email ? await read(email) : [];
      let mirror = "";
      if (!tasks.length) {
        const s = await getMirrorStats();
        mirror = `mirror total=${s.total}; ${s.byEmail.map((r) => `${r.email ?? "(null)"}:${r.n}`).join(", ") || "empty"}`;
      }
      return { tasks, debug: { login, resolved: email ?? "(unresolved)", mirror } };
    } catch (err) {
      return { tasks: [], debug: { login, resolved: `error: ${err instanceof Error ? err.message : String(err)}` } };
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
        // Full desired tag set (journey update_task REPLACES tags with this array). The card UI sends
        // the whole array — existing + added, or existing minus removed — so this stays a plain set-op.
        tags: z.array(z.string()).optional(),
        // Tag ARITHMETIC, resolved server-side against the row's CURRENT tags. Prefer these over
        // `tags` from any long-lived UI (the chat checklist): a message can sit in the thread for
        // hours, and computing a full set from its snapshot would delete every tag added since.
        addTags: z.array(z.string()).optional(),
        removeTags: z.array(z.string()).optional(),
      })
      .parse(raw),
  )
  .handler(async ({ data }): Promise<{ ok: boolean; error: string }> => {
    if (!data.caller?.entra_email) return { ok: false, error: "Sign-in required." };
    const args: Record<string, unknown> = { task_id: data.taskId };
    if (data.status !== undefined) args.status = data.status;
    if (data.assigned_agent !== undefined) args.assigned_agent = data.assigned_agent;
    if (data.category !== undefined) args.category = data.category;
    if (data.tags !== undefined) args.tags = data.tags;
    if (data.addTags?.length || data.removeTags?.length) {
      // Read-then-write. Racy against a simultaneous edit elsewhere, but strictly better than the
      // alternative it replaces (a stale client snapshot), and the window is milliseconds not hours.
      const { getTaskTags } = await import("./tasks.server");
      const current = await getTaskTags(data.taskId);
      const remove = new Set(data.removeTags ?? []);
      const next = current.filter((t) => !remove.has(t));
      for (const t of data.addTags ?? []) if (!next.includes(t)) next.push(t);
      args.tags = next;
    }
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
