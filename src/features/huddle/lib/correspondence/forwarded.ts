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
      // 2026-11-16: Apple Mail (and some other clients) put the whole forwarded email inside a <blockquote>, which
      // htmlToText drops as quoted history. Only HERE, and only when nothing else was found, the FIRST blockquote is
      // read as ordinary content; a blockquote nested inside it (the forward's own history) is still dropped.
      const bq = /<blockquote\b/i.exec(raw);
      if (!out && bq) out = afterCut(htmlToText(`${raw.slice(0, bq.index)}<div${raw.slice(bq.index + "<blockquote".length)}`)) ?? "";
    }
  } else {
    out = afterCut(raw) ?? "";
  }
  out = out.trim();
  return out ? out.slice(0, max) : null;
}

// ---------------------------------------------------------------------------------------------------------
// 2026-11-16 (owner: "about 3 of 5 forwarded emails lost the forwarded part when they were stored, so the AI only
// sees the cover note"): the STORED shape of a forward. The ledger's bodyText is htmlToText output (the approved Iris
// text: hidden text ignored, entities decoded, quoted history cut), so an Outlook-marker (divRplyFwdMsg /
// appendonsend) or blockquote forward keeps only the cover note. The forwarded email is now stored NEXT TO it, read
// from the RAW body by forwardedText above. bodyText itself is unchanged.

/** The forwarded email inside a stored "Fw:" message. Header fields are the text its forward header showed (null when
 *  that line was absent); `body` is the forwarded email's own words with its own quoted history cut. */
export interface ForwardedPart {
  from: string | null;
  sent: string | null;
  to: string | null;
  cc: string | null;
  subject: string | null;
  body: string;
}

/** Stored cap for the forwarded body (characters). The judge applies its own, smaller cap when it reads it. */
export const FORWARDED_STORE_MAX = 20_000;

// Header labels as Outlook / Gmail / Apple Mail write them (English plus the locales newTextOnly already cuts at).
const FIELD_LABELS: [keyof Omit<ForwardedPart, "body">, string[]][] = [
  ["from", ["from", "de", "von", "van", "da", "od", "från", "fra", "lähettäjä", "feladó", "от", "kimden"]],
  ["sent", ["sent", "date", "envoyé", "date d'envoi", "enviado", "enviada", "fecha", "data", "gesendet", "datum", "verzonden", "inviato", "wysłano", "skickat", "sendt", "lähetetty", "elküldve", "отправлено", "tarih"]],
  ["to", ["to", "à", "a", "para", "an", "aan", "do", "till", "til", "vastaanottaja", "címzett", "кому", "kime"]],
  ["cc", ["cc", "kopie", "copie", "copia", "kopia", "kopio", "másolat", "копия", "bilgi"]],
  ["subject", ["subject", "objet", "asunto", "assunto", "betreff", "onderwerp", "oggetto", "temat", "ämne", "emne", "aihe", "tárgy", "тема", "konu"]],
];
const HEADER_LINE = /^\s*([\p{L}' ]{1,16}?)\s*:\s?(.*)$/u;
/** Separator lines a client writes ABOVE the forwarded header ("-----Original Message-----", Gmail's
 *  "---------- Forwarded message ---------", Apple's "Begin forwarded message:"). */
const SEPARATOR = /^\s*(?:-{2,}.*-{2,}|_{5,}|begin forwarded message:?|forwarded message:?)\s*$/i;

/**
 * Pure: the forwarded email of a "Fw:" message as its stored shape, or null when the message is not a forward or no
 * forwarded part can be read (forwardedText returns null). Never throws. The header block is the run of
 * "Label: value" lines at the top (separator lines before it skipped); the rest is the body, with the forwarded
 * email's OWN quoted history cut by the rule the live path uses (newTextOnly).
 */
export function forwardedPart(
  subject: string | null | undefined,
  body: string | null | undefined,
  isHtml: boolean,
  max = FORWARDED_STORE_MAX,
): ForwardedPart | null {
  let text: string | null;
  try {
    text = forwardedText(subject, body, isHtml, Number.MAX_SAFE_INTEGER);
  } catch {
    return null;
  }
  if (!text) return null;
  const out: ForwardedPart = { from: null, sent: null, to: null, cc: null, subject: null, body: "" };
  const lines = text.split("\n");
  let i = 0;
  let headers = 0;
  for (; i < lines.length; i++) {
    const l = lines[i];
    if (!l.trim()) {
      if (headers) {
        i++;
        break;
      }
      continue;
    }
    if (!headers && SEPARATOR.test(l)) continue;
    const m = HEADER_LINE.exec(l);
    const label = m ? m[1].trim().toLowerCase() : "";
    const field = m ? FIELD_LABELS.find(([, names]) => names.includes(label)) : undefined;
    if (!m || !field) break;
    headers++;
    if (out[field[0]] === null) out[field[0]] = m[2].trim() || null;
  }
  out.body = newTextOnly(lines.slice(i).join("\n")).replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, max);
  if (!out.body && !headers) return null;
  return out;
}

/** Pure: a stored ForwardedPart rendered as the text a reader sees (header lines, a blank line, the body). */
export function forwardedPartText(f: ForwardedPart, max = 6000): string {
  const head = (
    [
      ["From", f.from],
      ["Sent", f.sent],
      ["To", f.to],
      ["Cc", f.cc],
      ["Subject", f.subject],
    ] as const
  )
    .filter(([, v]) => !!v)
    .map(([k, v]) => `${k}: ${v}`);
  return [head.join("\n"), f.body].filter(Boolean).join("\n\n").slice(0, max);
}
