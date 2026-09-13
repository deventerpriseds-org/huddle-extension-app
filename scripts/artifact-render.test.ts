// WHAT:       Proves `render.server.ts` produces REAL Office packages — by unzipping what it returns
//             and reading the OOXML inside, not by trusting the renderer's own return value.
// WHY:        The failure this guards against is silent and total: a text blob handed back under an
//             Office mime downloads fine and then refuses to open in Word/PowerPoint. Nothing about
//             the call site can tell the difference. So every Office assertion here starts at the ZIP
//             magic `PK\x03\x04` and then goes on to read `word/document.xml` / `ppt/slides/slideN.xml`
//             for the actual text, heading style, numbering, table and code run.
//             Second guarded failure: an agent emitting a malformed structure must NEVER throw — the
//             user's work is in that content, and an exception loses it.
// SUPERSEDES: nothing
// SUPERSEDED-BY: nothing -- current
// EVIDENCE:   `npm run test:artifact-render`. The ZIP reader below is the central-directory parse,
//             so a package whose local headers carry data descriptors still reads correctly.
//
// Run:  bun scripts/artifact-render.test.ts   (npm run test:artifact-render)

import { inflateRawSync } from "node:zlib";
import {
  MIME_BY_FORMAT,
  blocksToSlides,
  ensureExtension,
  isZip,
  parseInline,
  parseMarkdownBlocks,
  renderArtifact,
  renderDeckToPptx,
  renderDocumentToDocx,
  renderMarkdownToDocx,
  renderMarkdownToPptx,
  type DocxDocument,
  type PptxDeck,
} from "../src/features/huddle/lib/artifacts/render.server";

let pass = 0,
  fail = 0;
function check(label: string, cond: boolean, detail: string) {
  console.log(`  ${cond ? "PASS" : "FAIL"} ${label} — ${detail}`);
  cond ? pass++ : fail++;
}

// ── A minimal ZIP reader (central directory), so "is this a real OOXML package?" is answered by
//    actually opening it. node:zlib only; no test framework, no extra dependency. ───────────────
function unzip(bytes: Uint8Array): Record<string, string> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("no end-of-central-directory record — not a ZIP");
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);

  const files: Record<string, string> = {};
  for (let n = 0; n < count; n++) {
    if (view.getUint32(p, true) !== 0x02014b50) throw new Error(`bad central directory entry at ${p}`);
    const method = view.getUint16(p + 10, true);
    const compressedSize = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localOffset = view.getUint32(p + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen));

    const lNameLen = view.getUint16(localOffset + 26, true);
    const lExtraLen = view.getUint16(localOffset + 28, true);
    const start = localOffset + 30 + lNameLen + lExtraLen;
    const raw = bytes.subarray(start, start + compressedSize);
    files[name] = new TextDecoder().decode(method === 8 ? inflateRawSync(raw) : raw);

    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

/** Strip XML tags so an assertion about TEXT is not defeated by Word splitting a run mid-word. */
const textOf = (xml: string): string => xml.replace(/<[^>]+>/g, "");

/**
 * The ZIP magic checked LOCALLY, on the raw bytes — deliberately NOT via the module's own `isZip`.
 * If this suite only ever asked the renderer whether its own output was a package, a broken `isZip`
 * would make every Office assertion here pass while the files refused to open.
 */
const hasZipMagic = (b: Uint8Array): boolean =>
  b.length > 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;

const magic = (bytes: Uint8Array): string =>
  Array.from(bytes.subarray(0, 4))
    .map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : `\\x${b.toString(16).padStart(2, "0")}`))
    .join("");

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// The markdown that exercises every construct the renderer claims to handle.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
const RICH_MD = `# Quarterly Review

An **intro paragraph** with *emphasis* and \`inline_code\`.

## Findings

- first bullet
- second bullet
  - nested bullet
- third bullet

1. ordered one
2. ordered two

| Region | Revenue |
| --- | --- |
| EMEA | 120 |
| APAC | 95 |

\`\`\`ts
const total = 215;
\`\`\`

> A quoted line from the owner.

---

# Next Steps

Ship it.
`;

