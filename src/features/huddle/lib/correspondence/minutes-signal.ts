// WHAT:       Pure predicate: is this email / Teams message MEETING MINUTES (so never a reply item and never a
//             proposal source)? Returns the rule that matched, or why it did not.
// WHY:        Owner 2026-11-14: minutes were listed as emails to answer, and their action items became automatic
//             to-dos. AC docs/qc-evidence/AC-correspondence-redesign.md R5 ("What counts as minutes"), AC-R5.1,
//             AC-R5.4 and spelling table S-C. Built for the conversation classifier (R2-R4, a parallel lane) to
//             call; it never calls screenMessage and never passes a subject to asksSomething (AC-R1.5).
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   scripts/meeting-triage.test.ts section A (S-C rows); docs/qc-evidence/IMPL-meeting-triage.md.
//
// THIS REPO IS PUBLIC: synthetic spellings only. Pure: no I/O.
import { asksSomething } from "../email/inbound-email";

export type MinutesRule = "huddle_subject" | "vendor_sender" | "subject_keyword" | "teams_app_meeting_chat";

export type MinutesVerdict =
  | { minutes: true; rule: MinutesRule }
  /** `direct_ask`: a subject keyword matched, but the new text asks something (AC-R5.4 / S-C7). `reply_or_forward`:
   *  a person wrote it (Re:/Fw:), so it is decided as a normal message (S-C6). */
  | { minutes: false; reason: "no_signal" | "direct_ask" | "reply_or_forward" };

export interface MinutesInput {
  subject?: string | null;
  fromAddress?: string | null;
  /** The latest non-owner NEW text (quoted history already removed by the caller, e.g. newTextOnly). */
  newText?: string | null;
  /** Teams only. `chatKind` is the classifier's label (R3.13): one_to_one | group | meeting_chat | unknown. */
  teams?: { senderIsApp?: boolean | null; chatKind?: string | null } | null;
}

/** Huddle's own minutes subject (minutes.ts minutesSubject: "Meeting Minutes: ..." / "Updated Meeting Minutes: ..."). */
export const HUDDLE_MINUTES_SUBJECT = /^\s*(?:updated\s+)?meeting\s+minutes\s*:/i;
/** Minutes vendors whose mail is minutes whatever its subject (UNVERIFIED sender, probe P-2). Whole domain labels. */
export const MINUTES_VENDOR_DOMAINS: readonly string[] = ["fireflies.ai"];
/** Subject words that MAY mean minutes; only decisive when the new text asks nothing (push-back in R5). */
const SUBJECT_KEYWORD = /\bmeeting\s+(?:notes|minutes|recap|summary)\b|^\s*(?:recap|summary)\s+of\b/i;
const REPLY_OR_FORWARD = /^\s*(?:re|fw|fwd)\s*:/i;

/** Pure: the lower-cased domain of an address (`Name <a@b>` or bare), or "". */
function domainOf(address: string | null | undefined): string {
  const s = String(address ?? "").trim().toLowerCase();
  const inner = s.match(/<([^<>]*)>\s*$/)?.[1] ?? s;
  const at = inner.lastIndexOf("@");
  return at >= 0 ? inner.slice(at + 1).trim() : "";
}

/** Pure: whole-label match (`fireflies.ai`, `mail.fireflies.ai`), never a substring (`notfireflies.ai`,
 *  `fireflies.ai.evil.test`). */
export function isMinutesVendor(address: string | null | undefined): boolean {
  const d = domainOf(address);
  return !!d && MINUTES_VENDOR_DOMAINS.some((v) => d === v || d.endsWith(`.${v}`));
}

/**
 * Pure. Order: a Teams app sender in a meeting chat; then, for email, a vendor sender is minutes outright; a
 * Re:/Fw: subject is a person writing (decided normally); Huddle's own subject is minutes; a subject keyword is
 * minutes only when the new text has no direct ask. `asks` defaults to asksSomething on the BODY only (an
 * empty subject, so its invite-subject clause can never fire, AC-R1.5).
 */
export function minutesSignal(m: MinutesInput, asks: (text: string) => boolean = (t) => asksSomething({ subject: "", bodyText: t })): MinutesVerdict {
  if (m.teams) {
    return m.teams.senderIsApp === true && m.teams.chatKind === "meeting_chat" ? { minutes: true, rule: "teams_app_meeting_chat" } : { minutes: false, reason: "no_signal" };
  }
  const subject = String(m.subject ?? "");
  // A vendor's own mail is never written by a person, whatever its subject (S-C3).
  if (isMinutesVendor(m.fromAddress)) return { minutes: true, rule: "vendor_sender" };
  if (REPLY_OR_FORWARD.test(subject)) return { minutes: false, reason: "reply_or_forward" };
  if (HUDDLE_MINUTES_SUBJECT.test(subject)) return { minutes: true, rule: "huddle_subject" };
  if (SUBJECT_KEYWORD.test(subject)) {
    return asks(String(m.newText ?? "")) ? { minutes: false, reason: "direct_ask" } : { minutes: true, rule: "subject_keyword" };
  }
  return { minutes: false, reason: "no_signal" };
}
