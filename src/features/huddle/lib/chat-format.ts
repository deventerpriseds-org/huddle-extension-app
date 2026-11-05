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
const HEADING_RE = /^\s{0,3}#{1,6}\s+/;
const QUOTE_RE = /^\s{0,3}>\s?/;

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
  /\*\*([^*\n]+?)\*\*|__([^_\n]+?)__|`([^`\n]+)`|\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<>()]*[^\s<>().,;:!?'"’”*])/g;

export function parseInline(s: string): Inline[] {
  const out: Inline[] = [];
  let last = 0;
  for (const m of s.matchAll(INLINE_RE)) {
    const at = m.index ?? 0;
    if (at > last) out.push({ t: "text", v: s.slice(last, at) });
    if (m[1] != null || m[2] != null) out.push({ t: "bold", v: (m[1] ?? m[2]) as string });
    else if (m[3] != null) out.push({ t: "code", v: m[3] });
    else if (m[4] != null && m[5] != null) out.push({ t: "link", href: m[5], label: m[4] });
    else if (m[6] != null) out.push({ t: "link", href: m[6], label: shortUrlLabel(m[6]) });
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
  | { t: "ol"; items: Inline[][] }
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
        cur = { t: kind, items: [] };
      }
      (cur as { items: Inline[][] }).items.push(parseInline(line.replace(LIST_RE, "")));
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
  if (/^\(fallback: [^)]*\) couldn['’]t reach the model/.test(s)) return s;
  return null;
}

// ---- email drafts ------------------------------------------------------------------------------

const squash = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

/**
 * When the reply card under a message already shows the draft (`replyBody`), drop the copy of that
 * draft from the message text (and its "Suggested reply:" label) so it is shown once, in the card.
 * Only paragraphs that appear in the draft are removed, and only when at least half the draft's
 * paragraphs were found — otherwise the text is returned unchanged (never strip on a weak match).
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
  let hits = 0;
  const kept: string[] = [];
  for (const p of paras) {
    const sq = squash(p.replace(/^suggested reply:\s*/i, ""));
    if (sq && inBody.has(sq)) {
      hits++;
      continue;
    }
    kept.push(p);
  }
  if (hits === 0 || hits * 2 < bodyParas.length) return text;
  return kept
    .filter((p) => !/^suggested reply:?$/i.test(p.trim()))
    .join("\n\n")
    .trim();
}

// ---- code-built blocks (server) ----------------------------------------------------------------

/**
 * Everything the model wrote BEFORE its first list line or its first copy of a section header from
 * `block`. The model is told to write only an opener; this guarantees a list it wrote anyway is not
 * shown twice.
 */
export function openerOnly(text: string, block = ""): string {
  const headers = new Set(
    block
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => /:$/.test(l) && !isListLine(l)),
  );
  const out: string[] = [];
  for (const line of normalizeChatText(text).split("\n")) {
    if (isListLine(line) || headers.has(line.trim())) break;
    out.push(line);
  }
  return out.join("\n").trim();
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

/** A titled list: "Title:\n• a\n• b". Empty items -> "". */
export function bulletSection(title: string, items: string[]): string {
  const xs = items.map((x) => x.trim()).filter(Boolean);
  if (!xs.length) return "";
  return `${title}\n${xs.map((x) => `• ${x}`).join("\n")}`;
}