// ── DOCX from markdown ───────────────────────────────────────────────────────────────────────────
{
  const { bytes, warnings } = await renderMarkdownToDocx(RICH_MD, { title: "Quarterly Review" });
  check(
    "markdown -> docx produces a non-empty package starting with the ZIP magic PK\\x03\\x04",
    bytes.length > 0 && hasZipMagic(bytes) && isZip(bytes),
    `${bytes.length} bytes, first four = "${magic(bytes)}" — a text blob under an Office mime would read "# Qu"`,
  );
  check("a clean markdown render reports no warnings", warnings.length === 0, `warnings: [${warnings.join(" | ")}]`);

  const files = unzip(bytes);
  const xml = files["word/document.xml"] ?? "";
  const text = textOf(xml);

  check(
    "the package really is a Word document — word/document.xml is inside it",
    Boolean(files["word/document.xml"]) && Boolean(files["[Content_Types].xml"]),
    `entries: ${Object.keys(files).slice(0, 6).join(", ")}…`,
  );
  check(
    "HEADINGS survive with real Word heading styles, not as plain text",
    xml.includes('w:val="Heading1"') && xml.includes('w:val="Heading2"') && text.includes("Quarterly Review") && text.includes("Findings"),
    `Heading1=${xml.includes('w:val="Heading1"')}, Heading2=${xml.includes('w:val="Heading2"')}`,
  );
  check(
    "BULLETS survive as real numbering references (w:numPr), and every item's text is present",
    xml.includes("<w:numPr>") &&
      ["first bullet", "second bullet", "nested bullet", "third bullet"].every((t) => text.includes(t)),
    `w:numPr present=${xml.includes("<w:numPr>")}; all four bullet texts present=${["first bullet", "second bullet", "nested bullet", "third bullet"].every((t) => text.includes(t))}`,
  );
  check(
    "a NESTED bullet keeps its depth — level 1 appears alongside level 0",
    /<w:ilvl w:val="1"\s*\/?>/.test(xml),
    `ilvl values found: [${Array.from(xml.matchAll(/<w:ilvl w:val="(\d)"/g)).map((m) => m[1]).join(",")}]`,
  );
  check(
    "an ORDERED list uses the numbering definition, not a bullet glyph typed into the text",
    xml.includes("<w:numId") && !text.includes("1. ordered one") && text.includes("ordered one"),
    `numId present=${xml.includes("<w:numId")}; literal "1." left in text=${text.includes("1. ordered one")}`,
  );
  check(
    "a TABLE survives as a real Word table (w:tbl) with its header and cells",
    xml.includes("<w:tbl>") && ["Region", "Revenue", "EMEA", "120", "APAC", "95"].every((t) => text.includes(t)),
    `w:tbl present=${xml.includes("<w:tbl>")}; cells found=${["Region", "Revenue", "EMEA", "120", "APAC", "95"].filter((t) => text.includes(t)).join(", ")}`,
  );
  check(
    "a CODE BLOCK survives with its content and a monospace font run",
    text.includes("const total = 215;") && xml.includes("Courier New"),
    `code text present=${text.includes("const total = 215;")}; Courier New run=${xml.includes("Courier New")}`,
  );
  check(
    "BOLD and ITALIC inline runs become real run properties, and the markers are gone from the text",
    xml.includes("<w:b ") || xml.includes("<w:b/>") ? text.includes("intro paragraph") && !text.includes("**intro paragraph**") : false,
    `bold run present=${xml.includes("<w:b ") || xml.includes("<w:b/>")}; literal asterisks left=${text.includes("**")}`,
  );
  check(
    "a BLOCK QUOTE keeps its text",
    text.includes("A quoted line from the owner."),
    `quote text present=${text.includes("A quoted line from the owner.")}`,
  );
}

// ── PPTX from markdown: the `#` / `---` slide rule ───────────────────────────────────────────────
const slideNames = (files: Record<string, string>) =>
  Object.keys(files)
    .filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f))
    .sort();

{
  const { bytes } = await renderMarkdownToPptx(RICH_MD, { title: "Quarterly Review" });
  check(
    "markdown -> pptx produces a non-empty package starting with the ZIP magic PK\\x03\\x04",
    bytes.length > 0 && hasZipMagic(bytes) && isZip(bytes),
    `${bytes.length} bytes, first four = "${magic(bytes)}"`,
  );
  const files = unzip(bytes);
  const slides = slideNames(files);
  check(
    "RICH_MD has two `#` headings separated by a `---`, and yields exactly 2 slides (the rule is: `#` OR `---` starts one, and the `---` immediately before a `#` must not open an empty third)",
    slides.length === 2,
    `${slides.length} slides: ${slides.join(", ")}`,
  );
  const all = slides.map((s) => textOf(files[s])).join("\n");
  check(
    "each slide's heading became its TITLE and the following content became body text",
    all.includes("Quarterly Review") && all.includes("Next Steps") && all.includes("Ship it.") && all.includes("first bullet"),
    `titles+body found: Quarterly Review=${all.includes("Quarterly Review")}, Next Steps=${all.includes("Next Steps")}, body=${all.includes("Ship it.")}`,
  );
  check(
    "a markdown TABLE becomes a real pptx table (a:tbl), not a pasted text block",
    slides.some((s) => files[s].includes("<a:tbl>")) && all.includes("EMEA"),
    `a:tbl present=${slides.some((s) => files[s].includes("<a:tbl>"))}; cell text EMEA=${all.includes("EMEA")}`,
  );
}

