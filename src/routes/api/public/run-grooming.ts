import { createFileRoute } from "@tanstack/react-router";
import type {} from "@tanstack/react-start";

// Inbound: journey's scheduler POSTs here on a cadence (default 6×/day) to auto-groom the backlog
// server-to-server, gated by the shared JOURNEY_PROXY_TOKEN — no new secret, no Entra. Terry grooms
// only when the backlog changed since the last groom (unless force:true, the manual/test path), and
// surfaces a proactive summary + push when something meaningful changed.
// Body: { caller:{ entra_email }, timeZone?, force?, runId? }.

const MAX_BODY_BYTES = 16_000;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

export const Route = createFileRoute("/api/public/run-grooming")({
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
          const { runScheduledGrooming } = await import(
            "@/features/huddle/lib/tasks/grooming.server"
          );
          const result = await runScheduledGrooming(
            { entra_email: userEmail },
            { timeZone: payload.timeZone, force: !!payload.force, runId: payload.runId },
          );
          return json(result, result.ok ? 200 : 500);
        } catch (err) {
          console.error("[run-grooming] failed", err instanceof Error ? err.message : err);
          return json({ ok: false, error: "grooming_failed" }, 500);
        }
      },
    },
  },
});
