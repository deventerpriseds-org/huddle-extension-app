// WHAT:       Pure: the part of an HTML email body a reader can SEE, re-serialised as minimal HTML (tag names, the
//             `id` attribute, escaped text) for htmlToText's existing text pipeline (onedrive-feed.ts).
// WHY:        The hand-written tag scanner it replaces (stripHiddenElements + elementEnd + attrsOf) had to re-derive
//             the browser's tree-building rules one shape at a time, and every independent verifier pass found new
//             shapes where it dropped a VISIBLE ask: loop 3 (V-series), loop 4 (W1-W4, W7), loop 5 (F1-F3: a hidden
//             unclosed <b>/<strong>/<font>/<a> inside <p>/<li> with the ask in a table cell; 23 of 44 new Chromium-
//             recorded rows). parse5 implements the WHATWG tree construction Chromium uses (implied end tags,
//             formatting-element reconstruction, foster parenting, comment end states, quoted attributes), so the
//             element a style applies to is the element the browser built -- the whole class of shape bugs goes away.
// SUPERSEDES: stripHiddenElements / elementEnd / keepResizedDescendants / attrsOf / lengthAfter*Tag and the
//             comment / <head> / <script> regexes in onedrive-feed.ts (removed in the same commit).
// SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   scripts/onedrive-feed-truth.test.ts against scripts/fixtures/html-visible-text-truth.json (real Chromium);
//             verifier loop 5 report docs/qc-evidence/VERIFY-correspondence-proposals-5.md (branch
//             claude_verify-correspondence-proposals-5).
//
// Visibility rules (inline style only -- email bodies carry no external sheets this converter could apply):
//  - removed with everything inside: `display:none`, `opacity:0`, `max-height:0` WITH `overflow(-y):hidden|clip`,
//    the `hidden` attribute (unless an inline `display` other than none overrides it, as in a browser);
//  - never text: comments, <head>, <script>, <style>, <template>, <noscript>, <title>;
//  - `visibility:hidden|collapse` hides text but is INHERITED, so a descendant's `visibility:visible` shows again;
//  - `font-size:0` hides text but is INHERITED, so a descendant giving a real size shows again (keep-more: so does a
//    descendant with a class, which a <style> rule may re-size, and a <font size>);
//  - `mso-hide:all` is NOT hiding: it applies only in Outlook desktop, whose own copy sits in an `<!--[if mso]>`
//    comment that is dropped, so each piece of text survives exactly once (verifier loop 4, W4).
//  Parsed in STANDARDS mode (as a webmail page embeds the message), whatever doctype the email carries.
//  CSS declarations are parsed the way a browser does: comments removed, the LAST declaration of a property wins,
//  `!important` beats a later normal one, and an invalid value (e.g. `display:nonex`) is ignored.
import { parse } from "parse5";

type Node = {
  nodeName: string;
  /** With `sourceCodeLocationInfo`: where the element's start / end tag sat in the SOURCE (absent = implied). */
  sourceCodeLocation?: { startTag?: unknown; endTag?: unknown } | null;
  tagName?: string;
  value?: string;
  attrs?: { name: string; value: string }[];
  childNodes?: Node[];
  content?: Node;
};

const NEVER_TEXT = new Set(["head", "script", "style", "template", "noscript", "title", "#comment", "#documentType"]);

/** Pure: split a declaration list on `;` the way CSS does -- never inside a quoted string or parentheses
 *  (verifier loop 6: `content:"a;b"` must not cut the declaration after it in two). */
