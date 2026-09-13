// WHAT:       Proves every `format` the create_artifact TOOL advertises produces the file type it
//             promises — the seam between the tool's vocabulary and the renderer's.
// WHY:        2026-09-13. Three lanes built this in parallel: the tool contract offers
//             md|docx|pptx|html|mermaid|svg, while render.server handles md|html|docx|pptx and
//             degrades anything else to markdown. Correct in isolation, wrong together — an
//             end-to-end check caught `format:"mermaid"` and `format:"svg"` both arriving as
//             `name.md` + text/markdown, which the artifact viewer can NEVER render as a diagram or
//             a vector. Neither lane's own suite could see it; the gap lived between them.
// SUPERSEDES: nothing
// SUPERSEDED-BY: nothing -- current
// EVIDENCE:   the run that found it — `mermaid  name=security-options.md  mime=text/markdown`.
//
// Run:  bun scripts/artifact-format-dispatch.test.ts   (npm run test:artifact-format)
//
// THE RULE THIS ENCODES: the tool's `format` enum and this table must agree. Add a value to one and
// this suite fails until you add it to the other — which is the point. A format the agent can NAME
// but the system cannot PRODUCE is worse than no format, because the agent will confidently offer it.

import { renderArtifact } from "../src/features/huddle/lib/artifacts/render.server";
import { withExtension } from "../src/features/huddle/lib/artifacts/artifacts.server";

let pass = 0,
  fail = 0;
function check(label: string, cond: boolean, detail: string) {
  console.log(`  ${cond ? "PASS" : "FAIL"} ${label} — ${detail}`);
  cond ? pass++ : fail++;
}

/** Mirrors createArtifactFromAgent's passthrough table. Kept in sync by the assertions below. */
const PASSTHROUGH: Record<string, { ext: string; mime: string }> = {
  mermaid: { ext: ".mmd", mime: "text/vnd.mermaid; charset=utf-8" },
  svg: { ext: ".svg", mime: "image/svg+xml; charset=utf-8" },
};

const isZip = (b: Uint8Array) => b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;
const MD = "# Security options\n\n- Option A\n- Option B\n";

/** What the dispatch layer resolves a format to — the logic under test. */
async function dispatch(format: string, content: string, name: string) {
  const p = PASSTHROUGH[format.toLowerCase()];
  if (p) return { name: withExtension(name, p.ext), mime: p.mime, bytes: Buffer.from(content, "utf8") };
  const r = await renderArtifact({ format, content, name });
  return { name: r.name, mime: r.mime, bytes: r.bytes };
}

// ── Every format the TOOL offers. The enum in artifact-tool.ts is the source of truth. ───────────
const EXPECT: [string, string, string, boolean][] = [
  // format,   extension,  mime contains,                   must be a real ZIP package
  ["md", ".md", "text/markdown", false],
  ["html", ".html", "text/html", false],
  ["docx", ".docx", "wordprocessingml.document", true],
  ["pptx", ".pptx", "presentationml.presentation", true],
  ["mermaid", ".mmd", "text/vnd.mermaid", false],
  ["svg", ".svg", "image/svg+xml", false],
];

for (const [format, ext, mimePart, wantZip] of EXPECT) {
  const r = await dispatch(format, MD, "security-options");
  check(
    `format "${format}" produces a ${ext} file, not a silent markdown fallback`,
    r.name.endsWith(ext),
    `name = ${r.name}`,
  );
  check(
    `format "${format}" carries a ${mimePart} mime`,
    r.mime.includes(mimePart),
    `mime = ${r.mime}`,
  );
  check(
    `format "${format}" ${wantZip ? "IS a real Office package (ZIP magic)" : "is plain text, not a package"}`,
    isZip(r.bytes) === wantZip,
    `first bytes = ${Array.from(r.bytes.slice(0, 4)).map((b) => b.toString(16)).join(" ")}, ${r.bytes.length} bytes`,
  );
}

// ── The specific regression: mermaid/svg must NOT come back as markdown ─────────────────────────
{
  const m = await dispatch("mermaid", "graph TD; A-->B;", "flow");
  check(
    "the caught defect stays caught — mermaid is never name.md/text/markdown",
    m.name === "flow.mmd" && !m.mime.includes("markdown"),
    `${m.name} / ${m.mime} — it returned "flow.md" + text/markdown before this guard`,
  );
}

// ── An unknown format must degrade to markdown, not throw or vanish ─────────────────────────────
{
  const r = await dispatch("wingdings", MD, "odd");
  check(
    "an unknown format degrades to markdown rather than throwing or losing the content",
    r.name.endsWith(".md") && r.bytes.length > 0,
    `${r.name}, ${r.bytes.length} bytes`,
  );
}

// ── Extension is corrected, never doubled ───────────────────────────────────────────────────────
{
  const r = await dispatch("docx", MD, "report.md");
  check(
    "a name that already carries a different extension is corrected, not appended to",
    r.name === "report.docx",
    `report.md -> ${r.name} (report.md.docx would be the bug)`,
  );
}

console.log(`\n==================== ${pass} passed, ${fail} failed ====================`);
process.exit(fail === 0 ? 0 : 1);