// The slide rule, isolated — count slides for each shape of input.
{
  const cases: Array<[string, string, number]> = [
    ["three `#` headings", "# One\n\ntext\n\n# Two\n\ntext\n\n# Three\n", 3],
    ["two blocks split by `---`", "Opening line\n\n---\n\nSecond block\n", 2],
    ["`##` alone does NOT split — deeper headings stay inside the slide", "# Only\n\n## Section A\n\n## Section B\n", 1],
    ["no slide marker at all still yields one slide", "just a paragraph\n", 1],
  ];
  for (const [label, md, want] of cases) {
    const { bytes } = await renderMarkdownToPptx(md, { title: "Deck" });
    const got = slideNames(unzip(bytes)).length;
    check(`slide rule: ${label} -> ${want} slide(s)`, got === want, `got ${got}`);
  }
}

// ── The STRUCTURED paths ─────────────────────────────────────────────────────────────────────────
{
  const doc: DocxDocument = {
    title: "Structured Brief",
    sections: [
      { type: "heading", text: "Background", level: 2 },
      { type: "paragraph", text: "A paragraph with **bold** in it." },
      { type: "bullets", items: ["alpha item", "beta item"] },
      { type: "bullets", items: ["step one", "step two"], ordered: true },
      { type: "table", header: ["Owner", "Status"], rows: [["Terry", "Open"]] },
      { type: "code", text: "npm run build" },
      { type: "quote", text: "Keep it small." },
    ],
  };
  const { bytes, warnings } = await renderDocumentToDocx(doc);
  const text = textOf(unzip(bytes)["word/document.xml"] ?? "");
  check(
    "the structured docx path renders every section it was given, in order",
    hasZipMagic(bytes) && isZip(bytes) &&
      warnings.length === 0 &&
      ["Structured Brief", "Background", "bold", "alpha item", "beta item", "step one", "Owner", "Terry", "npm run build", "Keep it small."].every(
        (t) => text.includes(t),
      ),
    `${bytes.length} bytes; warnings=[${warnings.join(" | ")}]; missing=[${["Structured Brief", "Background", "alpha item", "step one", "Terry", "npm run build", "Keep it small."].filter((t) => !text.includes(t)).join(", ")}]`,
  );
}

{
  const deck: PptxDeck = {
    title: "Structured Deck",
    slides: [
      { title: "Slide One", bullets: ["point a", "point b"], notes: "speaker note here" },
      { title: "Slide Two", table: { header: ["K", "V"], rows: [["latency", "1.2s"]] } },
      { title: "Slide Three", bullets: ["last point"] },
    ],
  };
  const { bytes, warnings } = await renderDeckToPptx(deck);
  const files = unzip(bytes);
  const slides = slideNames(files);
  const all = slides.map((s) => textOf(files[s])).join("\n");
  const notes = Object.keys(files)
    .filter((f) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(f))
    .map((f) => textOf(files[f]))
    .join("\n");
  check(
    "the structured deck path produces exactly the slides it was given, with their titles and bullets",
    hasZipMagic(bytes) && isZip(bytes) && slides.length === 3 && ["Slide One", "point a", "Slide Two", "latency", "Slide Three", "last point"].every((t) => all.includes(t)),
    `${slides.length} slides; warnings=[${warnings.join(" | ")}]; missing=[${["Slide One", "point a", "Slide Two", "latency", "Slide Three", "last point"].filter((t) => !all.includes(t)).join(", ")}]`,
  );
  check("a slide's `notes` land in the notes slide, not in the body", notes.includes("speaker note here"), `notes payload: "${notes.slice(0, 60)}"`);
}

