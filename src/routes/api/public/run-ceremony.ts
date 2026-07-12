import { createFileRoute } from "@tanstack/react-router";
import type {} from "@tanstack/react-start";

// Inbound: journey's scheduled-ceremony runner POSTs here to run a scrum ceremony on cadence
// (server-to-server, gated by the shared JOURNEY_PROXY_TOKEN — no new secret, no Entra). The
// ceremony runs grounded in the user's real tasks and the transcript is persisted for later
// review. Body: { ceremonyType, caller:{ entra_email }, mode?, autoRun?, runId?, timeZone? }.

const MAX_BODY_BYTES = 16_000;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

const CEREMONY_TYPES = new Set(["standup", "retro", "planning", "review", "review_retro"]);

export const Route = createFileRoute("/api/public/run-ceremony")({
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
          ceremonyType?: string;
          caller?: { entra_email?: string } | null;
          mode?: string;
          autoRun?: boolean;
          runId?: string;
          timeZone?: string;
        };
        try {
          payload = (await request.json()) as typeof payload;
        } catch {
          return json({ ok: false, error: "invalid_json" }, 400);
        }

        const ceremonyType = String(payload.ceremonyType ?? "");
        if (!CEREMONY_TYPES.has(ceremonyType)) {
          return json({ ok: false, error: "invalid_ceremony_type" }, 400);
        }
        const userEmail = payload.caller?.entra_email?.trim();
        if (!userEmail) return json({ ok: false, error: "missing_caller_email" }, 400);

        const mode = payload.mode === "narrate" ? "narrate" : "round-robin";
        // Date-based ids are fine server-side; the scheduler supplies a stable id for idempotency.
        const runId = payload.runId?.trim() || `cer-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

        try {
          const { runScheduledCeremony } = await import(
            "@/features/huddle/lib/tasks/ceremonies.server"
          );
          const result = await runScheduledCeremony({
            runId,
            ceremonyType: ceremonyType as "standup" | "retro" | "planning" | "review" | "review_retro",
            userEmail,
            mode,
            autoRun: !!payload.autoRun,
            timeZone: payload.timeZone,
          });
          return json({
            ok: true,
            runId,
            ceremonyType: result.ceremonyType,
            mode: result.mode,
            summary: result.summary,
            turns: result.transcript.length,
            transcript: result.transcript,
          });
        } catch (err) {
          console.error("[run-ceremony] failed", err instanceof Error ? err.message : err);
          return json({ ok: false, error: "ceremony_failed" }, 500);
        }
      },
    },
  },
});
