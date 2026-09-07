import { createFileRoute } from "@tanstack/react-router";
import type {} from "@tanstack/react-start";

// WHAT:  POST /api/public/run-agent-turn -- an authenticated, app-agnostic HTTP door onto ONE Huddle
//        agent turn. Any application holding the shared secret can send free text and receive the
//        agents' replies. There is nothing app-specific in here: no caller-app name, no caller-app
//        field, no branching on who is calling.
// WHY:   Huddle's existing turn entrypoint is the `sendHuddleMessage` SERVER FUNCTION at
//        POST /_serverFn/{buildContentHash}. Measured 2026-09-07 (BATCH-5-RESULTS.md test 5.2) it
//        answers 200 to an ANONYMOUS POST and takes the acting user from an unverified body field,
//        so anyone holding the current hash can drive a turn as any user; and the hash MOVES on
//        every deploy, so a caller pinned to it breaks silently. This route fixes both: a stable
//        path, the same shared-secret gate its nine siblings use, and an acting subject the caller
//        cannot name.
//
// AUTH, and the one place it deliberately differs from its siblings:
//   * `x-webhook-secret` vs `process.env.JOURNEY_PROXY_TOKEN` -- the SAME secret already bridging
//     Huddle and journey. No new org credential is minted (standing rule).
//   * The acting subject is read from `CROSS_APP_TURN_SUBJECT`, a server-held app setting. It is
//     NOT a credential -- it is an identifier, safe in plaintext, and must not be rotated as a
//     secret. `run-ceremony.ts`/`run-autowork.ts` and the rest read `caller.entra_email` from the
//     BODY; that is fine for them because each runs a fixed, pre-scoped routine. This route hands
//     FREE TEXT to an agent with the user's board, memory, mailbox and 40+ tools, so the identity
//     must not be caller-chosen. See turn-gate.ts for the full reasoning.
//
// IDENTITY-SHAPED BODY FIELDS ARE REFUSED, LOUDLY (400 `caller_identity_not_accepted`), at any
// nesting depth and in any casing -- see findCallerAssertedIdentity. That refusal is belt and
// braces: the structural defence is that `caller` is built from the environment in buildTurnInput,
// so no body value can reach it regardless of spelling. The refusal exists so a caller that thinks
// it is choosing an identity is told it is not, instead of being silently ignored.
//
// Body (all optional except `text`):
//   { text: string(1..4000), huddleId?, scope?: "group"|"one-to-one", members?: agentId[],
//     history?: [], timeZone? }
// A bare `{ "text": "..." }` is a complete, valid request -- an integrating app is not expected to
// know Huddle's huddle/scope/member model.
//
// Returns: { ok:true, replies:[...], toolUses:[{agentId,tool,ok}] }

import {
  MAX_BODY_BYTES,
  authenticateCaller,
  buildTurnInput,
  findCallerAssertedIdentity,
  projectTurnResult,
  resolveActingSubject,
  type CrossAppTurnBody,
} from "@/features/huddle/lib/cross-app/turn-gate";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

export const Route = createFileRoute("/api/public/run-agent-turn")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        // Q1 -- WHO IS CALLING. 503 when the secret is unset (never "no auth required"), 401 on any
        // mismatch, including an absent header: both take the identical branch so a caller cannot
        // tell "close" from "not close".
        const auth = authenticateCaller(request.headers);
        if (!auth.ok) return json({ ok: false, error: auth.error }, auth.status);

        // Cheap pre-parse rejection. NOTE (honest limit): `content-length` is caller-supplied, so
        // this is a courtesy check, not the backstop. The real backstop is the Azure Static Web Apps
        // / Functions host, which buffers and caps the request body before this handler is entered;
        // the header check only avoids parsing a body we already know is oversized.
        if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) {
          return json({ ok: false, error: "payload_too_large" }, 413);
        }

        let payload: CrossAppTurnBody;
        try {
          payload = (await request.json()) as CrossAppTurnBody;
        } catch {
          return json({ ok: false, error: "invalid_json" }, 400);
        }
        if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
          return json({ ok: false, error: "invalid_json" }, 400);
        }

        // The caller may not assert an identity. The error names only the offending field -- never
        // the configured subject, which the caller has no business learning.
        const asserted = findCallerAssertedIdentity(payload);
        if (asserted) {
          return json({ ok: false, error: "caller_identity_not_accepted", field: asserted }, 400);
        }

        // Q2 -- ON WHOSE BEHALF. Server-held only, and fails CLOSED: no subject, no turn.
        const subject = resolveActingSubject();
        if (!subject.ok) return json({ ok: false, error: subject.error }, subject.status);

        const built = buildTurnInput(payload, subject.value);
        if (!built.ok) return json({ ok: false, error: built.error }, built.status);

        try {
          // The EXISTING turn machinery -- the exact function `sendHuddleMessage` calls. Routing,
          // agent selection, tool dispatch, the action ledger, the confirm-intent gate and the D4
          // email send-gate all live inside it and are reached unchanged. The synchronous
          // (non-chunked) path is used deliberately: an HTTP caller is waiting on this response, and
          // runHuddleTurn's own 36s deadline already bounds it under the hosting ceiling. Wiring the
          // durable `turnId` path would hand the caller an id to poll, which is a different product
          // decision, not this route's to make.
          const { runHuddleTurn } = await import("@/features/huddle/lib/huddle.functions");
          const result = await runHuddleTurn(
            built.value as unknown as Parameters<typeof runHuddleTurn>[0],
          );
          return json({ ok: true, ...projectTurnResult(result) });
        } catch (err) {
          // Generic on the wire, detailed only in the server log. Echoing the error would leak
          // stack frames, file paths and connection strings to an external caller.
          console.error("[run-agent-turn] failed", err instanceof Error ? err.message : err);
          return json({ ok: false, error: "turn_failed" }, 500);
        }
      },
    },
  },
});
