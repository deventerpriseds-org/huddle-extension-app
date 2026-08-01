// Shared client-side resilience for the durable turn enqueue (enqueueHuddleTurn).
//
// Why this exists: a chat send writes the user message to the store FIRST, then POSTs the turn to
// the server. If that POST throws at the transport layer (aborted / timed out / transient network
// blip / mobile backgrounding), both 1:1 send paths used to SILENTLY swallow the error — leaving the
// message on screen with no reply and no signal. Live DB evidence confirmed the failure mode: the
// message shows client-side but NO `chat.pending_turns` row was ever created, i.e. the request never
// reached the server (the server handler always inserts a row first and returns a status, so a bare
// client throw means "never persisted").
//
// The server turn is idempotent on `turnId` (enqueueTurn dedups), so retrying the SAME payload is
// safe — it can never double-create a turn or a board card. This helper therefore:
//   1. Retries the enqueue a small bounded number of times (recovers a transient blip transparently).
//   2. If every attempt still throws, PROBES the server (getTurnUpdates) for the turnId to tell apart:
//        - "persisted": the turn DID reach the server (row exists) — the app was likely backgrounded
//          mid-turn; stay silent and let the existing deliver-on-reconnect poll loop recover it.
//        - "failed": the turn never reached the server — surface a visible error carrying the REAL
//          thrown message, so the send is never silently lost and the true transport cause is
//          diagnosable.
//
// It takes `enqueue`/`probe` as callbacks so it stays free of any server import and both call sites
// (HuddleView.submit, useVoiceCallRealtime.runTurn) share ONE behavior.

export type EnqueueOutcome<R> =
  | { kind: "resolved"; res: R }
  // Every attempt threw, but the turn IS present server-side — recoverable by the poll loop. Silent.
  | { kind: "persisted"; error: string }
  // Every attempt threw AND no server turn exists — a real, non-recoverable send failure. Surface it.
  | { kind: "failed"; error: string };

export async function resilientEnqueue<R>(opts: {
  /** Fire the enqueue once. Reuse the SAME payload/turnId across retries (server dedups on turnId). */
  enqueue: () => Promise<R>;
  /** True iff a turn with this turnId now exists server-side (e.g. getTurnUpdates find by id). */
  probe: () => Promise<boolean>;
  /** Extra attempts after the first (total tries = retries + 1). Default 2. */
  retries?: number;
  /** Linear backoff base in ms (attempt N waits backoffMs*N). Default 700. */
  backoffMs?: number;
}): Promise<EnqueueOutcome<R>> {
  const retries = opts.retries ?? 2;
  const backoffMs = opts.backoffMs ?? 700;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, backoffMs * attempt));
    try {
      return { kind: "resolved", res: await opts.enqueue() };
    } catch (err) {
      lastErr = err;
    }
  }
  const error = lastErr instanceof Error ? lastErr.message : String(lastErr);
  // All attempts threw. Was the turn persisted server-side despite the client not getting a response?
  // If the probe itself fails (offline), treat as NOT persisted so the failure is surfaced rather than
  // silently assumed-recoverable — a visible error is the safe default when we genuinely can't tell.
  let persisted = false;
  try {
    persisted = await opts.probe();
  } catch {
    persisted = false;
  }
  return persisted ? { kind: "persisted", error } : { kind: "failed", error };
}
