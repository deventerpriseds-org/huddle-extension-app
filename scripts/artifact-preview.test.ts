// WHAT:       Proves the artifact preview picks the right RENDERER per mime/extension/content, and
//             that every markup-shaped artifact reaches the screen through a SANDBOXED iframe whose
//             sandbox is never widened with `allow-same-origin`.
// WHY:        The viewer previewed plain text only (artifacts.server.ts TEXT_PREVIEW_MIME + a <pre>
//             in ArtifactsView.tsx), so a mermaid diagram, a D3 page or an HTML document — all of
//             which the store already accepts — showed the user raw SOURCE. Making them RENDER
//             means executing MODEL-AUTHORED content, which is untrusted (it can echo any web page,
//             email or task text the agent read). The dangerous mistakes are one keyword each:
//             `dangerouslySetInnerHTML` (runs in the app's own document) and `allow-same-origin`
//             next to `allow-scripts` (a sandbox that sandboxes nothing). Both are asserted against
//             the real component SOURCE below, not just against the helper's return value.
// SUPERSEDES: nothing
// SUPERSEDED-BY: nothing -- current
// EVIDENCE:   src/features/huddle/lib/artifacts/preview.ts; the rendering branch in
//             src/features/huddle/components/ArtifactsView.tsx (ArtifactPreview).
//
// Run:  bun scripts/artifact-preview.test.ts   (npm run test:artifact-preview)

import { readFileSync } from "node:fs";
import {
  detectPreviewKind,
  buildSrcDoc,
  sandboxFor,
  rendersInIframe,
  hasMermaidFence,
  extractMermaidBlocks,
  SANDBOX_SCRIPTS,
  SANDBOX_NONE,
  MERMAID_CDN,
  D3_CDN,
} from "../src/features/huddle/lib/artifacts/preview";

let pass = 0,
  fail = 0;
function check(label: string, cond: boolean, detail: string) {
  console.log(`  ${cond ? "PASS" : "FAIL"} ${label} — ${detail}`);
  cond ? pass++ : fail++;
}

const VIEW_SRC = readFileSync(
  new URL("../src/features/huddle/components/ArtifactsView.tsx", import.meta.url),
  "utf8",
);
const PREVIEW_SRC = readFileSync(
  new URL("../src/features/huddle/lib/artifacts/preview.ts", import.meta.url),
  "utf8",
);
// Both files MENTION the dangerous APIs in prose — that is the point of the warnings written there.
// The guard is that no line of EXECUTABLE code contains them, so comment lines are dropped first.
const codeOnly = (src: string) =>
  src
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join("\n");
const VIEW_CODE = codeOnly(VIEW_SRC);
const PREVIEW_CODE = codeOnly(PREVIEW_SRC);

