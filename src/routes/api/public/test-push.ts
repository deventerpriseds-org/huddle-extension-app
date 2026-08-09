import { createFileRoute } from "@tanstack/react-router";
import type {} from "@tanstack/react-start";

// Diagnostic: send a PURE push (no agent turn, no reply generation) straight through journey's
// send_push — the SAME path agent replies (executeClaimedTurn, channel "messages") and reminders
// (reminders.ts, channel "task-reminders") use. Fires on one or more channels so we can tell which
// notification channel actually lands on the Huddle bridge app. Guarded by the shared
// JOURNEY_PROXY_TOKEN (no new secret, no Entra). Body: { caller:{entra_email}, channels?, title?, body? }.

const MAX_BODY_BYTES = 8_000;
const DEFAULT_CHANNELS = ["messages", "task-reminders"] as const;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

export const Route = createFileRoute("/api/public/test-push")({
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
          channels?: string[];
          title?: string;
          body?: string;
          app?: string;
          runId?: string;
        };
        try {
          payload = (await request.json()) as typeof payload;
        } catch {
          return json({ ok: false, error: "invalid_json" }, 400);
        }

        const userEmail = payload.caller?.entra_email?.trim();
        if (!userEmail) return json({ ok: false, error: "missing_caller_email" }, 400);

        const channels =
          Array.isArray(payload.channels) && payload.channels.length
            ? payload.channels.map((c) => String(c))
            : [...DEFAULT_CHANNELS];
        const stamp = payload.runId || String(request.headers.get("x-request-id") || "testpush");

        try {
          const { invokeJourneyTool } = await import(
            "@/features/huddle/lib/journey/proxy.functions"
          );
          const results: { channel: string; ok: boolean; output?: string; error?: string }[] = [];
          // app targeting: default "huddle" (fcm:app:huddle:% token). Pass app="none"/"" to OMIT the
          // filter → journey-native fan-out (every non-app-namespaced token, the path reminders/alarms
          // that DO arrive already use). This is the diagnostic knob to compare huddle-token vs native.
          const rawApp = (payload.app ?? "huddle").trim();
          const useApp = rawApp && rawApp.toLowerCase() !== "none" ? rawApp : null;
          for (const channel of channels) {
            const title = payload.title || `Huddle test push (${channel}${useApp ? "" : "/native"})`;
            const body =
              payload.body ||
              `If you see this, the "${channel}" channel${useApp ? ` via app:${useApp}` : " (native, no app filter)"} reaches your device. Tag ${stamp}.`;
            // STABLE per-channel identity: a new test push COLLAPSES onto the previous one (never stacks)
            // and replaces a stale one, and a short TTL means FCM/web-push won't retry/redeliver a stale
            // diagnostic beyond 2 min — so a leftover test push can't linger or re-alert on a loop. The
            // unique run stamp stays only in the visible body text (above) for run-to-run diagnostics.
            const collapseId = `huddle-test-push-${channel}`;
            try {
              const r = await invokeJourneyTool({
                toolName: "send_push",
                args: {
                  title,
                  body,
                  channel,
                  ...(useApp ? { app: useApp } : {}),
                  data: {
                    source: "huddle-test-push",
                    notificationId: collapseId,
                    tag: collapseId,
                    collapseKey: collapseId,
                    ttl: 120,
                    channelTested: channel,
                    runId: stamp,
                  },
                },
                caller: { entra_email: userEmail },
                context: { source: "huddle" },
              });
              results.push({
                channel,
                ok: !!r?.ok,
                output: typeof r?.output === "string" ? r.output.slice(0, 400) : undefined,
              });
            } catch (err) {
              results.push({
                channel,
                ok: false,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }
          return json({ ok: true, email: userEmail, stamp, results });
        } catch (err) {
          console.error("[test-push] failed", err instanceof Error ? err.message : err);
          return json({ ok: false, error: "test_push_failed" }, 500);
        }
      },
    },
  },
});