function splitDeclarations(style: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  let depth = 0;
  for (let i = 0; i < style.length; i++) {
    const c = style[i];
    if (quote) {
      if (c === "\\" && i + 1 < style.length) {
        cur += c + style[++i];
        continue;
      }
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "(") depth++;
    else if (c === ")" && depth > 0) depth--;
    else if (c === ";" && depth === 0) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out;
}

/** Pure: the inline style's declarations, browser rules: last wins, !important wins, comments ignored. */
export function styleDeclarations(style: string): Map<string, string> {
  const out = new Map<string, { v: string; imp: boolean }>();
  for (const decl of splitDeclarations(style.replace(/\/\*[\s\S]*?(?:\*\/|$)/g, " "))) {
    const i = decl.indexOf(":");
    if (i < 0) continue;
    const prop = decl.slice(0, i).trim().toLowerCase();
    let v = decl.slice(i + 1).trim().toLowerCase();
    if (!prop || !v) continue;
    const imp = /!\s*important\s*$/.test(v);
    if (imp) v = v.replace(/!\s*important\s*$/, "").trim();
    const prev = out.get(prop);
    if (prev && prev.imp && !imp) continue;
    out.set(prop, { v, imp });
  }
  return new Map([...out].map(([k, d]) => [k, d.v]));
}

const LENGTH = /^(-?\d*\.?\d+)(px|pt|em|rem|%|ex|ch|vw|vh|cm|mm|in|pc|q)?$/;
const DISPLAY_VALUES = /^(none|block|inline|inline-block|flex|inline-flex|grid|inline-grid|table|inline-table|table-row|table-cell|table-row-group|table-header-group|table-footer-group|table-column|table-column-group|table-caption|list-item|contents|flow-root|run-in|initial|inherit|unset|revert)$/;
const zeroLength = (v: string): boolean | null => {
  const m = LENGTH.exec(v);
  if (!m) return null;
  if (m[2] === undefined && Number(m[1]) !== 0) return null; // a bare non-zero number is not a length
  return Number(m[1]) === 0;
};
const FONT_KEYWORDS = /^(xx-small|x-small|small|medium|large|x-large|xx-large|xxx-large|larger|smaller|initial)$/;

type Inherited = { visHidden: boolean; fontZero: boolean };

/** Pure: how one element changes what is visible. `drop` removes it and everything inside. */
function elementVisibility(name: string, attrs: Map<string, string>, parent: Inherited): { drop: boolean; state: Inherited } {
  const d = styleDeclarations(attrs.get("style") ?? "");
  const display = d.get("display");
  const displayValid = display !== undefined && DISPLAY_VALUES.test(display);
  if (displayValid && display === "none") return { drop: true, state: parent };
  if (attrs.has("hidden") && !(displayValid && display !== "none")) return { drop: true, state: parent };
  const opacity = d.get("opacity");
  if (opacity !== undefined) {
    const m = /^(\d*\.?\d+)(%)?$/.exec(opacity);
    if (m && Number(m[1]) === 0) return { drop: true, state: parent };
  }
  const maxH = d.get("max-height");
  const overflow = d.get("overflow-y") ?? d.get("overflow");
  if (maxH !== undefined && zeroLength(maxH) === true && overflow !== undefined && /^(hidden|clip)(\s|$)/.test(overflow)) {
    return { drop: true, state: parent };
  }
  const state = { ...parent };
  const vis = d.get("visibility");
  if (vis === "hidden" || vis === "collapse") state.visHidden = true;
  else if (vis === "visible") state.visHidden = false;
  const fs = d.get("font-size");
  if (fs !== undefined) {
    const z = zeroLength(fs);
    if (z !== null) state.fontZero = z;
    else if (FONT_KEYWORDS.test(fs)) state.fontZero = false;
  }
  const font = d.get("font");
  if (font !== undefined) {
    for (const tok of font.split(/\s+/)) {
      const z = zeroLength(tok.split("/")[0]);
      if (z !== null) {
        state.fontZero = z;
        break;
      }
    }
  }
  // Keep-more: inside a font-size:0 wrapper an element with a class may be re-sized by a <style> rule this
  // converter cannot apply, and <font size> sets a real size -- both show their text (verifier loop 3, D1-V5/V6).
  if (state.fontZero && (/\S/.test(attrs.get("class") ?? "") || (name === "font" && attrs.has("size")))) state.fontZero = false;
  return { drop: false, state };
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const VOID = new Set(["br", "hr", "img", "input", "meta", "link", "area", "base", "col", "embed", "source", "track", "wbr", "param"]);

/**
 * Pure: `html` reduced to what a browser shows -- minimal HTML: each kept element as `<name>` (plus its `id`, which
 * htmlToText uses to cut Outlook's reply header) and its visible text, escaped. Never throws (parse5 never throws on
 * malformed input; a pathological input falls back to the empty string).
 */
export function visibleHtml(html: string): string {
  let doc: Node;
  try {
    // Standards mode, always: a webmail reader (Outlook on the web, Gmail) shows a message INSIDE a standards-mode
    // page, so the email's own missing or legacy doctype never puts it in quirks mode (where <table> would not close
    // an open <p>). A second doctype is ignored by the parser, so prefixing one is safe either way.
    doc = parse(`<!doctype html>${html}`, { sourceCodeLocationInfo: true }) as unknown as Node;
  } catch {
    return "";
  }
  const out: string[] = [];
  // Past this depth the walk stops recursing (a pathological nesting must never overflow the stack) and keeps the
  // subtree's TEXT instead -- keep-more, never drop (verifier loop 6: 405 nested <div>s lost their text).
  const MAX_DEPTH = 400;
  const flatText = (root: Node) => {
    const stack: Node[] = [root];
    while (stack.length) {
      const n = stack.pop()!;
      if (n.nodeName === "#text") out.push(esc(n.value ?? ""));
      else if (!NEVER_TEXT.has(n.nodeName)) {
        const kids = n.childNodes ?? [];
        for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
        if (n.tagName && /^(p|div|li|tr|h\d|br)$/i.test(n.tagName)) out.push(" ");
      }
    }
  };
  const walk = (n: Node, st: Inherited, depth: number) => {
    if (depth > MAX_DEPTH) {
      if (!st.visHidden && !st.fontZero) flatText(n);
      return;
    }
    if (n.nodeName === "#text") {
      if (!st.visHidden && !st.fontZero) out.push(esc(n.value ?? ""));
      return;
    }
    if (NEVER_TEXT.has(n.nodeName)) return;
    if (!n.tagName) {
      for (const c of n.childNodes ?? []) walk(c, st, depth + 1); // #document, #document-fragment
      return;
    }
    const attrs = new Map((n.attrs ?? []).map((a) => [a.name.toLowerCase(), a.value]));
    const v = elementVisibility(n.tagName.toLowerCase(), attrs, st);
    if (v.drop) {
      out.push(" ");
      return;
    }
    const name = n.tagName.toLowerCase();
    const id = attrs.get("id");
    // Only tags the SOURCE wrote are re-emitted: an element the parser implied (a closed-by-omission </p>, an
    // inserted <tbody>, a reconstructed <b>) adds no tag, so htmlToText's line breaks match main's on malformed mail
    // (verifier loop 6: implied </p> breaks let main's English "On ... wrote:" cut fire on bodies main keeps whole).
    const loc = n.sourceCodeLocation;
    if (loc?.startTag) out.push(`<${name}${id ? ` id="${esc(id).replace(/"/g, "&quot;")}"` : ""}>`);
    if (VOID.has(name)) return;
    for (const c of n.childNodes ?? []) walk(c, v.state, depth + 1);
    if (loc?.endTag) out.push(`</${name}>`);
  };
  walk(doc, { visHidden: false, fontZero: false }, 0);
  return out.join("");
}