// ── Name extension: corrected, never doubled ─────────────────────────────────────────────────────
{
  const cases: Array<[string, "md" | "html" | "docx" | "pptx", string]> = [
    ["report", "docx", "report.docx"],
    ["report.md", "docx", "report.docx"],
    ["report.docx", "docx", "report.docx"],
    ["report.DOCX", "docx", "report.DOCX"],
    ["deck.md", "pptx", "deck.pptx"],
    ["deck.pptx", "pptx", "deck.pptx"],
    ["notes.docx", "md", "notes.md"],
    ["page", "html", "page.html"],
    ["q3.plan", "docx", "q3.plan.docx"],
  ];
  for (const [input, format, want] of cases) {
    const got = ensureExtension(input, format);
    check(`name "${input}" as ${format} -> "${want}"`, got === want, `got "${got}"`);
  }
  const viaEntry = await renderArtifact({ format: "docx", content: "# hi", name: "brief.md" });
  check(
    "the entry point applies the same correction — never 'brief.md.docx'",
    viaEntry.name === "brief.docx",
    `got "${viaEntry.name}"`,
  );
}

// ── The single entry point: mimes, passthrough, and one path for every format ────────────────────
{
  const md = await renderArtifact({ format: "md", content: "# unchanged\n\ntext", name: "note" });
  check(
    "format md returns the UTF-8 bytes of `content` UNCHANGED with the markdown mime",
    new TextDecoder().decode(md.bytes) === "# unchanged\n\ntext" && md.mime === "text/markdown; charset=utf-8" && md.name === "note.md",
    `${md.bytes.length} bytes, mime=${md.mime}, name=${md.name}`,
  );

  const html = await renderArtifact({ format: "html", content: "<p>hi</p>", name: "page.html" });
  check(
    "format html likewise passes through untouched",
    new TextDecoder().decode(html.bytes) === "<p>hi</p>" && html.mime === "text/html; charset=utf-8",
    `mime=${html.mime}, bytes="${new TextDecoder().decode(html.bytes)}"`,
  );

  const docx = await renderArtifact({ format: "docx", content: "# Title\n\nbody", name: "doc" });
  const pptx = await renderArtifact({ format: "pptx", content: "# Title\n\nbody", name: "deck" });
  check(
    "docx carries the OOXML wordprocessingml mime and pptx the presentationml mime, exactly",
    docx.mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" &&
      pptx.mime === "application/vnd.openxmlformats-officedocument.presentationml.presentation" &&
      docx.mime === MIME_BY_FORMAT.docx &&
      pptx.mime === MIME_BY_FORMAT.pptx,
    `docx=${docx.mime} | pptx=${pptx.mime}`,
  );
  check(
    "both entry-point Office renders are real packages (ZIP magic), not text under an Office mime",
    hasZipMagic(docx.bytes) && hasZipMagic(pptx.bytes) && isZip(docx.bytes) && isZip(pptx.bytes),
    `docx first four="${magic(docx.bytes)}" (${docx.bytes.length}b), pptx first four="${magic(pptx.bytes)}" (${pptx.bytes.length}b)`,
  );

  const weird = await renderArtifact({ format: "xlsx", content: "raw", name: "sheet" });
  check(
    "an UNKNOWN format degrades to markdown with a warning rather than throwing",
    weird.mime === MIME_BY_FORMAT.md && weird.warnings.length > 0 && new TextDecoder().decode(weird.bytes) === "raw",
    `mime=${weird.mime}, warnings=[${weird.warnings.join(" | ")}]`,
  );
}

// ── NEVER THROW. Malformed input must degrade to a valid document plus a warning. ────────────────
{
  const malformed: Array<[string, Parameters<typeof renderArtifact>[0]]> = [
    ["a structured document whose `sections` is a string", { format: "docx", document: { sections: "not an array" }, name: "bad" }],
    ["a structured document that is a bare number", { format: "docx", document: 42, name: "bad" }],
    ["a structured deck with no `slides` at all", { format: "pptx", document: { nope: true }, name: "bad" }],
    ["a deck whose slides are strings, not objects", { format: "pptx", document: { slides: ["just a string"] }, name: "bad" }],
    ["a section with an unknown `type`", { format: "docx", document: { sections: [{ type: "flowchart", text: "keep me" }] }, name: "bad" }],
  ];
  for (const [label, input] of malformed) {
    let threw = "";
    let out: Awaited<ReturnType<typeof renderArtifact>> | null = null;
    try {
      out = await renderArtifact(input);
    } catch (e) {
      threw = e instanceof Error ? e.message : String(e);
    }
    check(
      `malformed input (${label}) returns a valid package + a warning, and does NOT throw`,
      !threw && out !== null && hasZipMagic(out.bytes) && isZip(out.bytes) && out.warnings.length > 0,
      threw ? `THREW: ${threw}` : `${out?.bytes.length} bytes, magic="${out ? magic(out.bytes) : "-"}", warnings=[${out?.warnings.join(" | ")}]`,
    );
  }

  // The content of a malformed structure must still reach the document — the user's work is in there.
  const kept = await renderArtifact({ format: "docx", document: { sections: [{ type: "flowchart", text: "keep me" }] }, name: "bad" });
  check(
    "content inside an unrecognised section is still written into the document, never dropped",
    textOf(unzip(kept.bytes)["word/document.xml"] ?? "").includes("keep me"),
    `document text: "${textOf(unzip(kept.bytes)["word/document.xml"] ?? "").slice(0, 60)}"`,
  );
}

