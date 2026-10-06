import { createFileRoute } from "@tanstack/react-router";
import type {} from "@tanstack/react-start";

// Inbound: the Huddle scheduler (and a manual/test workflow) POST here to run ONE edition of the
// schedule brief, server-to-server, gated by the shared JOURNEY_PROXY_TOKEN — no new secret, no
// Entra. Mirrors run-standup.ts exactly; the only thing that differs is which builder it calls.
//
// WHICH EDITION is DERIVED from the local hour, not taken from the body: before noon = the MORNING
// edition (today's meetings and classes), after = the EVENING edition (tomorrow's). That is what
// makes the pair survive a user editing `scheduleBrief.hours` away from the shipped [8, 20].
// `edition` in the body is an override for the manual/test path only.
//
// Body: { caller:{ entra_email }, timeZone?, edition?, force?, runId? }.

const MAX_BODY_BYTES = 16_000;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

export const Route = createFileRoute("/api/public/run-schedule-brief")({
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
          /** true = assemble and RETURN the brief without delivering it. Lets a verification run
           *  read exactly what WOULD be sent without putting a push on the owner's phone. */
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
          const { runScheduleBrief } = await import(
            "@/features/huddle/lib/tasks/schedule-brief-run.server"
          );
          const result = await runScheduleBrief(
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
          console.error("[run-schedule-brief] failed", err instanceof Error ? err.message : err);
          return json({ ok: false, error: "schedule_brief_failed" }, 500);
        }
      },
    },
  },
});
