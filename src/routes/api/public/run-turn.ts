import { createFileRoute } from "@tanstack/react-router";
import type {} from "@tanstack/react-start";

// Device-independent turn runner. journey's always-on pg_cron POSTs here every minute (empty body)
// to DRAIN any chat turn left queued or stale-running — the guaranteed backstop that makes a huddle
// reply complete even while the user's phone is asleep / the app is closed and its long fetch died.
// Optionally accepts { turnId } to run one specific turn. Server-to-server only, gated by the shared
// JOURNEY_PROXY_TOKEN (x-webhook-secret) — same auth as run-ceremony / tasks-sync, no new secret.

const MAX_BODY_BYTES = 4_000;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

export const Route = createFileRoute("/api/public/run-turn")({
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

        let payload: { turnId?: string; max?: number } = {};
        try {
          const raw = (await request.text()).trim();
          if (raw) payload = JSON.parse(raw) as typeof payload;
        } catch {
          return json({ ok: false, error: "invalid_json" }, 400);
        }

        try {
          const { drainQueuedTurns, runTurnById } = await import(
            "@/features/huddle/lib/huddle.functions"
          );
          if (payload.turnId) {
            const ran = await runTurnById(payload.turnId);
            return json({ ok: true, turnId: payload.turnId, ran });
          }
          const max = Math.min(Math.max(1, payload.max ?? 5), 20);
          const ran = await drainQueuedTurns(max);
          return json({ ok: true, ran });
        } catch (err) {
          console.error("[run-turn] failed", err instanceof Error ? err.message : err);
          return json({ ok: false, error: "run_turn_failed" }, 500);
        }
      },
    },
  },
});
