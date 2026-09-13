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
//     history?: [], timeZone?, idempotencyKey? }
// A bare `{ "text": "..." }` is a complete, valid request -- an integrating app is not expected to
// know Huddle's huddle/scope/member model.
//
// Returns: { ok:true, turnId, status, replies:[...], toolUses:[{agentId,tool,ok}] }
//
// PERSISTENCE (added 2026-09-08, AC-turn-is-real B1-B5). The turn runs through the DURABLE path --
// chat.pending_turns -> claim -> run -- so a forwarded turn is a real Huddle turn: visible in the UI
// through getTurnUpdates, counted in the same bucket as the owner's own turns, and replayable. The
// turn id is DERIVED from (subject, huddleId, text, 15-min window), so a caller retry re-enters the
// same row rather than running and billing the message twice.

import {
  MAX_BODY_BYTES,
  authenticateCaller,
  buildTurnInput,
  crossAppTurnId,
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

        // The DURABLE turn id. Deterministic, so a caller retry re-enters the same row instead of
        // billing a second run of the same message (AC B5) -- `enqueueTurn` is
        // `INSERT ... ON CONFLICT DO NOTHING` and execution is claim-locked, which only guarantees
        // "exactly once" if the id is stable across attempts.
        const turnId = crossAppTurnId({
          subject: subject.value.entra_email,
          huddleId: built.value.huddleId,
          text: built.value.text,
          idempotencyKey:
            typeof payload.idempotencyKey === "string" && payload.idempotencyKey.trim()
              ? payload.idempotencyKey.trim()
              : undefined,
        });

        try {
          // THE DURABLE PATH -- `chat.pending_turns` -> claim -> run, the same one `HuddleView.tsx`
          // uses through `enqueueHuddleTurn`. This route used to call `runHuddleTurn` DIRECTLY, and
          // that is measured, not theorised: bridge probe run 34191804298 sent one marked turn and
          // got `{"ok":true,"replies":[{"agentId":"elle-rowan","text":"ACK"}]}` back, and
          // azure-pg-query run 34192165151 then found ZERO rows for that marker in BOTH
          // chat.pending_turns and public.rag_chunks. A forward that demonstrably worked was
          // invisible in Huddle's own UI (AC B1-B4).
          //
          // `sendHuddleMessage` also calls `runHuddleTurn` directly and is NOT the model to copy --
          // it is store-blind in exactly the same way.
          //
          // notify:"silent" -- the reply is handed back in THIS HTTP response, so the calling app has
          // already shown it to the user. Firing journey's phone push as well would buzz them about a
          // message they are reading. Same mechanism autowork.server.ts uses for "batch"; one word to
          // change if the owner wants a buzz.
          const { runDurableHuddleTurn } = await import("@/features/huddle/lib/huddle.functions");
          const outcome = await runDurableHuddleTurn({
            ...(built.value as unknown as Parameters<typeof runDurableHuddleTurn>[0]),
            turnId,
            notify: "silent",
          });

          if (outcome.result) {
            return json({ ok: true, turnId, status: outcome.status, ...projectTurnResult(outcome.result) });
          }

          // No result in hand. Either another runner already owns this turn id (a retry landing on
          // the in-flight original), or it completed on an earlier attempt. Read the stored row: a
          // finished turn REPLAYS its persisted replies, so a retry returns text character-identical
          // to what is in the table rather than running the message a second time (AC B5).
          const { getTurn } = await import("@/features/huddle/lib/tasks/turns.server");
          const rec = await getTurn(turnId);
          const stored = (rec as { result?: unknown; replies?: unknown } | null) ?? null;
          const replayable =
            stored && (stored.result ?? (Array.isArray(stored.replies) ? { replies: stored.replies } : null));
          if (replayable) {
            return json({ ok: true, turnId, status: outcome.status, ...projectTurnResult(replayable) });
          }
          if (outcome.error) {
            console.error(`[run-agent-turn] turn ${turnId} failed:`, outcome.error);
            return json({ ok: false, error: "turn_failed", turnId }, 500);
          }
          // Persisted and claimable but not finished here (the cron heartbeat will finish it). The
          // caller gets the id so it can poll rather than being told the turn failed.
          // `tasks: []` is present, not omitted. Every other success response carries the key
          // (projectTurnResult always returns it), and a caller that has to distinguish
          // "absent" from "empty" on one status out of three will get it wrong.
          return json({ ok: true, turnId, status: outcome.status, replies: [], toolUses: [], tasks: [] });
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
