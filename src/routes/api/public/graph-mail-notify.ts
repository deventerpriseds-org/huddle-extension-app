import { createFileRoute } from "@tanstack/react-router";
import type {} from "@tanstack/react-start";

// WHAT:       Microsoft Graph calls this the moment a new email lands in the owner's Outlook Inbox; it
//             runs ONE pass of the inbound email watch right away instead of waiting for the next
//             5-minute check.
// WHY:        2026-10-27: Amy's email waited 3m23s for the poll ("Iris did not immediately send me an
//             alert"). See lib/email/mail-subscription.ts.
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   .claude/actions.md ACT:instant-email-alerts.
//
// Two request shapes, both POST from Graph:
//  1. ?validationToken=… — the subscription handshake. Echo it as text/plain within 10s, or Graph
//     refuses to create the subscription.
//  2. { value: [{ subscriptionId, clientState, … }] } — a change notification. Trusted ONLY when
//     clientState matches the one derived from JOURNEY_PROXY_TOKEN and the subscription is ours.
// Graph wants an answer within ~3s, so the watch is kicked as its own request (the run-inbound-email
// route — same auth, same runner) and the scheduled job is pulled forward to now as the backstop.
// Always 202 for a notification: a retried notification would only repeat an idempotent check.

const MAX_BODY_BYTES = 200_000;
const KICK_WAIT_MS = 2_500;

export const Route = createFileRoute("/api/public/graph-mail-notify")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const validationToken = new URL(request.url).searchParams.get("validationToken");
        if (validationToken !== null) {
          return new Response(validationToken, {
            status: 200,
            headers: { "Content-Type": "text/plain", "Cache-Control": "no-store" },
          });
        }
        const accepted = () => new Response(null, { status: 202 });
        const token = (process.env.JOURNEY_PROXY_TOKEN ?? "").trim();
        if (!token) return accepted();
        if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) return accepted();

        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return accepted();
        }
        try {
          const { mailClientState, trustedSubscriptionIds, withinAlertHours } =
            await import("@/features/huddle/lib/email/mail-subscription");
          const ids = trustedSubscriptionIds(body, mailClientState(token));
          if (ids.length === 0) return accepted();
          const { callersForSubscriptions, mailNotificationUrl } =
            await import("@/features/huddle/lib/email/mail-subscription.server");
          const callers = await callersForSubscriptions(ids);
          const base = (mailNotificationUrl() ?? "").replace(
            /\/api\/public\/graph-mail-notify$/,
            "",
          );
          const { resolveJobCadence } =
            await import("@/features/huddle/lib/identity/scheduling-config.server");

          await Promise.all(
            callers.map(async (email) => {
              const cadence = await resolveJobCadence(email, "inboundEmail");
              // Outside alert hours: the first morning check (12h lookback) picks it up.
              if (!withinAlertHours(cadence.hours, cadence.tz, Date.now())) return;
              // Backstop first: pull the scheduled check forward, so the every-minute heartbeat runs
              // it even if the kick below is cut off.
              try {
                const { resolveScopeByEmail } =
                  await import("@/features/huddle/lib/identity/identity.server");
                const { scheduledJobId } =
                  await import("@/features/huddle/lib/tasks/scheduler.server");
                const { setScheduledJobNextRun } =
                  await import("@/features/huddle/lib/tasks/tasks.server");
                const { userId } = await resolveScopeByEmail(email);
                await setScheduledJobNextRun(
                  scheduledJobId("inbound-email", email, userId),
                  new Date().toISOString(),
                );
              } catch (err) {
                console.error(
                  "[graph-mail-notify] backstop failed",
                  err instanceof Error ? err.message : err,
                );
              }
              if (!base) return;
              await fetch(`${base}/api/public/run-inbound-email`, {
                method: "POST",
                headers: { "content-type": "application/json", "x-webhook-secret": token },
                body: JSON.stringify({
                  caller: { entra_email: email },
                  timeZone: cadence.tz,
                  lookbackHours: 2,
                  runId: `graph-${Date.now()}`,
                }),
                signal: AbortSignal.timeout(KICK_WAIT_MS),
              }).catch(() => {
                /* timed out waiting is expected: the run continues in its own request */
              });
            }),
          );
        } catch (err) {
          console.error("[graph-mail-notify] failed", err instanceof Error ? err.message : err);
        }
        return accepted();
      },
    },
  },
});