// ── 1. mime / extension → renderer ──────────────────────────────────────────────────────────────
{
  const k = (name: string, mime: string, text: string | null = "body", url: string | null = "https://sas") =>
    detectPreviewKind({ name, mime, text, url });

  check(
    "markdown keeps today's plain-text preview (no regression)",
    k("gtm-notes.md", "text/markdown") === "markdown" && k("notes.md", "application/octet-stream") === "markdown",
    `text/markdown -> ${k("gtm-notes.md", "text/markdown")}, .md by extension -> ${k("notes.md", "application/octet-stream")}`,
  );

  check(
    "mermaid is detected by extension AND by mime",
    k("flow.mmd", "text/plain") === "mermaid" &&
      k("flow", "text/vnd.mermaid") === "mermaid" &&
      k("flow.mermaid", "application/octet-stream") === "mermaid",
    `.mmd -> ${k("flow.mmd", "text/plain")}, text/vnd.mermaid -> ${k("flow", "text/vnd.mermaid")}`,
  );

  const mdWithFence = "# Plan\n\nHere is the flow:\n\n```mermaid\ngraph TD;\n  A-->B;\n```\n\nThat's it.\n";
  check(
    "a MARKDOWN artifact containing a ```mermaid fence renders the diagram, not the source",
    k("plan.md", "text/markdown", mdWithFence) === "mermaid",
    `-> ${k("plan.md", "text/markdown", mdWithFence)} (plain markdown still -> ${k("plan.md", "text/markdown", "# just prose")})`,
  );

  check(
    "HTML / D3 documents render as html",
    k("viz.html", "text/plain") === "html" && k("page", "text/html") === "html",
    `.html -> ${k("viz.html", "text/plain")}, text/html -> ${k("page", "text/html")}`,
  );

  check(
    "SVG renders as markup (svg), NOT as an <img> — an SVG can carry its own script",
    k("chart.svg", "image/svg+xml") === "svg" && k("chart", "image/svg+xml") === "svg",
    `image/svg+xml -> ${k("chart.svg", "image/svg+xml")}`,
  );

  check(
    "raster images are untouched — still the <img src={sas}> path",
    k("shot.png", "image/png") === "image" && k("p.jpg", "image/jpeg") === "image",
    `image/png -> ${k("shot.png", "image/png")}; pdf -> ${k("r.pdf", "application/pdf")}`,
  );

  check(
    "an SVG with no server-side text but a SAS url degrades to the image path rather than nothing",
    detectPreviewKind({ name: "c.svg", mime: "image/svg+xml", text: null, url: "https://sas" }) === "image",
    `text:null -> ${detectPreviewKind({ name: "c.svg", mime: "image/svg+xml", text: null, url: "https://sas" })}`,
  );

  check(
    "an UNKNOWN mime with text falls back to today's plain-text preview, never to a blank pane",
    k("thing.weird", "application/x-weird") === "text" && k("no-ext", "application/x-weird") === "text",
    `application/x-weird -> ${k("thing.weird", "application/x-weird")}`,
  );

  check(
    "no text and no url = 'none' (the 'preview not available' message), not a crash",
    detectPreviewKind({ name: "x.bin", mime: "application/octet-stream", text: null, url: null }) === "none",
    `-> ${detectPreviewKind({ name: "x.bin", mime: "application/octet-stream", text: null, url: null })}`,
  );

  check(
    "only markup kinds are drawn in the iframe; markdown/text/image/pdf are not",
    rendersInIframe("html") &&
      rendersInIframe("mermaid") &&
      rendersInIframe("svg") &&
      !rendersInIframe("markdown") &&
      !rendersInIframe("text") &&
      !rendersInIframe("image") &&
      !rendersInIframe("pdf"),
    "html/mermaid/svg = iframe; markdown/text/image/pdf = existing paths",
  );
}

// ── 2. THE SANDBOX. `allow-scripts` WITHOUT `allow-same-origin` = opaque origin. ────────────────
{
  check(
    "the script-running sandbox is exactly 'allow-scripts' — one token, nothing else",
    SANDBOX_SCRIPTS === "allow-scripts" && sandboxFor("html") === "allow-scripts" && sandboxFor("mermaid") === "allow-scripts",
    `sandboxFor('html') = "${sandboxFor("html")}"`,
  );
  check(
    "SVG needs no script at all, so it gets the fully-restricted sandbox=\"\"",
    SANDBOX_NONE === "" && sandboxFor("svg") === "",
    `sandboxFor('svg') = "${sandboxFor("svg")}"`,
  );
  check(
    "NO kind ever yields allow-same-origin (pairing it with allow-scripts disables the sandbox)",
    (["html", "mermaid", "svg", "markdown", "text", "image", "pdf", "none"] as const).every(
      (k) => !sandboxFor(k).includes("allow-same-origin"),
    ),
    "checked every PreviewKind",
  );
  check(
    "'allow-same-origin' appears in NO executable line of either file — only in the warnings about it",
    !VIEW_CODE.includes("allow-same-origin") && !PREVIEW_CODE.includes("allow-same-origin"),
    "comment lines stripped, then both files scanned as raw text",
  );
  check(
    "the viewer NEVER uses dangerouslySetInnerHTML — untrusted markup never enters the app document",
    !VIEW_CODE.includes("dangerouslySetInnerHTML") && !PREVIEW_CODE.includes("dangerouslySetInnerHTML"),
    "ArtifactsView.tsx and preview.ts code scanned (comments stripped)",
  );
  check(
    "the iframe is driven by srcDoc + sandboxFor(), so the sandbox cannot be hardcoded loosely",
    VIEW_SRC.includes("srcDoc={buildSrcDoc(") && VIEW_SRC.includes("sandbox={sandboxFor(kind)}"),
    "found srcDoc={buildSrcDoc(…)} and sandbox={sandboxFor(kind)} in ArtifactPreview",
  );
}

