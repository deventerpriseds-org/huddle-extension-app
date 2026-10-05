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
import {
  withExtension,
  safeArtifactName,
  safeArtifactFolder,
  mirrorFileName,
} from "../src/features/huddle/lib/artifacts/artifacts.server";
import { readFileSync } from "node:fs";

// SOURCE-TEXT ASSERTIONS, and why they are the RIGHT tool for three of the loop-3 findings rather
// than a shortcut. "Is the guard present at every dispatch site" and "can the voice schema emit this
// field at all" are properties of code that cannot be exercised offline — the voice schema is handed
// to OpenAI's Realtime session, and the durable-turn worker needs a live turn. The defect in both
// cases was that a site EXISTED and was never edited, which is exactly what reading the file proves
// and what a behavioural test of the sites you did edit can never see. That blindness is what cost
// loop 3. Where behaviour IS reachable (sanitisers, mirror names) the checks below call the function.
const SRC = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
const ARTIFACTS_SRC = SRC("../src/features/huddle/lib/artifacts/artifacts.server.ts");
const VOICE_SRC = SRC("../src/features/huddle/lib/voice/realtime-tools.server.ts");
const ALL_GUARD_SRC = SRC("../src/features/huddle/lib/huddle.functions.ts") + VOICE_SRC;

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


// ── VERIFIER LOOP 2 REFUTATIONS. All four found by an independent pass, none by the implementer.
//    docs/VERIFY-artifact-formats-2.md — 8 CONFIRMED, 2 REFUTED.

// C9a — PATH TRAVERSAL. slug() protected the BLOB path; nothing sanitised artifacts.items.name, and
// onedrive.server.ts:21 encodes per segment with encodeURIComponent, which does NOT encode ".".
// So "../../etc/passwd" escaped the "Huddle Artifacts" folder on a real user's OneDrive.
for (const [input, want] of [
  ["../../etc/passwd", "passwd"],
  ["..\\..\\windows\\win.ini", "win.ini"],
  ["Huddle/../../../secret.docx", "secret.docx"],
  [".docx", "artifact.docx"],
  ["..", "artifact"],
  ["", "artifact"],
] as [string, string][]) {
  check(
    `a model-supplied name cannot escape its folder: ${JSON.stringify(input)}`,
    safeArtifactName(input) === want,
    `-> ${JSON.stringify(safeArtifactName(input))}, want ${JSON.stringify(want)}`,
  );
}
check(
  "sanitising does NOT eat legitimate dots, digits or spaces",
  safeArtifactName("Q3 plan v2.1.docx") === "Q3 plan v2.1.docx" &&
    safeArtifactName("report-2026.09.13.docx") === "report-2026.09.13.docx",
  `"Q3 plan v2.1.docx" -> ${JSON.stringify(safeArtifactName("Q3 plan v2.1.docx"))} — a control-char class written as a literal byte range once nearly stripped these`,
);

// C9b — THE MIME OVERRIDE LIES BOTH WAYS. The first guard only tested `rendered.mime`, catching a
// real docx labelled text/markdown while leaving the reverse open: markdown bytes wearing the Word
// mime, so "report.docx" downloads and Word refuses to open it.
{
  const isPackageMime = (m: string) =>
    /officedocument|application\/zip|application\/pdf|^application\/octet-stream/i.test(m);
  const resolve = (renderedMime: string, raw: string | null) =>
    raw && !isPackageMime(renderedMime) && !isPackageMime(raw) ? raw : renderedMime;
  const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  check(
    "markdown bytes can NEVER claim an Office mime (the refuted direction)",
    resolve("text/markdown", DOCX) === "text/markdown",
    `-> ${resolve("text/markdown", DOCX)}`,
  );
  check(
    "a real Office package can never be mislabelled as text (the direction already guarded)",
    resolve(DOCX, "text/markdown") === DOCX,
    `-> ${resolve(DOCX, "text/markdown").slice(0, 40)}…`,
  );
  check(
    "a legitimate text-to-text override is still honoured — the escape hatch survives",
    resolve("text/markdown", "text/csv") === "text/csv",
    `-> ${resolve("text/markdown", "text/csv")}`,
  );
}

// C9c — a format with stray casing/whitespace must still resolve, not fall through to markdown.
check(
  'a format of " DOCX " normalises rather than silently degrading',
  " DOCX ".trim().toLowerCase() === "docx",
  `" DOCX " -> "${" DOCX ".trim().toLowerCase()}"`,
);

// ── VERIFIER LOOP 3 REFUTATIONS + robustness. docs/VERIFY-artifact-formats-3.md —
//    10 CONFIRMED, 2 REFUTED, 2 robustness defects. Every one of the four is the SAME root cause:
//    the loop-2 fix closed the instance that was named and left the class open.

