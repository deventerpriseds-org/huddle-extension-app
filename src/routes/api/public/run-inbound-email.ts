import { createFileRoute } from "@tanstack/react-router";
import type {} from "@tanstack/react-start";

// Inbound: the Huddle scheduler (and the manual run-inbound-email.yml) POST here to run ONE pass of
// the INBOUND EMAIL WATCH, server-to-server, gated by the shared JOURNEY_PROXY_TOKEN — no new secret.
// Mirrors run-priority-check.ts; the only difference is the runner it calls.
//
// Body: { caller:{ entra_email }, timeZone?, mode?, lookbackHours?, dryRun?, runId? }.
// The response carries sender DOMAINS and verdicts only (no subjects/bodies): the manual workflow
// prints it and this repo's Actions logs are public.

const MAX_BODY_BYTES = 16_000;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

export const Route = createFileRoute("/api/public/run-inbound-email")({
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
          /** "needs-reply" | "people" | "all" — overrides the default for this run. */
          mode?: string;
          lookbackHours?: number;
          /** true = screen and RETURN the decisions without delivering anything. */
          dryRun?: boolean;
          runId?: string;
          /** Manual only: re-announce still-owed emails once (needs runId). */
          resendOwed?: boolean;
        };
        try {
          payload = (await request.json()) as typeof payload;
        } catch {
          return json({ ok: false, error: "invalid_json" }, 400);
        }

        const userEmail = payload.caller?.entra_email?.trim();
        if (!userEmail) return json({ ok: false, error: "missing_caller_email" }, 400);

        try {
          const { parseInboundEmailMode } =
            await import("@/features/huddle/lib/email/inbound-email");
          const { runInboundEmailWatch } =
            await import("@/features/huddle/lib/email/inbound-email.server");
          const result = await runInboundEmailWatch(
            { entra_email: userEmail },
            {
              timeZone: payload.timeZone,
              mode: parseInboundEmailMode(payload.mode),
              lookbackHours:
                typeof payload.lookbackHours === "number" ? payload.lookbackHours : undefined,
              dryRun: !!payload.dryRun,
              runId: payload.runId,
              resendOwed: payload.resendOwed === true,
            },
          );
          return json(result, result.ok ? 200 : 500);
        } catch (err) {
          console.error("[run-inbound-email] failed", err instanceof Error ? err.message : err);
          return json({ ok: false, error: "inbound_email_failed" }, 500);
        }
      },
    },
  },
});
