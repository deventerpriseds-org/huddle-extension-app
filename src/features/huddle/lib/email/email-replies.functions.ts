import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

// WHAT:       The model-free server actions behind the email-reply card (Save to Drafts / Dismiss) and
//             the owed-vs-settled counts.
// WHY:        Owner, 2026-10-15: a tap two hours later must still work — the context is baked in. The
//             card sends ONLY an emailId; everything else (which message, which mailbox, which reply)
//             is re-read from chat.email_replies, with an ownership check. Mirrors
//             confirm-ask.functions.ts (the confirmAsk / overrideAsk buttons).
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   .claude/actions.md ACT:inbound-email-watch.

const Caller = z
  .object({ entra_object_id: z.string().optional(), entra_email: z.string().optional() })
  .optional();

async function resolveOwner(caller: z.infer<typeof Caller>): Promise<string | null> {
  const { resolveTaskEmail } = await import("../journey/identity");
  return (await resolveTaskEmail(caller)) ?? caller?.entra_email ?? null;
}

type ButtonResult = {
  ok: boolean;
  error?: string;
  alreadyDone?: boolean;
  /** Outlook link to the saved draft, when one was created. */
  webLink?: string;
};

/**
 * Save the suggested reply as a THREADED reply draft in the owner's own Outlook Drafts (Graph
 * createReply on the stored message id). `body` lets the card send an edited version; absent, the
 * stored proposed_reply is used. Drafting only — nothing is ever sent. The row stays OWED (status
 * "drafted") until the owner actually sends it from Outlook, which the next 5-minute run detects.
 */
export const saveEmailReplyDraftFn = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) =>
    z
      .object({
        caller: Caller,
        emailId: z.string().min(1).max(64),
        body: z.string().max(20_000).optional(),
      })
      .parse(raw),
  )
  .handler(async ({ data }): Promise<ButtonResult> => {
    try {
      const owner = await resolveOwner(data.caller);
      if (!owner) return { ok: false, error: "Sign-in required." };
      const ledger = await import("./email-replies.server");
      const row = await ledger.getOwnedEmailReply(data.emailId, owner);
      if (!row) return { ok: false, error: "That email isn't in your list." };
      if (row.status === "drafted" && row.draft_web_link && !data.body) {
        return { ok: true, alreadyDone: true, webLink: row.draft_web_link };
      }
      if (row.status === "replied" || row.status === "dismissed") {
        return { ok: true, alreadyDone: true };
      }
      const body = (data.body ?? row.proposed_reply ?? "").trim();
      if (!body)
        return {
          ok: false,
          error: "Iris hasn't suggested a reply for this one yet — ask her to draft it.",
        };
      const { createReplyDraftForMessage } = await import("./graph-email.server");
      const r = await createReplyDraftForMessage({
        mailbox: row.mailbox,
        graphMessageId: row.graph_message_id,
        body,
      });
      if (!r.ok) {
        console.error("[email-replies] save draft failed", r.error);
        return { ok: false, error: "Outlook didn't accept the draft. Try again in a moment." };
      }
      await ledger.markDrafted(row.id, r.id ?? null, r.webLink ?? null, body);
      return { ok: true, webLink: r.webLink };
    } catch (err) {
      console.error("[email-replies] save draft crashed", err instanceof Error ? err.message : err);
      return { ok: false, error: "Couldn't save the draft." };
    }
  });

/** Settle without replying ("no reply needed"). Idempotent: a second tap is alreadyDone. */
export const dismissEmailReplyFn = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) =>
    z.object({ caller: Caller, emailId: z.string().min(1).max(64) }).parse(raw),
  )
  .handler(async ({ data }): Promise<ButtonResult> => {
    try {
      const owner = await resolveOwner(data.caller);
      if (!owner) return { ok: false, error: "Sign-in required." };
      const ledger = await import("./email-replies.server");
      const row = await ledger.getOwnedEmailReply(data.emailId, owner);
      if (!row) return { ok: false, error: "That email isn't in your list." };
      const moved = await ledger.settleEmailReply(row.id, "dismissed");
      return { ok: true, alreadyDone: !moved };
    } catch (err) {
      console.error("[email-replies] dismiss crashed", err instanceof Error ? err.message : err);
      return { ok: false, error: "Couldn't dismiss that." };
    }
  });

/** Owed vs settled, for the card's tally line. Never throws; zeros + ok:false on failure. */
export const getEmailReplyCountsFn = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) =>
    z.object({ caller: Caller, timeZone: z.string().max(64).optional() }).parse(raw),
  )
  .handler(async ({ data }) => {
    try {
      const owner = await resolveOwner(data.caller);
      if (!owner)
        return { ok: false as const, owed: 0, drafted: 0, settledToday: 0, settledTotal: 0 };
      const { getEmailReplyCounts } = await import("./email-replies.server");
      return {
        ok: true as const,
        ...(await getEmailReplyCounts(owner, data.timeZone || undefined)),
      };
    } catch {
      return { ok: false as const, owed: 0, drafted: 0, settledToday: 0, settledTotal: 0 };
    }
  });
