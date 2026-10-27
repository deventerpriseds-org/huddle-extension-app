// WHAT:       Turns an agent's artifact output into REAL Office bytes — `.docx` (Word) and `.pptx`
//             (PowerPoint) — from either markdown (the default path) or a small structured
//             document/deck object. One entry point, `renderArtifact()`, also passes `md`/`html`
//             through untouched so every caller has exactly ONE code path to bytes.
// WHY:        Agents could only ever save markdown. The owner needs documents that open natively in
//             Word/PowerPoint (and that the OneDrive mirror can hand to Office). Producing a text
//             blob under an Office mime is the failure this replaces: it downloads, and then refuses
//             to open. The suite asserts the ZIP magic `PK\x03\x04` on every Office render precisely
//             because that is what separates a real OOXML package from a mislabelled string.
// SUPERSEDES: nothing (new capability; the markdown-only artifact path stays valid and is the "md" case)
// SUPERSEDED-BY: nothing -- current
// EVIDENCE:   scripts/artifact-render.test.ts (`npm run test:artifact-render`) — unzips the produced
//             package and asserts on the real `word/document.xml` / `ppt/slides/*.xml` payload, not
//             on the renderer's own return value.
//
// PURITY CONTRACT: input -> bytes. This module imports NOTHING that touches pg, Azure Blob, Graph,
// env secrets or request context. `docx` and `pptxgenjs` are loaded LAZILY (dynamic import) so the
// cost is paid only by a caller that actually renders Office bytes.
//
// NEVER THROWS. Every public function catches, degrades to a valid document containing the raw text,
// and reports what it fell back on in `warnings: string[]`. An agent emitting a malformed structure
// must never cost the user their work.
//
// ── THE PPTX SLIDE RULE (chosen, and applied consistently everywhere below) ──────────────────────
// A new slide starts at a LEVEL-1 HEADING (`# ...`) or at a HORIZONTAL RULE (`---` / `***` / `___`).
// Nothing else breaks a slide. The level-1 heading becomes the slide TITLE; after a `---` the next
// block becomes the title if it is a heading of ANY level, otherwise the slide is untitled and the
// content starts straight away. Deeper headings (`##`..`######`) stay INSIDE the current slide as
// bold body lines — they are section labels, not slide breaks.

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────────────────────────

export type ArtifactFormat = "md" | "html" | "docx" | "pptx";

/** A Word document, described structurally. Deliberately tiny — an LLM has to emit it from a tool schema. */
export type DocxSection =
  | { type: "heading"; text: string; level?: number }
  | { type: "paragraph"; text: string }
  | { type: "bullets"; items: string[]; ordered?: boolean }
  | { type: "table"; header?: string[]; rows: string[][] }
  | { type: "code"; text: string }
  | { type: "quote"; text: string };

export type DocxDocument = {
  title?: string;
  sections: DocxSection[];
};

/** A deck, described structurally. One slide per entry; that is the whole model. */
export type PptxSlide = {
  title?: string;
  bullets?: string[];
  notes?: string;
  table?: { header?: string[]; rows: string[][] };
};

export type PptxDeck = {
  title?: string;
  slides: PptxSlide[];
};

export type RenderedArtifact = {
  bytes: Uint8Array;
  mime: string;
  name: string;
  warnings: string[];
};

export type RenderArtifactInput = {
  /** "md" | "html" | "docx" | "pptx". Unknown values degrade to "md" with a warning. */
  format: string;
  /** Markdown (or HTML, or any text) source. Used for md/html always, and for docx/pptx when `document` is absent. */
  content?: string;
  /** Structured DocxDocument / PptxDeck. Takes precedence over `content` for docx/pptx. */
  document?: unknown;
  /** Desired file name. The extension is corrected to match `format` — never doubled. */
  name: string;
};

