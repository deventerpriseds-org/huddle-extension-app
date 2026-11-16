// WHAT:       Pure: the FORWARDED email inside a "Fw:" message, as plain text, for the correspondence judge only.
// WHY:        Owner 2026-11-14 circled two "Fw: ... Due ..." emails from his manager that the step-1 scan called "only a
//             name and phone number". The live text path (htmlToText + newTextOnly) cuts everything from Outlook's
//             reply/forward header on -- right for replies and for Iris's live alerts, which the owner said must NOT
//             change -- but on a forward that cut removes the entire ask. This reads the forwarded part SEPARATELY, so
//             the live path is untouched and the judge sees what the owner was actually sent.
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   scripts/reply-scan-preview.ts step=action; test/forwarded.test.ts.
import { htmlToText } from "../external-feeds/onedrive-feed";
import { newTextOnly } from "../email/inbound-email";

/** A subject that marks a forward (English plus the common Outlook locales). */
// Leading mail-gateway tags ("[EXTERNAL] FW: ...", "EXT: FW: ...") are skipped (verifier loop 9, 3d).
export const FORWARD_SUBJECT = /^\s*(?:\[[^\]]{1,30}\]\s*|ext\s*:\s*)*(?:(?:re|aw|sv)\s*:\s*)*(?:fw|fwd|tr|wg|rv|doorst)\s*:/i;

/** The text after newTextOnly's cut (the quoted / forwarded part), or null when nothing meaningful follows. */
function afterCut(input: string): string | null {
  // CRLF bodies: newTextOnly drops "\r", so the prefix test below would never match (verifier loop 9, 3d).
  const text = input.replace(/\r\n?/g, "\n");
  const fresh = newTextOnly(text);
  if (!text.startsWith(fresh) || text.length - fresh.length < 20) return null;
  return text.slice(fresh.length).trim();
}

/** Outlook's reply/forward header block -- the exact marker htmlToText cuts at. */
const RPLY_FWD = /<div[^>]*id=["']?(?:divRplyFwdMsg|appendonsend)["']?/i;

/**
 * Pure: the forwarded email's text (its header lines and body, its OWN quoted history cut at the next marker), or null
 * when the message is not a forward or carries no forwarded part. Never throws. Capped at `max` characters.
 */
export function forwardedText(subject: string | null | undefined, body: string | null | undefined, isHtml: boolean, max = 6000): string | null {
  if (!FORWARD_SUBJECT.test(String(subject ?? ""))) return null;
  const raw = String(body ?? "");
  if (!raw.trim()) return null;
  let out = "";
  if (isHtml) {
    // Prefer the forward HEADER (divRplyFwdMsg): new Outlook puts an empty `appendonsend` div before it, and starting
    // there would also cut at the header itself (verifier loop 9, 3d).
    const m = /<div[^>]*id=["']?divRplyFwdMsg["']?/i.exec(raw) ?? RPLY_FWD.exec(raw);
    if (m) {
      // Rename only THIS marker so htmlToText keeps it; a deeper marker (the forward's own history) is still cut.
      const rest = raw.slice(m.index).replace(/id=(["']?)(?:divRplyFwdMsg|appendonsend)/i, "id=$1fwdpart");
      out = htmlToText(rest);
    } else {
      // No Outlook marker (other clients, or a prefixed id): the forward header is plain "From: ... Sent: ..." text,
      // which newTextOnly cuts at -- so read what comes after that cut. Measured 2026-11-14: 1 of 2+ forwards found
      // with the marker alone.
      out = afterCut(htmlToText(raw)) ?? "";
    }
  } else {
    out = afterCut(raw) ?? "";
  }
  out = out.trim();
  return out ? out.slice(0, max) : null;
}
