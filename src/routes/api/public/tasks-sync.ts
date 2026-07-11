import { createFileRoute } from "@tanstack/react-router";
import type {} from "@tanstack/react-start";

// Inbound webhook: journey's supabase pg_net trigger POSTs here on every task
// add/edit/delete, and we mirror the row into Huddle's Azure PG so prioritization
// is supabase-independent. Server-to-server, gated by a shared secret header
// (TASKS_SYNC_SECRET) — no Entra. Body shape from the trigger:
//   { operation: "INSERT"|"UPDATE"|"DELETE", task: {...journey task columns...},
//     user_id?: string, user_email?: string }

const MAX_BODY_BYTES = 64_000;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

export const Route = createFileRoute("/api/public/tasks-sync")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const secret = process.env.TASKS_SYNC_SECRET;
        if (!secret) return json({ ok: false, error: "not_configured" }, 503);
        if (request.headers.get("x-webhook-secret") !== secret) {
          return json({ ok: false, error: "unauthorized" }, 401);
        }
        if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) {
          return json({ ok: false, error: "payload_too_large" }, 413);
        }

        let payload: {
          operation?: string;
          task?: Record<string, unknown>;
          user_id?: string | null;
          user_email?: string | null;
        };
        try {
          payload = (await request.json()) as typeof payload;
        } catch {
          return json({ ok: false, error: "invalid_json" }, 400);
        }

        const op = String(payload.operation ?? "").toUpperCase();
        const task = payload.task as Record<string, unknown> | undefined;
        const id = task?.id != null ? String(task.id) : undefined;
        if (!id) return json({ ok: false, error: "missing_task_id" }, 400);

        try {
          const { upsertJourneyTask, deleteJourneyTask } = await import(
            "@/features/huddle/lib/tasks/tasks.server"
          );
          if (op === "DELETE") {
            await deleteJourneyTask(id);
          } else {
            await upsertJourneyTask(
              task as unknown as import("@/features/huddle/lib/tasks/tasks.server").JourneyTaskPayload,
              payload.user_email ?? (task?.user_email as string | undefined) ?? null,
            );
          }
        } catch (err) {
          console.error("[tasks-sync] mirror failed", err instanceof Error ? err.message : err);
          return json({ ok: false, error: "mirror_failed" }, 500);
        }

        return json({ ok: true, operation: op, id });
      },
    },
  },
});
