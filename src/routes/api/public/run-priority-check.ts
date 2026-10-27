import { createFileRoute } from "@tanstack/react-router";
import type {} from "@tanstack/react-start";

// Inbound: the Huddle scheduler (and a manual/test path) POST here to run ONE edition of the
// scheduled PRIORITY CHECK, server-to-server, gated by the shared JOURNEY_PROXY_TOKEN — no new
// secret. Mirrors run-schedule-brief.ts; the only difference is the runner it calls.
//
// WHICH EDITION is DERIVED from the local hour (before noon = morning, ahead of grooming; after =
// evening, ahead of the nightly scheduler). `edition` in the body overrides it for testing only.
//
// Body: { caller:{ entra_email }, timeZone?, edition?, dryRun?, runId? }.

const MAX_BODY_BYTES = 16_000;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

export const Route = createFileRoute("/api/public/run-priority-check")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const secret = process.env.JOURNEY_PROXY_TOKEN;
        if (!secret) return json({ ok: false, error: "not_configured" }, 503);
        if (request.headers.get("x-webhook-secret") !== secret) {
          return json({ ok: false, error: "unauthorized" }, 401);
        }
        if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) {
          return json({ ok: false, error: "payload_too_large" }, 413);
        }

        let payload: {
          caller?: { entra_email?: string } | null;
          timeZone?: string;
          /** "morning" | "evening" — overrides the hour-derived edition. Manual/test path only. */
          edition?: string;
          /** true = compute and RETURN the summary + directive without delivering anything. */
          dryRun?: boolean;
          runId?: string;
        };
        try {
          payload = (await request.json()) as typeof payload;
        } catch {
          return json({ ok: false, error: "invalid_json" }, 400);
        }

        const userEmail = payload.caller?.entra_email?.trim();
        if (!userEmail) return json({ ok: false, error: "missing_caller_email" }, 400);

        const edition =
          payload.edition === "morning" || payload.edition === "evening" ? payload.edition : undefined;

        try {
          const { runPriorityCheck } = await import("@/features/huddle/lib/tasks/priority-check.server");
          const result = await runPriorityCheck(
            { entra_email: userEmail },
            {
              timeZone: payload.timeZone,
              edition,
              dryRun: !!payload.dryRun,
              runId: payload.runId,
            },
          );
          return json(result, result.ok ? 200 : 500);
        } catch (err) {
          console.error("[run-priority-check] failed", err instanceof Error ? err.message : err);
          return json({ ok: false, error: "priority_check_failed" }, 500);
        }
      },
    },
  },
});