export const MIME_BY_FORMAT: Record<ArtifactFormat, string> = {
  md: "text/markdown; charset=utf-8",
  html: "text/html; charset=utf-8",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

const EXTENSION_BY_FORMAT: Record<ArtifactFormat, string> = {
  md: ".md",
  html: ".html",
  docx: ".docx",
  pptx: ".pptx",
};

/** Extensions we are allowed to REPLACE. Anything else is treated as part of the stem. */
const REPLACEABLE_EXTENSIONS = [".md", ".markdown", ".html", ".htm", ".txt", ".docx", ".pptx", ".doc", ".ppt"];

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Name + format helpers
// ─────────────────────────────────────────────────────────────────────────────────────────────────

export function normalizeFormat(format: unknown): { format: ArtifactFormat; warning?: string } {
  const raw = String(format ?? "").trim().toLowerCase().replace(/^\./, "");
  switch (raw) {
    case "md":
    case "markdown":
      return { format: "md" };
    case "html":
    case "htm":
      return { format: "html" };
    case "docx":
    case "doc":
    case "word":
      return { format: "docx" };
    case "pptx":
    case "ppt":
    case "powerpoint":
    case "deck":
      return { format: "pptx" };
    default:
      return { format: "md", warning: `Unknown format "${String(format)}" — rendered as markdown.` };
  }
}

/**
 * Make `name` end in the right extension for `format`.
 * "report" -> "report.docx"; "report.md" -> "report.docx"; "report.docx" -> "report.docx";
 * "q3.plan" -> "q3.plan.docx" (".plan" is not an extension we own, so it is kept).
 * NEVER produces "report.md.docx".
 */
export function ensureExtension(name: string, format: ArtifactFormat): string {
  const want = EXTENSION_BY_FORMAT[format];
  const base = String(name ?? "").trim() || "artifact";
  const lower = base.toLowerCase();
  if (lower.endsWith(want)) return base;
  for (const ext of REPLACEABLE_EXTENSIONS) {
    if (lower.endsWith(ext)) return base.slice(0, base.length - ext.length) + want;
  }
  return base + want;
}

const encoder = new TextEncoder();
const utf8 = (s: string): Uint8Array => encoder.encode(s);

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Markdown subset parser — no dependency, deliberately practical rather than spec-complete
// ─────────────────────────────────────────────────────────────────────────────────────────────────

export type MdInline = { text: string; bold?: boolean; italic?: boolean; code?: boolean };

export type MdBlock =
  | { kind: "heading"; level: number; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "list"; ordered: boolean; items: { level: number; text: string }[] }
  | { kind: "code"; lang: string; lines: string[] }
  | { kind: "quote"; lines: string[] }
  | { kind: "hr" }
  | { kind: "table"; header: string[]; rows: string[][] };

const RE_FENCE = /^\s{0,3}(```+|~~~+)\s*(\S*)\s*$/;
const RE_HR = /^ {0,3}([-*_])[ \t]*(?:\1[ \t]*){2,}$/;
const RE_HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const RE_QUOTE = /^ {0,3}>\s?(.*)$/;
const RE_LIST = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const RE_TABLE_DELIM = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

const splitTableRow = (line: string): string[] =>
  line
    .replace(/^\s*\|/, "")
    .replace(/\|\s*$/, "")
    .split("|")
    .map((c) => c.trim());

/** Parse a practical markdown subset into blocks. Anything unrecognised survives as a paragraph. */
export function parseMarkdownBlocks(md: string): MdBlock[] {
  const src = String(md ?? "").replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const lines = src.split("\n");
  const blocks: MdBlock[] = [];
  let para: string[] = [];

  const flushPara = () => {
    if (para.length) {
      blocks.push({ kind: "paragraph", text: para.join(" ").trim() });
      para = [];
    }
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) {
      flushPara();
      i++;
      continue;
    }

    // Fenced code — takes precedence over everything so its contents are never re-parsed.
    const fence = RE_FENCE.exec(line);
    if (fence) {
      flushPara();
      const marker = fence[1][0];
      const body: string[] = [];
      i++;
      while (i < lines.length && !new RegExp(`^\\s{0,3}${marker === "`" ? "```" : "~~~"}+\\s*$`).test(lines[i])) {
        body.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++; // consume the closing fence (absent at EOF — unterminated fence still renders)
      blocks.push({ kind: "code", lang: fence[2] ?? "", lines: body });
      continue;
    }

    // Horizontal rule BEFORE list: "- - -" also matches the list pattern.
    if (RE_HR.test(line)) {
      flushPara();
      blocks.push({ kind: "hr" });
      i++;
      continue;
    }

    const heading = RE_HEADING.exec(line);
    if (heading) {
      flushPara();
      blocks.push({ kind: "heading", level: heading[1].length, text: heading[2] });
      i++;
      continue;
    }

    // GFM pipe table: a row of cells followed by a delimiter row.
    if (line.includes("|") && i + 1 < lines.length && RE_TABLE_DELIM.test(lines[i + 1])) {
      flushPara();
      const header = splitTableRow(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i].trim() && lines[i].includes("|")) {
        rows.push(splitTableRow(lines[i]));
        i++;
      }
      blocks.push({ kind: "table", header, rows });
      continue;
    }

    const quote = RE_QUOTE.exec(line);
    if (quote) {
      flushPara();
      const body: string[] = [quote[1]];
      i++;
      while (i < lines.length) {
        const more = RE_QUOTE.exec(lines[i]);
        if (!more) break;
        body.push(more[1]);
        i++;
      }
      blocks.push({ kind: "quote", lines: body });
      continue;
    }

    const listStart = RE_LIST.exec(line);
    if (listStart) {
      flushPara();
      const ordered = /\d/.test(listStart[2]);
      const items: { level: number; text: string }[] = [];
      const indents: number[] = [];
      while (i < lines.length) {
        const m = RE_LIST.exec(lines[i]);
        if (!m) {
          // A non-blank, indented continuation line folds into the previous item.
          if (lines[i].trim() && /^\s{2,}/.test(lines[i]) && items.length) {
            items[items.length - 1].text += " " + lines[i].trim();
            i++;
            continue;
          }
          break;
        }
        const indent = m[1].replace(/\t/g, "  ").length;
        while (indents.length && indent < indents[indents.length - 1]) indents.pop();
        if (!indents.length || indent > indents[indents.length - 1]) indents.push(indent);
        items.push({ level: Math.min(4, indents.length - 1), text: m[3].trim() });
        i++;
      }
      blocks.push({ kind: "list", ordered, items });
      continue;
    }

    para.push(line.trim());
    i++;
  }
  flushPara();
  return blocks;
}

/** Split a line of markdown into styled runs. Handles `code`, **bold**, __bold__, *italic*, _italic_, [label](url). */
export function parseInline(src: string, depth = 0): MdInline[] {
  const text = String(src ?? "");
  const out: MdInline[] = [];
  let buf = "";
  const flush = () => {
    if (buf) out.push({ text: buf });
    buf = "";
  };
  const nest = (inner: string, flags: Omit<MdInline, "text">) => {
    const runs = depth > 4 ? [{ text: inner }] : parseInline(inner, depth + 1);
    for (const r of runs) {
      out.push({
        text: r.text,
        bold: r.bold || flags.bold,
        italic: r.italic || flags.italic,
        code: r.code || flags.code,
      });
    }
  };

  let i = 0;
  while (i < text.length) {
    const c = text[i];

    if (c === "`") {
      const end = text.indexOf("`", i + 1);
      if (end > i + 1) {
        flush();
        out.push({ text: text.slice(i + 1, end), code: true });
        i = end + 1;
        continue;
      }
    }

    if (c === "[") {
      const link = /^\[([^\]]*)\]\(([^)\s]*)[^)]*\)/.exec(text.slice(i));
      if (link) {
        flush();
        const label = link[1] || link[2];
        nest(link[2] && link[2] !== label ? `${label} (${link[2]})` : label, {});
        i += link[0].length;
        continue;
      }
    }

    if ((c === "*" || c === "_") && text[i + 1] === c) {
      const close = text.indexOf(c + c, i + 2);
      if (close > i + 1) {
        flush();
        nest(text.slice(i + 2, close), { bold: true });
        i = close + 2;
        continue;
      }
    }

    if (c === "*" || c === "_") {
      const close = text.indexOf(c, i + 1);
      if (close > i + 1) {
        flush();
        nest(text.slice(i + 1, close), { italic: true });
        i = close + 1;
        continue;
      }
    }

    buf += c;
    i++;
  }
  flush();
  return out.length ? out : [{ text: "" }];
}

