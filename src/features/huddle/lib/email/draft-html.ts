// WHAT:       Turns a plain-text reply (what Iris writes / what the owner edits) into the HTML body of an
//             Outlook draft: Calibri 11pt, line breaks kept, blank lines kept as paragraph gaps, and
//             placed ABOVE the quoted original of a threaded reply.
// WHY:        Owner, 2026-10-27: "when I click save draft, the draft it creates is all one block with no
//             new line spacing and the font is random instead of being calibri size 11 font". Root cause:
//             createReply was given the reply as `comment` (plain text). Outlook drops a comment into the
//             HTML body as one unstyled run, so newlines collapse and the font is whatever the client
//             defaults to. The fix writes the body as HTML ourselves.
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   .claude/actions.md ACT:draft-formatting. Tests: bun scripts/draft-html.test.ts
//
// Import-free, so it is unit-testable without the server stack. Only graph-email.server.ts calls Graph.

/** The owner's house style for anything Huddle writes into his mailbox. A DEFAULT, kept in one place. */
export const DRAFT_FONT_STYLE =
  "font-family:Calibri,Arial,Helvetica,sans-serif;font-size:11pt;color:#000000";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Plain text -> an HTML fragment. Every line is its own zero-margin paragraph (Outlook's own MsoNormal
 *  shape), and a blank line becomes an empty `&nbsp;` paragraph, so the spacing he sees in the chat is
 *  exactly the spacing in Outlook. */
export function replyTextToHtml(text: string): string {
  const lines = String(text ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/^\n+|\n+$/g, "")
    .split("\n");
  const paras = lines.map((l) => {
    const t = l.replace(/\s+$/, "");
    return `<p style="margin:0">${t ? escapeHtml(t) : "&nbsp;"}</p>`;
  });
  return `<div style="${DRAFT_FONT_STYLE}">${paras.join("")}</div>`;
}

/** Put the reply at the top of a createReply draft's HTML body (which holds the quoted original),
 *  with one blank line between them. A body with no <body> tag gets the reply prepended. */
export function insertReplyIntoBody(
  existingHtml: string | null | undefined,
  replyHtml: string,
): string {
  const gap = `<div style="${DRAFT_FONT_STYLE}"><p style="margin:0">&nbsp;</p></div>`;
  const html = String(existingHtml ?? "");
  const open = /<body[^>]*>/i.exec(html);
  if (!open) return `${replyHtml}${gap}${html}`;
  const at = open.index + open[0].length;
  return `${html.slice(0, at)}${replyHtml}${gap}${html.slice(at)}`;
}
