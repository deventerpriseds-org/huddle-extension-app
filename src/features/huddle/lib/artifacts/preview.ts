// WHAT:       Pure logic for the artifact preview pane: picks a RENDERER from an artifact's
//             mime/extension/content, and builds the sandboxed-iframe `srcdoc` that renders
//             mermaid diagrams, HTML/D3 pages and SVG safely.
// WHY:        The viewer previewed plain text only, so an agent that saved a mermaid diagram, a D3
//             visualisation or an HTML document showed the user raw SOURCE. Full documents, mermaid
//             and d3 were early requirements.
//             Artifact content is MODEL-AUTHORED and therefore UNTRUSTED — it can echo anything the
//             agent read (a web page, an email, task text). So it is NEVER injected into the app's
//             own document (no `dangerouslySetInnerHTML`, no parent-document <script>). It is handed
//             to an iframe `srcdoc` with `sandbox="allow-scripts"` and deliberately WITHOUT
//             `allow-same-origin`: that pair gives the frame an OPAQUE origin, so scripts run (D3
//             and mermaid work) but cannot reach the app's DOM, cookies, localStorage, or make
//             same-origin fetches. Adding `allow-same-origin` next to `allow-scripts` would disable
//             the sandbox entirely — hence SANDBOX_* below are constants, asserted by the tests.
// SUPERSEDES: nothing
// SUPERSEDED-BY: nothing -- current
// EVIDENCE:   scripts/artifact-preview.test.ts (npm run test:artifact-preview)

/** Which renderer the preview pane should use for an artifact. */
export type PreviewKind =
  | "image" // <img src={sas}>            — already supported, unchanged
  | "pdf" //   <iframe src={sas}>         — already supported, unchanged
  | "svg" //   sandboxed iframe, scripts DISABLED
  | "html" //  sandboxed iframe, scripts enabled (D3 etc.)
  | "mermaid" // sandboxed iframe, scripts enabled (mermaid renders client-side)
  | "markdown" // plain-text <pre> (today's behaviour — do not regress)
  | "text" //  plain-text <pre> (today's behaviour for anything else with text)
  | "none"; //  no preview available

/**
 * Sandbox attribute for frames that must RUN script (html / mermaid / d3).
 * `allow-scripts` WITHOUT `allow-same-origin` = opaque origin. Never add `allow-same-origin`.
 */
export const SANDBOX_SCRIPTS = "allow-scripts";
/** Sandbox attribute for frames that only need to DISPLAY markup (svg). Maximum restriction. */
export const SANDBOX_NONE = "";

/** Pinned, exact CDN versions loaded INSIDE the sandboxed frame (never into the app document). */
export const MERMAID_CDN = "https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.min.js";
export const D3_CDN = "https://cdn.jsdelivr.net/npm/d3@7.9.0/dist/d3.min.js";

/** A ```mermaid fence inside a markdown (or any text) artifact. */
const MERMAID_FENCE_RE = /(^|\n)[ \t]*```[ \t]*mermaid[ \t]*(\r?\n)/i;
const MERMAID_FENCE_G = /(^|\n)[ \t]*```[ \t]*mermaid[ \t]*\r?\n([\s\S]*?)(?:\r?\n[ \t]*```|$)/gi;

function ext(name: string): string {
  const i = name.lastIndexOf(".");
  return i < 0 ? "" : name.slice(i + 1).toLowerCase();
}

/** True when the text carries at least one ```mermaid fenced block. */
export function hasMermaidFence(text: string | null | undefined): boolean {
  return !!text && MERMAID_FENCE_RE.test(text);
}

/**
 * Every ```mermaid block's source, in order. When the artifact IS a diagram (no fences at all) the
 * whole body is the single block.
 */
export function extractMermaidBlocks(text: string): string[] {
  const out: string[] = [];
  MERMAID_FENCE_G.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MERMAID_FENCE_G.exec(text))) {
    const body = (m[2] ?? "").trim();
    if (body) out.push(body);
  }
  return out.length ? out : [text.trim()].filter(Boolean);
}

/** Everything OUTSIDE the mermaid fences — the surrounding prose of a markdown artifact. */
export function stripMermaidBlocks(text: string): string {
  return text.replace(MERMAID_FENCE_G, "\n").trim();
}

/**
 * Choose the renderer. `text` is the server-side preview body (null when the server did not return
 * one — see TEXT_PREVIEW_MIME in artifacts.server.ts), `url` the SAS link.
 */
