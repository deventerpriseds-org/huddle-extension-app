import { createFileRoute } from "@tanstack/react-router";
import type {} from "@tanstack/react-start";

// Inbound: the Huddle scheduler (and the manual run-owed-digest.yml) POST here to run ONE pass of the
// OWED-CORRESPONDENCE DIGEST, server-to-server, gated by the shared JOURNEY_PROXY_TOKEN — no new secret.
// Mirrors run-inbound-email.ts; the only difference is the runner it calls.
//
// Body: { caller:{ entra_email }, timeZone?, dryRun?, runId?, chat?, email? }.
// The response carries COUNTS only (no names/subjects): the manual workflow prints it and this repo's
// Actions logs are public.

const MAX_BODY_BYTES = 16_000;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

export const Route = createFileRoute("/api/public/run-owed-digest")({
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
          /** true = count what is owed and RETURN it, deliver nothing. */
          dryRun?: boolean;
          runId?: string;
          /** false = skip that channel this run (manual testing). Default both on. */
          chat?: boolean;
          email?: boolean;
        };
        try {
          payload = (await request.json()) as typeof payload;
        } catch {
          return json({ ok: false, error: "invalid_json" }, 400);
        }

        const userEmail = payload.caller?.entra_email?.trim();
        if (!userEmail) return json({ ok: false, error: "missing_caller_email" }, 400);

        try {
          const { runOwedDigest } = await import("@/features/huddle/lib/email/owed-digest.server");
          const result = await runOwedDigest(
            { entra_email: userEmail },
            {
              timeZone: payload.timeZone,
              dryRun: !!payload.dryRun,
              runId: payload.runId,
              chat: payload.chat !== false,
              email: payload.email !== false,
            },
          );
          return json(result, result.ok ? 200 : 500);
        } catch (err) {
          console.error("[run-owed-digest] failed", err instanceof Error ? err.message : err);
          return json({ ok: false, error: "owed_digest_failed" }, 500);
        }
      },
    },
  },
});
