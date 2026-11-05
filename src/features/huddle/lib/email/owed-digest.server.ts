// WHAT:       The OWED-CORRESPONDENCE DIGEST runner: settles anything already answered from Outlook,
//             reads what is still owed, and -- only when 1+ is owed -- has Iris remind the owner in her
//             1:1 (with the list card, Dismiss per row, phone push) AND emails him the same list.
// WHY:        Owner, 2026-11-05 -- see owed-digest.ts. Zero owed = nothing at all, on either channel.
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   .claude/actions.md ACT:owed-digest; tests: bun scripts/owed-digest.test.ts
//
// EXTENDS the inbound-email delivery path (inbound-email.server.ts / priority-check.server.ts): a
// durable turn in Iris's DM with notify:"push" + internal:true, so journey's send_push carries it to
// the phone with no new sender. The email uses the existing SELF-SEND path (sendGraphEmail's D4b
// recipient scope: mail to the owner's own address is allowed even while third-party sending is off).
// Fired by the every-minute scheduler as job type "owed-digest" -- no new cron, no new secret.

import { buildOwedDigest, OWED_DIGEST_OWNER } from "./owed-digest";

export interface OwedDigestRunResult {
  ok: boolean;
  /** Still owed after reconciling. Counts only -- no names/subjects (run-owed-digest.yml logs are PUBLIC). */
  owed?: number;
  /** Settled this run because a reply was found in Sent Items. */
  reconciled?: number;
  skipped?: "none-owed";
  chat?: { delivered: boolean; turnId?: string };
  email?: { sent: boolean; error?: string };
  error?: string;
}

/** Run once for one user. NEVER THROWS -- a throw would lose the scheduler tick. */
export async function runOwedDigest(
  caller: { entra_email: string },
  opts: {
    timeZone?: string;
    runId?: string;
    dryRun?: boolean;
    nowMs?: number;
    /** Default both true. Lets the manual workflow test one channel at a time. */
    chat?: boolean;
    email?: boolean;
  } = {},
): Promise<OwedDigestRunResult> {
  try {
    const { DEFAULT_TZ } = await import("../identity/scheduling-config.server");
    const tz = opts.timeZone?.trim() || DEFAULT_TZ;
    const nowMs = opts.nowMs ?? Date.now();
    const runId =
      opts.runId?.trim() || `${nowMs.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

    // The same two resolutions inbound-email uses: the ledger's owner key, and his Outlook mailbox.
    const { resolveTaskEmail, resolveCalendarMailbox } = await import("../journey/identity");
    const ownerEmail = (await resolveTaskEmail(caller)) ?? caller.entra_email;
    const mailbox = (await resolveCalendarMailbox(caller)) ?? caller.entra_email;

    const ledger = await import("./email-replies.server");
    // Settle anything he already answered from Outlook FIRST, so the reminder never nags about it.
    const reconciled = opts.dryRun ? 0 : await ledger.reconcileRepliedFromSentItems(ownerEmail);
    const rows = await ledger.listOwedEmailReplies(ownerEmail);

    const { selfBase } = await import("../tasks/scheduler.server");
    const digest = buildOwedDigest(rows, { nowMs, appUrl: selfBase(), tz });
    if (!digest) return { ok: true, owed: 0, reconciled, skipped: "none-owed" };
    if (opts.dryRun) return { ok: true, owed: digest.total, reconciled };

    const result: OwedDigestRunResult = { ok: true, owed: digest.total, reconciled };

    if (opts.chat !== false) {
      const owner = OWED_DIGEST_OWNER;
      const turnId = `owed-digest-${runId}`;
      const payload = {
        text: digest.directive,
        huddleId: `dm-${owner}`,
        scope: "one-to-one",
        members: [owner],
        targetAgentId: owner,
        history: [],
        router: {
          backend: "openai",
          model: "gpt-4o-mini",
          soloOnCoverage: true,
          interjections: false,
        },
        // journey disabled: a reminder has no business writing the board.
        agents: { [owner]: { backend: "openai", journey: { enabled: false } } },
        timeZone: tz,
        caller,
        notify: "push",
        internal: true,
        // The list + Dismiss buttons, attached to Iris's reply by the turn runner (not by the model).
        owedDigest: digest.card,
        pushStyle: {
          title: `Iris: you owe ${digest.total} email ${digest.total === 1 ? "reply" : "replies"}`,
          sticky: true,
        },
      };
      const { enqueueTurn } = await import("../tasks/turns.server");
      const fresh = await enqueueTurn(turnId, `dm-${owner}`, caller.entra_email, payload);
      result.chat = { delivered: !!fresh, turnId };
      if (fresh) {
        const { runTurnById } = await import("../huddle.functions");
        await runTurnById(turnId);
      }
    }

    if (opts.email !== false) {
      try {
        const { sendGraphEmail } = await import("./graph-email.server");
        const sent = await sendGraphEmail({
          to: mailbox,
          subject: digest.email.subject,
          body: digest.email.html,
          html: true,
          callerEmail: caller.entra_email,
          callerAgentId: OWED_DIGEST_OWNER,
        });
        // The raw Graph/gate text can echo an address; log it server-side, return a generic reason.
        if (!sent.ok) console.error("[owed-digest] email not sent", sent.error);
        result.email = sent.ok
          ? { sent: true }
          : {
              sent: false,
              error: (sent as { gateRefused?: boolean }).gateRefused
                ? "self-send not allowed for this mailbox"
                : "send failed",
            };
      } catch (err) {
        console.error("[owed-digest] email crashed", err instanceof Error ? err.message : err);
        result.email = { sent: false, error: "send crashed" };
      }
    }
    return result;
  } catch (err) {
    console.error("[owed-digest] run failed", err instanceof Error ? err.message : err);
    return { ok: false, error: "owed digest run failed" };
  }
}