/** Runs -> plain text (pptx bullets carry no inline styling). */
export const inlineToPlain = (src: string): string => parseInline(src).map((r) => r.text).join("");

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Structured input coercion — loose on the way in, strict on the way out, never fatal
// ─────────────────────────────────────────────────────────────────────────────────────────────────

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const asText = (v: unknown): string => {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
};

const asStringArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.map(asText).filter((s) => s.length > 0) : [];

function coerceTable(v: unknown): { header?: string[]; rows: string[][] } | null {
  if (!isRecord(v)) return null;
  const rowsRaw = Array.isArray(v.rows) ? v.rows : [];
  const rows = rowsRaw.map((r) => (Array.isArray(r) ? r.map(asText) : [asText(r)]));
  const header = Array.isArray(v.header) ? v.header.map(asText) : undefined;
  if (!rows.length && !header?.length) return null;
  return { header, rows };
}

/** Turn a structured DocxDocument into the same block stream markdown produces, so one renderer serves both. */
export function documentToBlocks(input: unknown, warnings: string[]): MdBlock[] {
  const blocks: MdBlock[] = [];
  if (!isRecord(input)) {
    warnings.push("Structured document was not an object — rendered its raw text instead.");
    return [{ kind: "paragraph", text: asText(input) }];
  }
  const title = typeof input.title === "string" ? input.title.trim() : "";
  if (title) blocks.push({ kind: "heading", level: 1, text: title });

  const sections = Array.isArray(input.sections) ? input.sections : [];
  if (!sections.length) warnings.push("Structured document had no sections.");

  for (const [index, raw] of sections.entries()) {
    if (!isRecord(raw)) {
      warnings.push(`Section ${index} was not an object — rendered as a paragraph.`);
      blocks.push({ kind: "paragraph", text: asText(raw) });
      continue;
    }
    const type = String(raw.type ?? "").toLowerCase();
    switch (type) {
      case "heading": {
        const level = Number(raw.level);
        blocks.push({
          kind: "heading",
          level: Number.isFinite(level) ? Math.min(6, Math.max(1, Math.round(level))) : 2,
          text: asText(raw.text),
        });
        break;
      }
      case "paragraph":
      case "text":
        blocks.push({ kind: "paragraph", text: asText(raw.text) });
        break;
      case "bullets":
      case "list": {
        const items = asStringArray(raw.items);
        if (!items.length) {
          warnings.push(`Section ${index} (${type}) had no items — skipped.`);
          break;
        }
        blocks.push({ kind: "list", ordered: raw.ordered === true, items: items.map((t) => ({ level: 0, text: t })) });
        break;
      }
      case "table": {
        const table = coerceTable(raw);
        if (!table) {
          warnings.push(`Section ${index} (table) had no rows — skipped.`);
          break;
        }
        blocks.push({ kind: "table", header: table.header ?? [], rows: table.rows });
        break;
      }
      case "code":
        blocks.push({ kind: "code", lang: asText(raw.lang), lines: asText(raw.text).split("\n") });
        break;
      case "quote":
        blocks.push({ kind: "quote", lines: asText(raw.text).split("\n") });
        break;
      default:
        warnings.push(`Section ${index} had unknown type "${type || "(missing)"}" — rendered as a paragraph.`);
        blocks.push({ kind: "paragraph", text: asText(raw.text ?? raw) });
    }
  }
  if (!blocks.length) blocks.push({ kind: "paragraph", text: "" });
  return blocks;
}

