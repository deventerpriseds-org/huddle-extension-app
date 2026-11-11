import { createFileRoute } from "@tanstack/react-router";
import type {} from "@tanstack/react-start";

const MAX_BODY_BYTES = 16_384;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

// WHAT: Fireflies Webhooks V2 endpoint. Verifies and QUEUES a delivery; the run-turn heartbeat emails the
//       minutes and saves the transcript (fireflies.server.ts processDueFirefliesMeetings).
// Fireflies Webhooks V2 sends a signed POST. The raw body is passed untouched to the
// HMAC verifier; transcript content is fetched server-to-server from Fireflies by meeting_id.
export const Route = createFileRoute("/api/public/fireflies-webhook")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const configuredSecret = String(process.env.FIREFLIES_WEBHOOK_SECRET ?? "").trim();
        if (!configuredSecret) return json({ ok: false, error: "not_configured" }, 503);

        const contentLength = Number(request.headers.get("content-length") ?? 0);
        if (contentLength > MAX_BODY_BYTES) {
          return json({ ok: false, error: "payload_too_large" }, 413);
        }

        let rawBody: string;
        try {
          rawBody = await request.text();
        } catch {
          return json({ ok: false, error: "invalid_body" }, 400);
        }
        if (new TextEncoder().encode(rawBody).length > MAX_BODY_BYTES) {
          return json({ ok: false, error: "payload_too_large" }, 413);
        }

        try {
          const { handleFirefliesWebhook } = await import(
            "@/features/huddle/lib/fireflies/fireflies.server"
          );
          const result = await handleFirefliesWebhook(
            rawBody,
            request.headers.get("x-hub-signature"),
          );
          // The delivery is recorded; the once-a-minute heartbeat does the work (Fireflies allows 30s).
          return json({ ok: true, ...result }, 200);
        } catch (err) {
          const code = err instanceof Error ? err.message : "webhook_failed";
          if (code === "invalid_webhook_signature") {
            return json({ ok: false, error: "unauthorized" }, 401);
          }
          if (
            code === "invalid_webhook_json" ||
            code === "missing_meeting_id" ||
            code === "invalid_meeting_id"
          ) {
            return json({ ok: false, error: "invalid_payload" }, 400);
          }
          // Do not log webhook bodies, transcript text, API keys, or Graph response bodies. A failed queue
          // write answers 503 so Fireflies retries (5xx is retried 5 times with backoff).
          console.error("[fireflies-webhook] queue write failed", /^[a-z0-9_]{1,80}$/.test(code) ? code : "webhook_failed");
          return json({ ok: false, error: "processing_failed", code: /^[a-z0-9_]{1,80}$/.test(code) ? code : "webhook_failed" }, 503);
        }
      },
    },
  },
});
