// WHAT:       POST /api/public/polish — the cross-app door onto Huddle's ONE Polish engine. Nexus's
//             Polish page calls it (server-to-server) to list writing profiles and to polish text.
// WHY:        Owner, 2026-11-05, Option A: "make this same module integratable with the nexus app ...
//             an ecosystem of connectable apps" — Huddle hosts the engine, other apps call it.
// SUPERSEDES: nothing
// SUPERSEDED-BY: nothing -- current
// EVIDENCE:   docs/polish/CONTRACT-polish-ecosystem.md §1. Auth is the SAME gate as
//             /api/public/run-agent-turn (cross-app/turn-gate.ts): caller proven by
//             x-webhook-secret == JOURNEY_PROXY_TOKEN; subject = server-held CROSS_APP_TURN_SUBJECT; any
//             caller-asserted identity in the body is refused. No new secret.
import { createFileRoute } from "@tanstack/react-router";
import type {} from "@tanstack/react-start";
import {
  MAX_BODY_BYTES,
  authenticateCaller,
  findCallerAssertedIdentity,
  resolveActingSubject,
} from "@/features/huddle/lib/cross-app/turn-gate";
import { PolishPublicBodySchema } from "@/features/huddle/lib/polish/polish-schema";
import {
  POLISH_TONES,
  QUICK_ACTIONS,
  type PolishRequest,
} from "@/features/huddle/lib/polish/polish-core";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

export const Route = createFileRoute("/api/public/polish")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        // Q1 -- WHO IS CALLING. A trusted integrating app, proven by the shared secret.
        const auth = authenticateCaller(request.headers);
        if (!auth.ok) return json({ ok: false, error: auth.error }, auth.status);

        if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) {
          return json({ ok: false, error: "payload_too_large" }, 413);
        }
        let payload: unknown;
        try {
          payload = await request.json();
        } catch {
          return json({ ok: false, error: "invalid_json" }, 400);
        }
        if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
          return json({ ok: false, error: "invalid_json" }, 400);
        }
        const asserted = findCallerAssertedIdentity(payload);
        if (asserted)
          return json({ ok: false, error: "caller_identity_not_accepted", field: asserted }, 400);

        // Q2 -- ON WHOSE BEHALF. Server-held only; fails CLOSED.
        const subject = resolveActingSubject();
        if (!subject.ok) return json({ ok: false, error: subject.error }, subject.status);

        const parsed = PolishPublicBodySchema.safeParse(payload);
        if (!parsed.success) return json({ ok: false, error: "invalid_request" }, 400);

        const { loadPolishProfiles, runPolish } =
          await import("@/features/huddle/lib/polish/polish.server");
        const { profiles, lastProfileId } = await loadPolishProfiles(subject.value.entra_email);
        if (parsed.data.action === "profiles") {
          return json({
            ok: true,
            profiles,
            lastProfileId,
            tones: POLISH_TONES,
            quickActions: QUICK_ACTIONS,
          });
        }
        const body = parsed.data;
        const base = profiles.find((p) => p.id === body.profileId) ?? profiles[0];
        const result = await runPolish(
          base.name,
          body.settings ?? base,
          body.request as PolishRequest,
          base,
        );
        return json(result, result.ok ? 200 : 502);
      },
    },
  },
});