/** Coerce anything into a deck. A `{slides:[...]}` shape is honoured; anything else degrades with a warning. */
export function coerceDeck(input: unknown, warnings: string[]): PptxSlide[] {
  if (!isRecord(input)) {
    warnings.push("Structured deck was not an object — rendered its raw text on one slide.");
    return [{ title: "", bullets: [asText(input)] }];
  }
  const slidesRaw = Array.isArray(input.slides) ? input.slides : [];
  if (!slidesRaw.length) {
    warnings.push("Structured deck had no slides.");
    return [{ title: typeof input.title === "string" ? input.title : "", bullets: [] }];
  }
  const slides: PptxSlide[] = [];
  for (const [index, raw] of slidesRaw.entries()) {
    if (!isRecord(raw)) {
      warnings.push(`Slide ${index} was not an object — rendered its raw text.`);
      slides.push({ title: "", bullets: [asText(raw)] });
      continue;
    }
    slides.push({
      title: asText(raw.title ?? ""),
      bullets: asStringArray(raw.bullets ?? raw.body ?? raw.points),
      notes: raw.notes === undefined ? undefined : asText(raw.notes),
      table: coerceTable(raw.table) ?? undefined,
    });
  }
  return slides;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Markdown blocks -> slides (the `#` / `---` rule stated in the header)
// ─────────────────────────────────────────────────────────────────────────────────────────────────

const BULLET_PREFIX = ["", "– ", "· ", "· ", "· "];

export function blocksToSlides(blocks: MdBlock[], fallbackTitle: string): PptxSlide[] {
  const slides: PptxSlide[] = [];
  let current: PptxSlide | null = null;
  /** Set by a `---`: the next heading of ANY level supplies the new slide's title. */
  let awaitingTitle = false;

  const open = (title: string): PptxSlide => {
    const slide: PptxSlide = { title, bullets: [] };
    slides.push(slide);
    current = slide;
    awaitingTitle = false;
    return slide;
  };
  const body = (): PptxSlide => current ?? open(fallbackTitle);
  const addBullet = (text: string) => {
    const slide = body();
    (slide.bullets ??= []).push(text);
  };

  for (const block of blocks) {
    switch (block.kind) {
      case "hr":
        current = null;
        awaitingTitle = true;
        break;
      case "heading": {
        const text = inlineToPlain(block.text);
        if (block.level === 1 || awaitingTitle || !current) {
          open(text);
        } else {
          addBullet(text);
        }
        break;
      }
      case "paragraph": {
        const text = inlineToPlain(block.text);
        if (text) addBullet(text);
        break;
      }
      case "list":
        for (const item of block.items) {
          addBullet(BULLET_PREFIX[Math.min(item.level, BULLET_PREFIX.length - 1)] + inlineToPlain(item.text));
        }
        break;
      case "quote":
        for (const line of block.lines) {
          const text = inlineToPlain(line);
          if (text) addBullet(text);
        }
        break;
      case "code":
        for (const line of block.lines) addBullet(line);
        break;
      case "table": {
        const slide = body();
        const table = { header: block.header, rows: block.rows };
        if (slide.table) {
          // One table per slide keeps PptxSlide small; a second one continues onto its own slide.
          open(`${slide.title ?? ""}${slide.title ? " (cont.)" : ""}`).table = table;
        } else {
          slide.table = table;
        }
        break;
      }
    }
  }

  if (!slides.length) slides.push({ title: fallbackTitle, bullets: [] });
  return slides;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// DOCX
// ─────────────────────────────────────────────────────────────────────────────────────────────────

const ORDERED_REFERENCE = "md-ordered";
const CODE_FONT = "Courier New";
const CODE_FILL = "F2F2F2";
const HEADER_FILL = "EDEDED";

async function buildDocx(blocks: MdBlock[], title: string | undefined): Promise<Uint8Array> {
  const d = await import("docx");
  const {
    AlignmentType,
    BorderStyle,
    Document,
    HeadingLevel,
    LevelFormat,
    Packer,
    Paragraph,
    ShadingType,
    Table,
    TableCell,
    TableRow,
    TextRun,
    WidthType,
  } = d;

  const HEADINGS = [
    HeadingLevel.HEADING_1,
    HeadingLevel.HEADING_2,
    HeadingLevel.HEADING_3,
    HeadingLevel.HEADING_4,
    HeadingLevel.HEADING_5,
    HeadingLevel.HEADING_6,
  ];

  const runs = (text: string, extra?: { italics?: boolean }) =>
    parseInline(text).map(
      (r) =>
        new TextRun({
          text: r.text,
          bold: r.bold,
          italics: r.italic || extra?.italics,
          font: r.code ? CODE_FONT : undefined,
          shading: r.code ? { type: ShadingType.CLEAR, fill: CODE_FILL } : undefined,
        }),
    );

  const cell = (text: string, header: boolean) =>
    new TableCell({
      shading: header ? { type: ShadingType.CLEAR, fill: HEADER_FILL } : undefined,
      children: [
        new Paragraph({
          children: header ? [new TextRun({ text: inlineToPlain(text), bold: true })] : runs(text),
        }),
      ],
    });

  const children: Array<InstanceType<typeof Paragraph> | InstanceType<typeof Table>> = [];

  for (const block of blocks) {
    switch (block.kind) {
      case "heading":
        children.push(
          new Paragraph({
            heading: HEADINGS[Math.min(6, Math.max(1, block.level)) - 1],
            children: runs(block.text),
            spacing: { before: 180, after: 90 },
          }),
        );
        break;
      case "paragraph":
        children.push(new Paragraph({ children: runs(block.text), spacing: { after: 120 } }));
        break;
      case "list":
        for (const item of block.items) {
          children.push(
            new Paragraph({
              children: runs(item.text),
              ...(block.ordered
                ? { numbering: { reference: ORDERED_REFERENCE, level: item.level } }
                : { bullet: { level: item.level } }),
            }),
          );
        }
        break;
      case "code":
        for (const line of block.lines.length ? block.lines : [""]) {
          children.push(
            new Paragraph({
              shading: { type: ShadingType.CLEAR, fill: CODE_FILL },
              spacing: { after: 0 },
              children: [new TextRun({ text: line || " ", font: CODE_FONT, size: 18 })],
            }),
          );
        }
        children.push(new Paragraph({ text: "", spacing: { after: 120 } }));
        break;
      case "quote":
        for (const line of block.lines) {
          children.push(
            new Paragraph({
              children: runs(line, { italics: true }),
              indent: { left: 720 },
              spacing: { after: 60 },
            }),
          );
        }
        break;
      case "hr":
        children.push(
          new Paragraph({
            text: "",
            border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: "AAAAAA", space: 1 } },
            spacing: { after: 120 },
          }),
        );
        break;
      case "table": {
        const rows: InstanceType<typeof TableRow>[] = [];
        if (block.header.length) {
          rows.push(new TableRow({ tableHeader: true, children: block.header.map((h) => cell(h, true)) }));
        }
        const width = Math.max(block.header.length, ...block.rows.map((r) => r.length), 1);
        for (const row of block.rows) {
          const padded = Array.from({ length: width }, (_, i) => row[i] ?? "");
          rows.push(new TableRow({ children: padded.map((c) => cell(c, false)) }));
        }
        if (rows.length) {
          children.push(new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE } }));
          children.push(new Paragraph({ text: "", spacing: { after: 120 } }));
        }
        break;
      }
    }
  }

  if (!children.length) children.push(new Paragraph({ text: "" }));

  const doc = new Document({
    title,
    numbering: {
      config: [
        {
          reference: ORDERED_REFERENCE,
          levels: Array.from({ length: 5 }, (_, level) => ({
            level,
            format: LevelFormat.DECIMAL,
            text: `%${level + 1}.`,
            alignment: AlignmentType.START,
            style: { paragraph: { indent: { left: 720 * (level + 1), hanging: 360 } } },
          })),
        },
      ],
    },
    sections: [{ children }],
  });

  const buffer = await Packer.toBuffer(doc);
  return new Uint8Array(buffer);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// PPTX
