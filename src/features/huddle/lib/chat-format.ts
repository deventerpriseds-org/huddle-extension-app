// WHAT:       The ONE set of chat-layout rules: tidy an agent message's whitespace, parse it into blocks
//             (paragraphs, bullet/numbered lists, headings, quotes) with inline bold/code/links, spot
//             system notices, and join a model-written opener onto a code-built block.
// WHY:        Owner, 2026-11-05: "the chat stream is raw text ... some texts use proper spacing bullets and
//             indentation and other messages insert line breaks between every line". Measured on Iris's
//             29 messages of 11-03..11-05: the SAME 8am brief came out with one bullet per line on one day
//             and a blank line between every bullet (22-24 line breaks) on the next; `**Up next**` showed
//             literally; four phrasings of "N more". Cause: the chat rendered `{m.text}` in
//             whitespace-pre-wrap with NO formatting, so whatever spacing the model chose was shown as-is.
// SUPERSEDES: nothing (HuddleView rendered the raw string).
// SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   azure-pg-query run 42105101844 (Iris replies, last 48h); scripts/chat-format.test.ts.
//
// PURE: no React, no IO. Imported by the chat renderer (components/ChatText.tsx) AND by the server's
// turn runner (joinOpenerAndBlock), so the client and the server agree on what a list line is.

/** A list marker at the start of a line: "• ", "- ", "* ", "· ", "1. ", "1) ". "**bold" is NOT one. */
const LIST_RE = /^\s*(?:[•·\-*]|\d{1,3}[.)])\s+/;
const ORDERED_RE = /^\s*\d{1,3}[.)]\s+/;
// A heading needs a capital or digit after it, so "# of tasks: 5" stays text.
const HEADING_RE = /^\s{0,3}#{1,6}\s+(?=[A-Z0-9])/;
// A quote needs "> " (with the space), so ">50% done" stays text.
const QUOTE_RE = /^\s{0,3}>\s/;

/** The number an ordered-list line starts with ("0. x" -> 0, "12) x" -> 12). */
function listNumber(line: string): number {
  const n = parseInt(line.trim(), 10);
  return Number.isNaN(n) ? 1 : n;
}

export function isListLine(line: string): boolean {
  return LIST_RE.test(line);
}

/**
 * Tidy the whitespace an agent produced, WITHOUT changing a word of it:
 *  - CRLF -> LF; trailing spaces dropped (that also removes Markdown "two-space" hard breaks, which
 *    showed up as `Best,  \nVon` in email drafts)
 *  - a blank line BETWEEN two list items is removed (the "line break between every line" complaint)
 *  - runs of blank lines collapse to one; leading/trailing blank lines go
 *  - a greeting paragraph ending in "," followed by a paragraph that starts lower-case is re-joined
 *    ("Hello Sir,\n\njust a reminder" -> "Hello Sir, just a reminder")
 */
export function normalizeChatText(raw: string): string {
  const lines = String(raw ?? "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => l.replace(/[ \t\u00a0]+$/, ""));
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() !== "") {
      out.push(l);
      continue;
    }
    let j = i + 1;
    while (j < lines.length && lines[j].trim() === "") j++;
    const prev = out.length ? out[out.length - 1] : "";
    const next = j < lines.length ? lines[j] : "";
    i = j - 1; // the whole blank run is handled here
    if (!out.length || j >= lines.length) continue; // leading / trailing
    if (isListLine(prev) && isListLine(next)) continue; // blank line inside a list
    if (/:$/.test(prev.trim()) && isListLine(next)) continue; // "Later this week:" hugs its first item
    if (
      /,$/.test(prev.trim()) &&
      !prev.includes("\n") &&
      isGreeting(prev) &&
      /^[a-z]/.test(next.trim())
    ) {
      out[out.length - 1] = `${prev.trimEnd()} ${next.trim()}`;
      i = j; // the next line has been folded into the greeting
      continue;
    }
    out.push("");
  }
  return out.join("\n");
}

function isGreeting(line: string): boolean {
  return /^(hello|hi|hey|good (morning|afternoon|evening))\b[^.!?]{0,30},$/i.test(line.trim());
}

// ---- inline ------------------------------------------------------------------------------------

export type Inline =
  | { t: "text"; v: string }
  | { t: "bold"; v: string }
  | { t: "code"; v: string }
  | { t: "link"; href: string; label: string };

