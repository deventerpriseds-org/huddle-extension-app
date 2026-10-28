// WHAT:       the phone-push title, and whether it stays in the shade, for one durable turn.
// WHY:        every turn used to push "<Agent> replied". Owner 2026-10-27 (email alerts) and
//             2026-10-28 (the 8pm priority check): a scheduled ask that looks like any chat reply, and
//             clears when tapped, gets missed. The 8pm priority check and the 8pm schedule brief went out
//             one second apart with identical titles (push log 2026-10-28T00:00:07Z / 00:00:08Z).
// SUPERSEDES: the email-only `inboundEmailPush` call at the push site in huddle.functions.ts; that
//             function is unchanged and still decides the email alert's title, via this one.
// SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   scripts/turn-push.test.ts
import { inboundEmailPush } from "../email/inbound-email";

/** What a scheduled job may set on its turn payload as `pushStyle`. `sticky` keeps the notification
 *  in the shade when tapped (journey -> Android bridge setAutoCancel(false)); only Dismiss clears it. */
export interface PushStyle {
  title: string;
  sticky?: boolean;
}

const TITLE_MAX = 80;

/** The push style for a turn payload, or null for the default "<Agent> replied". An email alert wins
 *  (its title names the sender); otherwise a job's own `pushStyle`, if it has a usable title. */
export function turnPushStyle(payload: unknown): { title: string; sticky: boolean } | null {
  const p = (payload ?? {}) as {
    emailReplyRef?: { fromName?: string; fromAddress?: string } | null;
    pushStyle?: { title?: unknown; sticky?: unknown } | null;
  };
  const email = inboundEmailPush(p.emailReplyRef);
  if (email) return email;
  const title = typeof p.pushStyle?.title === "string" ? p.pushStyle.title.replace(/\s+/g, " ").trim() : "";
  if (!title) return null;
  return { title: title.slice(0, TITLE_MAX), sticky: p.pushStyle?.sticky === true };
}