// ── 3. The generated srcdoc: scaffolding present, libraries pinned, nothing leaks out ───────────
{
  const html = buildSrcDoc("html", "<div id='chart'></div><script>d3.select('#chart')</script>");
  check(
    "an HTML fragment is wrapped in a real document with the base style and PINNED d3",
    html.startsWith("<!doctype html>") && html.includes(D3_CDN) && /d3@7\.9\.0/.test(html) && html.includes("<style>"),
    `d3 tag: ${D3_CDN}`,
  );
  check(
    "a FULL html document keeps its own <html>/<head> and still gets d3 + the base style injected",
    (() => {
      const out = buildSrcDoc("html", "<!doctype html><html><head><title>Viz</title></head><body>x</body></html>");
      return out.includes("<title>Viz</title>") && out.includes(D3_CDN) && (out.match(/<html/gi) ?? []).length === 1;
    })(),
    "one <html> element, title preserved, script injected into the existing head",
  );

  const diagram = buildSrcDoc("mermaid", "graph TD;\n  A-->B;");
  check(
    "a mermaid artifact becomes <pre class=\"mermaid\"> + the PINNED mermaid CDN + initialize()",
    diagram.includes('<pre class="mermaid">') && diagram.includes(MERMAID_CDN) && /mermaid@11\.4\.1/.test(diagram) && diagram.includes("mermaid.initialize"),
    `mermaid tag: ${MERMAID_CDN}`,
  );
  check(
    "mermaid runs with securityLevel 'strict' so the diagram's own labels cannot inject markup",
    diagram.includes("securityLevel:'strict'"),
    "mermaid.initialize({startOnLoad:true,securityLevel:'strict'})",
  );

  const fenced = "# Plan\n\n```mermaid\ngraph TD;\n  A-->B;\n```\n\ntrailing prose\n";
  check(
    "fence extraction takes the DIAGRAM only, and the surrounding prose survives separately",
    hasMermaidFence(fenced) &&
      extractMermaidBlocks(fenced).length === 1 &&
      extractMermaidBlocks(fenced)[0] === "graph TD;\n  A-->B;" &&
      buildSrcDoc("mermaid", fenced).includes("trailing prose"),
    `block: ${JSON.stringify(extractMermaidBlocks(fenced)[0])}`,
  );
  check(
    "a bare diagram with no fences is itself the single block",
    !hasMermaidFence("graph TD;\n A-->B;") && extractMermaidBlocks("graph TD;\n A-->B;").length === 1,
    "no fence -> whole body is the diagram",
  );
  check(
    "two fenced diagrams both render",
    extractMermaidBlocks("```mermaid\nA\n```\ntext\n```mermaid\nB\n```").join("|") === "A|B",
    `blocks: ${extractMermaidBlocks("```mermaid\nA\n```\ntext\n```mermaid\nB\n```").join(", ")}`,
  );
}

// ── 4. THE XSS CASE. Hostile content must land inside the frame, and nowhere else. ──────────────
{
  const hostile = `<script>alert(1)</script><img src=x onerror="alert(2)">`;

  const htmlDoc = buildSrcDoc("html", hostile);
  check(
    "hostile HTML stays in the srcdoc (it runs in the frame's OPAQUE origin — that is the design)",
    htmlDoc.includes("<script>alert(1)</script>") && sandboxFor("html") === "allow-scripts",
    "present in srcdoc; frame has no same-origin access to the app",
  );

  const svgDoc = buildSrcDoc("svg", `<svg xmlns="http://www.w3.org/2000/svg">${hostile}</svg>`);
  check(
    "a scripted SVG is confined to a frame where script is DISABLED outright",
    svgDoc.includes("alert(1)") && sandboxFor("svg") === "",
    'sandbox="" — no allow-scripts, so neither <script> nor onerror can fire',
  );

  const md = buildSrcDoc("mermaid", "```mermaid\ngraph TD;\n```\n" + hostile);
  check(
    "hostile prose beside a diagram is HTML-ESCAPED, so it cannot even become markup in the frame",
    md.includes("&lt;script&gt;alert(1)&lt;/script&gt;") && !md.includes("<script>alert(1)</script>"),
    "escaped into the <pre>, not parsed as a tag",
  );
  check(
    "a diagram source containing </pre> cannot terminate the element that holds it",
    buildSrcDoc("mermaid", "graph TD;</pre><script>alert(3)</script>").includes("&lt;/pre&gt;"),
    "escapeHtml applied to every mermaid block",
  );

  check(
    "hostile content NEVER reaches a parent-document injection path",
    !VIEW_CODE.includes("innerHTML") &&
      !VIEW_CODE.includes("document.write") &&
      !VIEW_CODE.includes("insertAdjacentHTML") &&
      !VIEW_CODE.includes("new Function"),
    "no innerHTML / document.write / insertAdjacentHTML / new Function in ArtifactsView.tsx code",
  );
}

console.log(`\n==================== ${pass} passed, ${fail} failed ====================`);
process.exit(fail === 0 ? 0 : 1);