/** Only http(s) ever becomes a link. Trailing sentence punctuation stays outside the URL. */
const INLINE_RE =
  /\*\*([^*\n]+?)\*\*|`([^`\n]+)`|\[([^\]\n]+)\]\((https?:\/\/(?:[^\s()]|\([^\s()]*\))+)\)|(https?:\/\/(?:[^\s<>()]|\([^\s<>()]*\))*(?:[^\s<>().,;:!?'"’”*]|\([^\s<>()]*\)))/g;

export function parseInline(s: string): Inline[] {
  const out: Inline[] = [];
  let last = 0;
  for (const m of s.matchAll(INLINE_RE)) {
    const at = m.index ?? 0;
    if (at > last) out.push({ t: "text", v: s.slice(last, at) });
    // "__x__" is deliberately NOT bold: it ate the underscores of names like __init__.
    if (m[1] != null) out.push({ t: "bold", v: m[1] });
    else if (m[2] != null) out.push({ t: "code", v: m[2] });
    else if (m[3] != null && m[4] != null) out.push({ t: "link", href: m[4], label: m[3] });
    else if (m[5] != null) out.push({ t: "link", href: m[5], label: shortUrlLabel(m[5]) });
    last = at + m[0].length;
  }
  if (last < s.length) out.push({ t: "text", v: s.slice(last) });
  return out;
}

/** "https://zoom.us/j/9164221159?pwd=abc" -> "zoom.us/j/9164221159". Query strings never shown. */
export function shortUrlLabel(href: string, max = 40): string {
  try {
    const u = new URL(href);
    const s = `${u.host.replace(/^www\./, "")}${u.pathname === "/" ? "" : u.pathname}`;
    return s.length > max ? `${s.slice(0, max - 1)}…` : s;
  } catch {
    return href.length > max ? `${href.slice(0, max - 1)}…` : href;
  }
}

// ---- blocks ------------------------------------------------------------------------------------

export type Block =
  | { t: "p"; lines: Inline[][] }
  | { t: "ul"; items: Inline[][] }
  | { t: "ol"; items: Inline[][]; start: number; nums: number[] }
  | { t: "h"; v: Inline[] }
  | { t: "quote"; lines: Inline[][] };

/** Normalize, then split into blocks. A blank line always ends a block. */
export function parseChatBlocks(raw: string): Block[] {
  const lines = normalizeChatText(raw).split("\n");
  const blocks: Block[] = [];
  let cur: Block | null = null;
  const flush = () => {
    if (cur) blocks.push(cur);
    cur = null;
  };
  for (const line of lines) {
    if (line.trim() === "") {
      flush();
      continue;
    }
    if (HEADING_RE.test(line)) {
      flush();
      blocks.push({ t: "h", v: parseInline(line.replace(HEADING_RE, "").replace(/\s#+\s*$/, "")) });
      continue;
    }
    if (LIST_RE.test(line)) {
      const kind = ORDERED_RE.test(line) ? "ol" : "ul";
      if (!cur || cur.t !== kind) {
        flush();
        // An ordered list keeps the number the agent wrote ("3. third" after a note stays 3).
        cur =
          kind === "ol"
            ? { t: "ol", items: [], start: listNumber(line), nums: [] }
            : { t: "ul", items: [] };
      }
      (cur as { items: Inline[][] }).items.push(parseInline(line.replace(LIST_RE, "")));
      // Every item keeps the number the agent wrote (a countdown 3, 2, 1 must not become 3, 4, 5).
      if (cur.t === "ol") cur.nums.push(listNumber(line));
      continue;
    }
    if (QUOTE_RE.test(line)) {
      if (!cur || cur.t !== "quote") {
        flush();
        cur = { t: "quote", lines: [] };
      }
      (cur as { lines: Inline[][] }).lines.push(parseInline(line.replace(QUOTE_RE, "")));
      continue;
    }
    // An indented line straight after a list item continues that item.
    if (cur && (cur.t === "ul" || cur.t === "ol") && /^\s{2,}\S/.test(line)) {
      const items = cur.items;
      items[items.length - 1] = [
        ...items[items.length - 1],
        { t: "text", v: " " },
        ...parseInline(line.trim()),
      ];
      continue;
    }
    if (!cur || cur.t !== "p") {
      flush();
      cur = { t: "p", lines: [] };
    }
    cur.lines.push(parseInline(line));
  }
  flush();
  return blocks;
}

// ---- notices -----------------------------------------------------------------------------------

/**
 * A reply the runtime wrote because the model could NOT answer (huddle.functions.ts hardReply:
 * `(couldn't respond — …)` on a quota outage, `(fallback: …) couldn't reach the model — …` otherwise).
 * Returns the text to show as a system notice, or null for a real agent reply.
 */
export function noticeText(text: string): string | null {
  const s = String(text ?? "").trim();
  if (/^\(couldn['’]t respond — /.test(s)) {
    const inner = s.endsWith(")") ? s.slice(1, -1) : s.slice(1);
    return inner.charAt(0).toUpperCase() + inner.slice(1);
  }
  // Every runtime "(fallback: …) …" reply. The inline part can itself contain ")" (an error message
  // like "gpt-4o (TPM): Limit"), so only the opening "(fallback: " is matched.
  if (/^\(fallback: /.test(s)) return s;
  return null;
}

// ---- email drafts ------------------------------------------------------------------------------

const squash = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

/**
 * When the reply card under a message already shows the draft (`replyBody`), drop the copy of that
 * draft from the message text (and its "Suggested reply:" label) so it is shown once, in the card.
 * Only paragraphs that appear in the draft are removed, and only when EVERY paragraph of the draft was
 * found — otherwise the text is returned unchanged (never strip on a partial match).
 */
export function stripRepeatedDraft(text: string, replyBody: string | undefined | null): string {
  if (!replyBody || !replyBody.trim()) return text;
  const bodyParas = normalizeChatText(replyBody)
    .split(/\n\s*\n/)
    .map(squash)
    .filter(Boolean);
  if (!bodyParas.length) return text;
  const inBody = new Set(bodyParas);
  const paras = normalizeChatText(text).split(/\n\s*\n/);
  // DISTINCT draft paragraphs found — a generic one ("Hi Sam,") repeated in the prose counts once.
  const found = new Set<string>();
  const kept: string[] = [];
  for (const p of paras) {
    const sq = squash(p.replace(SUGGESTED_LABEL_PREFIX, ""));
    if (sq && inBody.has(sq)) {
      found.add(sq);
      continue;
    }
    kept.push(p);
  }
  // STRONG match only: EVERY distinct paragraph of the draft must be in the prose. A partial match
  // (say just "Hi Sam," and "Best, Von" around a paraphrased middle) is left alone, never half-stripped.
  if (found.size < inBody.size) return text;
  return kept
    .filter((p) => !SUGGESTED_LABEL_ONLY.test(p.trim()))
    .join("\n\n")
    .trim();
}

/** "Suggested reply:" / "**Suggested reply:**" / "Suggested reply" as a label. */
const SUGGESTED_LABEL_PREFIX = /^\**\s*suggested reply:?\s*\**:?\s*/i;
const SUGGESTED_LABEL_ONLY = /^\**\s*suggested reply:?\s*\**:?$/i;

// ---- code-built blocks (server) ----------------------------------------------------------------

/**
 * Everything the model wrote BEFORE its first list line or its first copy of a section header from
 * `block`. The model is told to write only an opener; this guarantees a list it wrote anyway is not
 * shown twice.
 */
export function openerOnly(text: string, block = ""): string {
  const blockLines = block
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !isListLine(l));
  // Section headers, compared without bold / "#" / the colon / case, so "**Meetings and classes**:",
  // "### Meetings and classes:" and "Meetings and classes" all match "Meetings and classes:".
  const headers = new Set(blockLines.filter((l) => /:$/.test(l)).map(headerKey));
  // Any other block line (the closing question) — a model copy of it is cut too.
  const others = blockLines.filter((l) => !/:$/.test(l)).map((l) => headerKey(l).slice(0, 30));
  const out: string[] = [];
  for (const line of normalizeChatText(text).split("\n")) {
    const k = headerKey(line);
    if (
      isListLine(line) ||
      headers.has(k) ||
      (k.length >= 20 && others.some((o) => o && k.startsWith(o)))
    )
      break;
    out.push(line);
  }
  return out.join("\n").trim();
}

function headerKey(line: string): string {
  return line
    .trim()
    .replace(/^#{1,6}\s+/, "")
    .replace(/\*\*|__/g, "")
    .replace(/:\s*$/, "")
    .trim()
    .toLowerCase();
}

/** The model's opener, a blank line, then the code-built block. Falls back to "Hello Sir," when the
 *  model wrote nothing usable (empty, or a runtime failure notice). */
export function joinOpenerAndBlock(text: string, block: string): string {
  const b = block.trim();
  const opener = noticeText(text) ? "" : openerOnly(text, b);
  return `${opener || "Hello Sir,"}\n\n${b}`;
}

/** "7:00PM" / "7:00 PM" -> "7:00 PM" (one spacing everywhere a code-built list shows a time). */
export function spacedClock(s: string): string {
  return s.replace(
    /(\d)[\s\u202f]?(AM|PM)\b/gi,
    (_m, d: string, p: string) => `${d} ${p.toUpperCase()}`,
  );
}

/**
 * A titled list: "Title:\n• a\n• b". Empty items -> "". With `max`, only the first `max` items are
 * listed and a plain "…and N more" line follows (plus `moreNote`), so a code-built block can never
 * grow past the turn's size cap on a very busy week.
 */
export function bulletSection(
  title: string,
  items: string[],
  max = Infinity,
  moreNote = "",
): string {
  const xs = items.map((x) => x.trim()).filter(Boolean);
  if (!xs.length) return "";
  const shown = xs.slice(0, max);
  const rest = xs.length - shown.length;
  return (
    `${title}\n${shown.map((x) => `• ${x}`).join("\n")}` +
    (rest > 0 ? `\n…and ${rest} more${moreNote ? ` ${moreNote}` : ""}` : "")
  );
}