// ─────────────────────────────────────────────────────────────────────────────────────────────────

const SLIDE_W = 10;
const BULLET_LINE_H = 0.32;

async function buildPptx(slides: PptxSlide[], title: string | undefined): Promise<Uint8Array> {
  const { default: PptxGenJS } = await import("pptxgenjs");
  const pptx = new PptxGenJS();
  pptx.layout = "LAYOUT_16x9";
  if (title) pptx.title = title;

  for (const slide of slides.length ? slides : [{ title: title ?? "", bullets: [] }]) {
    const s = pptx.addSlide();
    let y = 0.35;

    const slideTitle = (slide.title ?? "").trim();
    if (slideTitle) {
      s.addText(slideTitle, {
        x: 0.5,
        y,
        w: SLIDE_W - 1,
        h: 0.7,
        fontSize: 26,
        bold: true,
        color: "1F2937",
        valign: "middle",
      });
      y += 0.9;
    }

    const bullets = (slide.bullets ?? []).filter((b) => String(b ?? "").trim().length > 0);
    if (bullets.length) {
      const h = Math.min(bullets.length * BULLET_LINE_H + 0.2, 5.625 - y - 0.3);
      s.addText(
        bullets.map((text) => ({ text: String(text), options: { bullet: true, breakLine: true } })),
        { x: 0.6, y, w: SLIDE_W - 1.2, h: Math.max(h, BULLET_LINE_H), fontSize: 15, color: "374151" },
      );
      y += Math.max(h, BULLET_LINE_H) + 0.15;
    }

    if (slide.table) {
      const header = slide.table.header ?? [];
      const rows: Parameters<typeof s.addTable>[0] = [];
      if (header.length) {
        rows.push(header.map((h) => ({ text: String(h), options: { bold: true, fill: { color: "EDEDED" } } })));
      }
      const width = Math.max(header.length, ...slide.table.rows.map((r) => r.length), 1);
      for (const row of slide.table.rows) {
        rows.push(Array.from({ length: width }, (_, i) => ({ text: String(row[i] ?? "") })));
      }
      if (rows.length) {
        s.addTable(rows, {
          x: 0.5,
          y: Math.min(y, 4.6),
          w: SLIDE_W - 1,
          fontSize: 12,
          border: { type: "solid", pt: 1, color: "D1D5DB" },
        });
      }
    }

    const notes = (slide.notes ?? "").trim();
    if (notes) s.addNotes(notes);
  }

  const out = await pptx.write({ outputType: "nodebuffer" });
  if (typeof out === "string") return utf8(out);
  if (out instanceof Uint8Array) return new Uint8Array(out);
  return new Uint8Array(out as ArrayBuffer);
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Public render functions — each one catches and degrades; none throws
// ─────────────────────────────────────────────────────────────────────────────────────────────────

export type RenderBytes = { bytes: Uint8Array; warnings: string[] };

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Markdown -> .docx bytes. Falls back to a plain-text document carrying the raw markdown. */
export async function renderMarkdownToDocx(md: string, opts?: { title?: string }): Promise<RenderBytes> {
  const warnings: string[] = [];
  const source = String(md ?? "");
  try {
    return { bytes: await buildDocx(parseMarkdownBlocks(source), opts?.title), warnings };
  } catch (e) {
    warnings.push(`Markdown could not be laid out (${errText(e)}) — the raw text was written instead.`);
    return { bytes: await rawTextDocx(source, opts?.title, warnings), warnings };
  }
}

/** Markdown -> .pptx bytes. `#` or `---` starts a new slide (see the file header). */
export async function renderMarkdownToPptx(md: string, opts?: { title?: string }): Promise<RenderBytes> {
  const warnings: string[] = [];
  const source = String(md ?? "");
  try {
    const slides = blocksToSlides(parseMarkdownBlocks(source), opts?.title ?? "");
    return { bytes: await buildPptx(slides, opts?.title), warnings };
  } catch (e) {
    warnings.push(`Markdown could not be laid out (${errText(e)}) — the raw text was written instead.`);
    return { bytes: await rawTextPptx(source, opts?.title, warnings), warnings };
  }
}

/** Structured DocxDocument -> .docx bytes. A malformed shape degrades, section by section. */
export async function renderDocumentToDocx(document: unknown, opts?: { title?: string }): Promise<RenderBytes> {
  const warnings: string[] = [];
  try {
    const blocks = documentToBlocks(document, warnings);
    const title = opts?.title ?? (isRecord(document) && typeof document.title === "string" ? document.title : undefined);
    return { bytes: await buildDocx(blocks, title), warnings };
  } catch (e) {
    warnings.push(`Structured document could not be rendered (${errText(e)}) — its raw text was written instead.`);
    return { bytes: await rawTextDocx(asText(document), opts?.title, warnings), warnings };
  }
}

/** Structured PptxDeck -> .pptx bytes. */
export async function renderDeckToPptx(deck: unknown, opts?: { title?: string }): Promise<RenderBytes> {
  const warnings: string[] = [];
  try {
    const slides = coerceDeck(deck, warnings);
    const title = opts?.title ?? (isRecord(deck) && typeof deck.title === "string" ? deck.title : undefined);
    return { bytes: await buildPptx(slides, title), warnings };
  } catch (e) {
    warnings.push(`Structured deck could not be rendered (${errText(e)}) — its raw text was written instead.`);
    return { bytes: await rawTextPptx(asText(deck), opts?.title, warnings), warnings };
  }
}

/** Last-resort document: one paragraph per line of the raw text. */
async function rawTextDocx(text: string, title: string | undefined, warnings: string[]): Promise<Uint8Array> {
  try {
    const lines = String(text ?? "").split("\n");
    return await buildDocx(
      lines.map((line) => ({ kind: "paragraph", text: line }) as MdBlock),
      title,
    );
  } catch (e) {
    warnings.push(`Word rendering is unavailable (${errText(e)}).`);
    return utf8(String(text ?? ""));
  }
}

/** Last-resort deck: the raw text chunked onto slides so nothing is lost. */
async function rawTextPptx(text: string, title: string | undefined, warnings: string[]): Promise<Uint8Array> {
  try {
    const lines = String(text ?? "").split("\n").filter((l) => l.trim().length > 0);
    const slides: PptxSlide[] = [];
    for (let i = 0; i < Math.max(lines.length, 1); i += 12) {
      slides.push({ title: title ?? "", bullets: lines.slice(i, i + 12) });
    }
    return await buildPptx(slides, title);
  } catch (e) {
    warnings.push(`PowerPoint rendering is unavailable (${errText(e)}).`);
    return utf8(String(text ?? ""));
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// THE ONE ENTRY POINT
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Render an artifact to bytes. This is the ONLY function a caller needs: md/html pass straight
 * through as UTF-8, docx/pptx become real OOXML packages. It never throws — check `warnings`.
 */
export async function renderArtifact(input: RenderArtifactInput): Promise<RenderedArtifact> {
  const warnings: string[] = [];
  let format: ArtifactFormat = "md";
  let name = "artifact";

  try {
    const normalized = normalizeFormat(input?.format);
    format = normalized.format;
    if (normalized.warning) warnings.push(normalized.warning);

    name = ensureExtension(input?.name ?? "artifact", format);
    const content = typeof input?.content === "string" ? input.content : input?.content === undefined ? "" : asText(input.content);
    const structured = input?.document;
    const hasStructured = structured !== undefined && structured !== null;

    if (format === "md" || format === "html") {
      if (!content) warnings.push("No content supplied — an empty file was produced.");
      return { bytes: utf8(content), mime: MIME_BY_FORMAT[format], name, warnings };
    }

    if (!hasStructured && !content) {
      warnings.push("No content or document supplied — an empty document was produced.");
    }

    const title = stripExtension(name);
    const result =
      format === "docx"
        ? hasStructured
          ? await renderDocumentToDocx(structured, { title })
          : await renderMarkdownToDocx(content, { title })
        : hasStructured
          ? await renderDeckToPptx(structured, { title })
          : await renderMarkdownToPptx(content, { title });

    warnings.push(...result.warnings);

    // A degraded render that could not produce a package must not masquerade as one.
    if (!isZip(result.bytes)) {
      warnings.push(`Could not produce a valid ${format.toUpperCase()} package — the raw text was returned as plain text.`);
      return {
        bytes: result.bytes,
        mime: "text/plain; charset=utf-8",
        name: stripExtension(name) + ".txt",
        warnings,
      };
    }

    return { bytes: result.bytes, mime: MIME_BY_FORMAT[format], name, warnings };
  } catch (e) {
    // Belt and braces: nothing above is allowed to reach here, and if it somehow does the caller
    // still gets the user's text back rather than an exception.
    warnings.push(`Rendering failed (${errText(e)}) — the raw text was returned as plain text.`);
    const fallback = typeof input?.content === "string" ? input.content : asText(input?.document ?? "");
    return {
      bytes: utf8(fallback),
      mime: "text/plain; charset=utf-8",
      name: stripExtension(name) + ".txt",
      warnings,
    };
  }
}

/** True when `bytes` begins with the ZIP local-file-header magic — i.e. it really is an OOXML package. */
export function isZip(bytes: Uint8Array): boolean {
  return bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

function stripExtension(name: string): string {
  const base = String(name ?? "");
  const lower = base.toLowerCase();
  for (const ext of REPLACEABLE_EXTENSIONS) {
    if (lower.endsWith(ext)) return base.slice(0, base.length - ext.length);
  }
  return base;
}