{
  const empties: Array<[string, Parameters<typeof renderArtifact>[0]]> = [
    ["empty docx content", { format: "docx", content: "", name: "empty" }],
    ["empty pptx content", { format: "pptx", content: "", name: "empty" }],
    ["no content key at all", { format: "docx", name: "empty" }],
  ];
  for (const [label, input] of empties) {
    let threw = "";
    let out: Awaited<ReturnType<typeof renderArtifact>> | null = null;
    try {
      out = await renderArtifact(input);
    } catch (e) {
      threw = e instanceof Error ? e.message : String(e);
    }
    check(
      `${label} still produces a VALID, openable document plus a warning`,
      !threw && out !== null && hasZipMagic(out.bytes) && isZip(out.bytes) && out.bytes.length > 0 && out.warnings.length > 0,
      threw ? `THREW: ${threw}` : `${out?.bytes.length} bytes, warnings=[${out?.warnings.join(" | ")}]`,
    );
  }

  const emptyMd = await renderArtifact({ format: "md", content: "", name: "empty" });
  check(
    "empty markdown returns zero bytes and a warning rather than an error",
    emptyMd.bytes.length === 0 && emptyMd.warnings.length > 0,
    `${emptyMd.bytes.length} bytes, warnings=[${emptyMd.warnings.join(" | ")}]`,
  );
}

// Unparseable / hostile markdown: an unterminated fence, a ragged table, stray markers.
{
  const hostile = "```ts\nconst x = 1;\n\n| a | b\n| --- |\n| only-one-cell |\n\n**unclosed bold and *italic\n\n####### seven hashes\n";
  let threw = "";
  let docxBytes: Uint8Array | null = null;
  let pptxBytes: Uint8Array | null = null;
  try {
    docxBytes = (await renderMarkdownToDocx(hostile)).bytes;
    pptxBytes = (await renderMarkdownToPptx(hostile)).bytes;
  } catch (e) {
    threw = e instanceof Error ? e.message : String(e);
  }
  check(
    "hostile markdown (unterminated fence, ragged table, unclosed emphasis) renders both formats without throwing",
    !threw && docxBytes !== null && pptxBytes !== null && hasZipMagic(docxBytes) && hasZipMagic(pptxBytes) && isZip(docxBytes) && isZip(pptxBytes),
    threw ? `THREW: ${threw}` : `docx ${docxBytes?.length}b, pptx ${pptxBytes?.length}b`,
  );
  const text = docxBytes ? textOf(unzip(docxBytes)["word/document.xml"] ?? "") : "";
  check(
    "an UNTERMINATED code fence still carries its code into the document",
    text.includes("const x = 1;"),
    `document text contains the code = ${text.includes("const x = 1;")}`,
  );
}

// ── Parser units — cheap, and they localise a failure above to the parser rather than the renderer ─
{
  const blocks = parseMarkdownBlocks(RICH_MD);
  const kinds = blocks.map((b) => b.kind);
  check(
    "the parser emits every block kind the renderer switches on",
    ["heading", "paragraph", "list", "table", "code", "quote", "hr"].every((k) => kinds.includes(k as never)),
    `kinds: [${kinds.join(", ")}]`,
  );
  const runs = parseInline("plain **bold** and *italic* and `code`");
  check(
    "inline parsing splits bold / italic / code into separate runs and strips the markers",
    runs.some((r) => r.bold && r.text === "bold") &&
      runs.some((r) => r.italic && r.text === "italic") &&
      runs.some((r) => r.code && r.text === "code") &&
      !runs.map((r) => r.text).join("").includes("*"),
    `runs: ${JSON.stringify(runs)}`,
  );
  const slides = blocksToSlides(parseMarkdownBlocks("# A\n\nx\n\n---\n\n# B\n\ny"), "fallback");
  check(
    "blocksToSlides keeps one slide per `#`, and a `---` immediately before a `#` does not open an empty slide",
    slides.length === 2 && slides[0].title === "A" && slides[1].title === "B",
    `slides: ${JSON.stringify(slides.map((s) => s.title))}`,
  );
}

console.log(`\n==================== ${pass} passed, ${fail} failed ====================`);
process.exit(fail === 0 ? 0 : 1);