export function detectPreviewKind(a: {
  name: string;
  mime: string;
  text?: string | null;
  url?: string | null;
}): PreviewKind {
  const mime = (a.mime || "").toLowerCase();
  const e = ext(a.name || "");
  const text = a.text ?? null;

  // SVG first — it is an image/* mime but must render as markup, inside the sandbox (an SVG can
  // carry <script> and event handlers of its own).
  if (mime === "image/svg+xml" || e === "svg") return text != null ? "svg" : a.url ? "image" : "none";
  if (mime.startsWith("image/")) return a.url ? "image" : "none";
  if (mime.includes("pdf") || e === "pdf") return a.url ? "pdf" : "none";

  if (text == null) return "none";

  if (mime === "text/html" || mime === "application/xhtml+xml" || e === "html" || e === "htm")
    return "html";

  if (
    mime === "text/vnd.mermaid" ||
    mime === "application/vnd.mermaid" ||
    mime === "text/x-mermaid" ||
    e === "mmd" ||
    e === "mermaid"
  )
    return "mermaid";

  const isMarkdown = mime === "text/markdown" || mime === "text/x-markdown" || e === "md" || e === "markdown";
  // A markdown artifact that CONTAINS a diagram renders the diagram; plain markdown keeps today's
  // plain-text preview exactly as it was.
  if (hasMermaidFence(text)) return "mermaid";
  if (isMarkdown) return "markdown";

  return "text";
}

/** True when this kind is drawn inside the sandboxed iframe rather than a <pre>. */
export function rendersInIframe(kind: PreviewKind): boolean {
  return kind === "html" || kind === "mermaid" || kind === "svg";
}

/** The exact sandbox attribute for a kind. Never contains `allow-same-origin`. */
export function sandboxFor(kind: PreviewKind): string {
  return kind === "svg" ? SANDBOX_NONE : SANDBOX_SCRIPTS;
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const BASE_STYLE = `<style>
  :root { color-scheme: light dark; }
  html, body { margin: 0; }
  body { padding: 10px; font: 13px/1.55 ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif; }
  img, svg, canvas { max-width: 100%; height: auto; }
  pre { white-space: pre-wrap; word-break: break-word; font-size: 12px; }
  .mermaid { text-align: center; }
</style>`;

/** Put our scaffolding into a FULL document's head, or wrap a fragment in one. */
function intoDocument(html: string, headExtras: string): string {
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head([^>]*)>/i, `<head$1>${headExtras}`);
  if (/<html[^>]*>/i.test(html)) return html.replace(/<html([^>]*)>/i, `<html$1><head>${headExtras}</head>`);
  return `<!doctype html><html><head><meta charset="utf-8">${headExtras}</head><body>${html}</body></html>`;
}

/**
 * Build the `srcdoc` for a sandboxed preview frame.
 *
 * The artifact body goes in VERBATIM — a `<script>` inside it executes in the frame's OPAQUE
 * origin, which is the whole point of the sandbox and is why nothing here is ever handed to
 * `dangerouslySetInnerHTML`. Mermaid diagram sources are HTML-escaped so the diagram text cannot
 * terminate the element that holds it.
 */
export function buildSrcDoc(kind: PreviewKind, content: string): string {
  if (kind === "svg") {
    // Scripts are OFF for this frame (sandboxFor -> ""), so no library and no CDN tag.
    return intoDocument(content, `${BASE_STYLE}`);
  }
  if (kind === "mermaid") {
    const blocks = extractMermaidBlocks(content);
    const prose = hasMermaidFence(content) ? stripMermaidBlocks(content) : "";
    const body =
      blocks.map((b) => `<pre class="mermaid">${escapeHtml(b)}</pre>`).join("\n") +
      (prose ? `\n<pre class="md">${escapeHtml(prose)}</pre>` : "");
    const head =
      `${BASE_STYLE}<script src="${MERMAID_CDN}"></script>` +
      `<script>window.addEventListener('load',function(){try{mermaid.initialize({startOnLoad:true,securityLevel:'strict'});}catch(e){document.body.insertAdjacentHTML('afterbegin','<pre>Diagram engine unavailable (offline or blocked).</pre>');}});</script>`;
    return `<!doctype html><html><head><meta charset="utf-8">${head}</head><body>${body}</body></html>`;
  }
  // html (incl. D3): d3 is provided so a visualisation that assumes it is present still draws; a
  // document bringing its own copy simply overwrites the global.
  return intoDocument(content, `${BASE_STYLE}<script src="${D3_CDN}"></script>`);
}
