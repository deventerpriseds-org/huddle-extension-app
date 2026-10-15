// WHAT:       The INBOUND EMAIL WATCH runner: reads the owner's recent Outlook Inbox, keeps the
//             messages screenMessage() lets through, and has Iris tell him about each one in her 1:1
//             with a suggested reply — one durable turn per message, with a phone push.
// WHY:        Iris never mentioned Amy Corriveau's (Trinnex) 2026-10-15 email because nothing read
//             incoming mail. See inbound-email.ts for the full WHY.
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   .claude/actions.md ACT:inbound-email-watch; graph-permission-check.yml run 38799786649.
//
// EXTENDS THE PRIORITY CHECK'S DELIVERY PATH (priority-check.server.ts), which extends the schedule
// brief's and the standup's: a durable turn in Iris's DM with notify:"push" + internal:true, so the
// existing away-notification (journey send_push -> Android bridge) fires with no new sender. Fired by
// the existing every-minute scheduler as job type "inbound-email" — no new cron, no new secret.

import {
  INBOUND_EMAIL_LOOKBACK_HOURS_DEFAULT,
  INBOUND_EMAIL_MODE_DEFAULT,
  inboundEmailDirective,
  inboundEmailTurnId,
  screenMessage,
  type InboundEmailMode,
  type ScreenVerdict,
} from "./inbound-email";

/** Iris owns it, like the priority check and the schedule brief. */
export const INBOUND_EMAIL_OWNER = "iris-chase";

/** At most this many announcements per run, so a burst of mail is a few messages, not a flood. */
const MAX_PER_RUN = 5;

export interface InboundEmailRunResult {
  ok: boolean;
  mailbox?: string;
  mode?: InboundEmailMode;
  since?: string;
  scanned?: number;
  /** Per message: what the screen decided. Sender DOMAIN only — no subject, name, address or body —
   *  because this result is printed by run-inbound-email.yml and the repo's Actions logs are PUBLIC. */
  decisions?: {
    received: string | null;
    fromDomain: string | null;
    verdict: ScreenVerdict;
    turnId?: string;
    delivered?: boolean;
  }[];
  delivered?: number;
  error?: string;
}

/** Run once for one user. NEVER THROWS — like every scheduled job, a throw would lose the tick. */
export async function runInboundEmailWatch(
  caller: { entra_email: string },
  opts: {
    timeZone?: string;
    mode?: InboundEmailMode;
    lookbackHours?: number;
    dryRun?: boolean;
    runId?: string;
    nowMs?: number;
  } = {},
): Promise<InboundEmailRunResult> {
  try {
    const { DEFAULT_TZ } = await import("../identity/scheduling-config.server");
    const tz = opts.timeZone?.trim() || DEFAULT_TZ;
    const mode = opts.mode ?? INBOUND_EMAIL_MODE_DEFAULT;
    const nowMs = opts.nowMs ?? Date.now();
    const hours =
      opts.lookbackHours && opts.lookbackHours > 0
        ? Math.min(opts.lookbackHours, 72)
        : INBOUND_EMAIL_LOOKBACK_HOURS_DEFAULT;
    const since = new Date(nowMs - hours * 3_600_000).toISOString().replace(/\.\d{3}Z$/, "Z");

    // The owner's Outlook mailbox — resolved EXACTLY as the schedule brief and the calendar tool do
    // (journey's connected Microsoft account), never the data-scope login (dev@).
    const { resolveCalendarMailbox } = await import("../journey/identity");
    const mailbox = (await resolveCalendarMailbox(caller)) ?? caller.entra_email;

    const { listInboxMessagesSince } = await import("./graph-email.server");
    const read = await listInboxMessagesSince(mailbox, since);
    if (!read.ok) return { ok: false, mailbox, mode, since, error: read.error };

    // Oldest first, so the owner hears about them in the order they arrived.
    const msgs = [...read.messages].sort((a, b) =>
      String(a.receivedDateTime ?? "").localeCompare(String(b.receivedDateTime ?? "")),
    );
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      weekday: "short",
      hour: "numeric",
      minute: "2-digit",
    });
    const decisions: NonNullable<InboundEmailRunResult["decisions"]> = [];
    let delivered = 0;

    for (const m of msgs) {
      const verdict = screenMessage(m, mode, mailbox);
      const row: (typeof decisions)[number] = {
        received: m.receivedDateTime ?? null,
        fromDomain:
          String(m.fromAddress ?? "")
            .split("@")[1]
            ?.toLowerCase() || null,
        verdict,
      };
      decisions.push(row);
      if (!verdict.keep) continue;

      const received = m.receivedDateTime ? fmt.format(new Date(m.receivedDateTime)) : "just now";
      const directive = inboundEmailDirective(m, received);
      const turnId = inboundEmailTurnId(m.id, opts.runId);
      row.turnId = turnId;
      if (opts.dryRun || delivered >= MAX_PER_RUN) continue;

      const owner = INBOUND_EMAIL_OWNER;
      const payload = {
        text: directive,
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
        // journey disabled: an email alert has no business writing the board.
        agents: { [owner]: { backend: "openai", journey: { enabled: false } } },
        timeZone: tz,
        caller,
        notify: "push",
        internal: true,
      };
      const { enqueueTurn } = await import("../tasks/turns.server");
      const fresh = await enqueueTurn(turnId, `dm-${owner}`, caller.entra_email, payload);
      row.delivered = !!fresh;
      if (fresh) {
        delivered++;
        const { runTurnById } = await import("../huddle.functions");
        await runTurnById(turnId);
      }
    }
    return {
      ok: true,
      mailbox,
      mode,
      since,
      scanned: msgs.length,
      decisions,
      delivered,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
