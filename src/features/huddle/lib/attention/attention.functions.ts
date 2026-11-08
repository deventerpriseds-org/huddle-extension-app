import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

// WHAT:       Server actions behind the attention bell: read the open items + count, dismiss one, and
//             read/save which item types count ("things I identify as urgent").
// WHY:        Owner, 2026-11-08 (option A): a count that stays until he dismisses it in the bell or deals
//             with it in the chat, so a missed phone push no longer means a missed email or meeting.
//             Reuses the owed-email list (chat.email_replies) and the same caller -> owner resolution and
//             ownership check as email-replies.functions.ts.
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   scripts/attention.test.ts; .claude/actions.md ACT:attention-bell.

const Caller = z
  .object({ entra_object_id: z.string().optional(), entra_email: z.string().optional() })
  .optional();

async function resolveOwner(caller: z.infer<typeof Caller>): Promise<string | null> {
  const { resolveTaskEmail } = await import("../journey/identity");
  return (await resolveTaskEmail(caller)) ?? caller?.entra_email ?? null;
}

export const getAttentionFn = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => z.object({ caller: Caller }).parse(raw))
  .handler(async ({ data }) => {
    const { bellItems, parseUrgentKinds } = await import("./attention");
    try {
      const owner = await resolveOwner(data.caller);
      if (!owner) return { ok: false as const, count: 0, items: [], kinds: parseUrgentKinds(null) };
      const ledger = await import("../email/email-replies.server");
      const kinds = parseUrgentKinds(await ledger.getUrgentKinds(owner));
      const items = bellItems(await ledger.listOpenAttention(owner), kinds);
      return { ok: true as const, count: items.length, items, kinds };
    } catch (err) {
      console.error("[attention] read failed", err instanceof Error ? err.message : err);
      return { ok: false as const, count: 0, items: [], kinds: parseUrgentKinds(null) };
    }
  });

/** Dismiss one bell item (any kind). Same ownership rule as the email card's Dismiss. */
export const dismissAttentionFn = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) =>
    z.object({ caller: Caller, id: z.string().min(1).max(160) }).parse(raw),
  )
  .handler(async ({ data }) => {
    try {
      const owner = await resolveOwner(data.caller);
      if (!owner) return { ok: false, error: "Sign-in required." };
      const ledger = await import("../email/email-replies.server");
      const row = await ledger.getOwnedEmailReply(data.id, owner);
      if (!row) return { ok: false, error: "That item isn't in your list." };
      const moved = await ledger.settleEmailReply(row.id, "dismissed");
      return { ok: true, alreadyDone: !moved };
    } catch (err) {
      console.error("[attention] dismiss failed", err instanceof Error ? err.message : err);
      return { ok: false, error: "Couldn't dismiss that." };
    }
  });

export const setAttentionKindsFn = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) =>
    z.object({ caller: Caller, kinds: z.array(z.string().max(32)).max(10) }).parse(raw),
  )
  .handler(async ({ data }) => {
    const { parseUrgentKinds } = await import("./attention");
    try {
      const owner = await resolveOwner(data.caller);
      if (!owner) return { ok: false, kinds: parseUrgentKinds(null) };
      const kinds = parseUrgentKinds(data.kinds);
      const ledger = await import("../email/email-replies.server");
      await ledger.setUrgentKinds(owner, kinds);
      return { ok: true, kinds };
    } catch (err) {
      console.error("[attention] settings save failed", err instanceof Error ? err.message : err);
      return { ok: false, kinds: parseUrgentKinds(data.kinds) };
    }
  });
