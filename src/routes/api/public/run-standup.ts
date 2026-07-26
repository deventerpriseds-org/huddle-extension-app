import { createFileRoute } from "@tanstack/react-router";
import type {} from "@tanstack/react-start";

// Inbound: the Huddle scheduler (and a manual/test workflow) POST here to run one ACT-5 standup digest
// server-to-server, gated by the shared JOURNEY_PROXY_TOKEN — no new secret, no Entra. It summarizes the
// prior day's autonomous work + blockers + top priorities and delivers ONE morning digest (push) in the
// coordinator's DM. A cadence fire is a no-op when nothing happened (unless force:true, the manual path).
// Body: { caller:{ entra_email }, timeZone?, force?, runId? }.

const MAX_BODY_BYTES = 16_000;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

export const Route = createFileRoute("/api/public/run-standup")({
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
          force?: boolean;
          runId?: string;
        };
        try {
          payload = (await request.json()) as typeof payload;
        } catch {
          return json({ ok: false, error: "invalid_json" }, 400);
        }

        const userEmail = payload.caller?.entra_email?.trim();
        if (!userEmail) return json({ ok: false, error: "missing_caller_email" }, 400);

        try {
          const { runScheduledStandup } = await import(
            "@/features/huddle/lib/tasks/standup.server"
          );
          const result = await runScheduledStandup(
            { entra_email: userEmail },
            { timeZone: payload.timeZone, force: !!payload.force, runId: payload.runId },
          );
          return json(result, result.ok ? 200 : 500);
        } catch (err) {
          console.error("[run-standup] failed", err instanceof Error ? err.message : err);
          return json({ ok: false, error: "standup_failed" }, 500);
        }
      },
    },
  },
});
