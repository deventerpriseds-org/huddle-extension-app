// WHAT:       Pure matcher: which still-owed emails has the owner already answered, judged from his
//             Sent Items. A row is answered when he sent, AFTER it arrived, either (a) anything in the
//             same Graph conversation, or (b) anything addressed (to/cc) to its sender.
// WHY:        Owner, 2026-11-05: "the system should certainly attempt to self clear by checking if i
//             replied before including for sure". The conversation-only check (hasSentReplyInConversation)
//             misses a reply started as a new email, or one from a phone client that broke the thread.
// SUPERSEDES: the per-row conversation loop in reconcileRepliedFromSentItems (kept as its fallback when
//             the Sent Items list cannot be read).  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   .claude/actions.md ACT:owed-digest; tests: bun scripts/owed-digest.test.ts

export interface SentLite {
  sentDateTime: string | null;
  conversationId: string | null;
  /** Lower-cased to + cc addresses. */
  recipients: string[];
}

export interface OwedLite {
  id: string;
  conversation_id: string | null;
  from_address: string | null;
  received_at: string | null;
}

/** Ids of the rows the owner has answered. A sent item with no timestamp never counts, and neither
 *  does one sent before the email arrived (an older message to the same person is not a reply). */
export function answeredRowIds(rows: readonly OwedLite[], sent: readonly SentLite[]): string[] {
  const out: string[] = [];
  for (const r of rows) {
    const after = r.received_at ? Date.parse(r.received_at) : NaN;
    if (!Number.isFinite(after)) continue;
    const from = String(r.from_address ?? "")
      .trim()
      .toLowerCase();
    const hit = sent.some((s) => {
      const t = s.sentDateTime ? Date.parse(s.sentDateTime) : NaN;
      if (!Number.isFinite(t) || t <= after) return false;
      if (r.conversation_id && s.conversationId === r.conversation_id) return true;
      return !!from && s.recipients.includes(from);
    });
    if (hit) out.push(r.id);
  }
  return out;
}