// R2 — THE OTHER HALF OF THE TRAVERSAL. `Huddle Artifacts/{lane}/{name}` is built from TWO
// model-controlled values. Loop 2 sanitised `name`; `folder` went into the INSERT raw, so
// `folder: "../../../Documents"` escaped by the identical mechanism.
// Two lanes wrote `safeArtifactFolder` independently off this finding; the surviving body takes the
// LAST real segment and falls back to "Personal" (the artifacts.items DDL default). The expectations
// below are that body's, not the other one's — a merge that keeps a function has to keep its tests.
for (const [input, want] of [
  ["../../../Documents", "Documents"],
  ["..\\..\\Windows", "Windows"],
  ["Research/../../etc", "etc"],
  ["..", "Personal"],
  ["", "Personal"],
  [".", "Personal"],
] as [string, string][]) {
  check(
    `a model-supplied FOLDER cannot escape its lane: ${JSON.stringify(input)}`,
    safeArtifactFolder(input) === want,
    `-> ${JSON.stringify(safeArtifactFolder(input))}, want ${JSON.stringify(want)}`,
  );
}
check(
  "sanitising a folder leaves an ordinary lane name alone",
  safeArtifactFolder("Ventures") === "Ventures" && safeArtifactFolder("Finance & Ops") === "Finance & Ops",
  `"Finance & Ops" -> ${JSON.stringify(safeArtifactFolder("Finance & Ops"))}`,
);
check(
  "both path segments are sanitised at createArtifact — the LAST gate, not just the agent choke point",
  /const folder = safeArtifactFolder\(input\.folder\);/.test(ARTIFACTS_SRC) &&
    /const name = safeArtifactName\(input\.name\);/.test(ARTIFACTS_SRC) &&
    /\$\{slug\(folder\)\}\/\$\{id\}-\$\{slug\(name\)\}/.test(ARTIFACTS_SRC),
  "createArtifact has five callers including USER-uploaded chat attachments; sanitising only inside createArtifactFromAgent left four of them open",
);

// ROBUSTNESS 1 — a 5005-character name passed through untruncated and would be rejected by
// SharePoint's ~400-char path limit, far from where it was accepted.
{
  const long = "a".repeat(5005) + ".docx";
  const out = safeArtifactName(long);
  check(
    "an absurdly long name is capped, and the cap keeps the EXTENSION",
    out.length <= 120 && out.endsWith(".docx"),
    `5005 chars -> ${out.length} chars, ends ${JSON.stringify(out.slice(-6))}`,
  );
  check(
    "a name at the limit is not truncated for its own sake",
    safeArtifactName("b".repeat(100) + ".md") === "b".repeat(100) + ".md",
    `103 chars survives intact`,
  );
}

// ROBUSTNESS 2 — THE COLLISION THE TRAVERSAL FIX CREATED. `reports/q3.docx` and `drafts/q3.docx`
// are two artifacts that now BOTH sanitise to `q3.docx`; the OneDrive mirror is deliberately
// path-keyed with replace semantics, so one silently overwrote the other on a real drive.
{
  const a = mirrorFileName("art-1a2b3c4d-0000-0000-0000-000000000000", "reports/q3.docx");
  const b = mirrorFileName("art-9f8e7d6c-0000-0000-0000-000000000000", "drafts/q3.docx");
  check(
    "two artifacts whose names collide after sanitising get DIFFERENT mirror paths",
    a !== b && a.endsWith(".docx") && b.endsWith(".docx"),
    `${a} vs ${b} — both were "q3.docx" before this guard, and the mirror overwrites by path`,
  );
  check(
    "the same artifact mirrors to the SAME path every time — idempotency is the point of path-keying",
    mirrorFileName("art-1a2b3c4d-0000-0000-0000-000000000000", "reports/q3.docx") === a &&
      mirrorFileName("art-1a2b3c4d-0000-0000-0000-000000000000", a) === a,
    `re-mirroring gives ${a} again, and re-applying to an already-suffixed name does not stack suffixes`,
  );
  check(
    "the mirror name stays under the cap even when the source name is enormous",
    mirrorFileName("art-1a2b3c4d", "z".repeat(5005) + ".pptx").length <= 120,
    `-> ${mirrorFileName("art-1a2b3c4d", "z".repeat(5005) + ".pptx").length} chars`,
  );
  check(
    "the mirror call passes the sanitised lane and the id-keyed name, not the raw row",
    /lane: safeArtifactFolder\(row\.folder\)/.test(ARTIFACTS_SRC) &&
      /name: mirrorFileName\(row\.id, row\.name\)/.test(ARTIFACTS_SRC),
    "rows written before the traversal fix still hold raw model output; this call is what puts them on a real drive",
  );
}

// R1 — THE GUARD THAT WAS NEVER RELAXED. Two of four dispatch paths were fixed to accept a
// structured `document`; the durable-turn worker and the VOICE path still demanded `content`, so
// "make me a deck" spoken out loud was rejected outright while the format work was reported done.
// Match the RETURNED error, not any mention of the phrase: the first version of this assertion keyed
// on the bare string and was tripped by a code COMMENT quoting the old text to explain why it went.
// A guard that fires on prose about itself is noise, and noise is what gets assertions deleted.
{
  const relaxed = (ALL_GUARD_SRC.match(/error: "name plus content or document are required"/g) ?? []).length;
  const stale = (ALL_GUARD_SRC.match(/error: "name and content are required"/g) ?? []).length;
  check(
    "every create_artifact dispatch guard accepts a document-only call — all FOUR, not the two that were edited",
    relaxed === 4 && stale === 0,
    `${relaxed} relaxed guards (want 4), ${stale} still returning the old error (want 0)`,
  );
}
check(
  "the VOICE schema can actually emit a document — relaxing its executor alone changed nothing",
  /document: \{\s*type: "object"/.test(VOICE_SRC) && !/required: \["name", "content"\]/.test(VOICE_SRC),
  'additionalProperties:false + required ["name","content"] made a document-only voice call unemittable',
);

console.log(`\n==================== ${pass} passed, ${fail} failed ====================`);
process.exit(fail === 0 ? 0 : 1);
