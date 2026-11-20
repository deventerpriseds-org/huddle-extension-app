// WHAT:       plain text out of an uploaded Library file: per PAGE for pdf/docx, per SLIDE for pptx, per SHEET
//             (row ranges) for xlsx, per CUE with speaker and timestamp for vtt/srt, whole text for txt/md. The
//             server re-checks the type from the file's own bytes before reading it.
// WHY:        AC-L1 (magic-byte check), AC-L2 (split by speaker turn vs by page), AC-L9 (location metadata, no text
//             lost), AC-L11 (empty / image-only / protected files end as a named failure, never "Searchable").
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   scripts/trinnex-library.test.ts (fixtures in scripts/fixtures/trinnex/); BUILD-trinnex-library.md.
//
// Libraries: `unpdf` 1.4.0 for PDF (pdf.js serverless build, no worker, no native deps). Office files use the
// local zip.server.ts on node:zlib. Nothing here logs file text (AC-C4): errors carry a reason CODE only.
import {
  type Cue,
  type FailReason,
  type LibraryKind,
  type Segment,
  extOf,
  parseCues,
  parseTextTranscript,
} from "./library-core";
import { ZipError, isZip, readZip } from "./zip.server";

export class ExtractError extends Error {
  constructor(public reason: FailReason) {
    super(`extract: ${reason}`);
    this.name = "ExtractError";
  }
}

export interface Extracted {
  /** Document segments (page/slide/sheet located). Empty for a transcript. */
  segments: Segment[];
  /** Transcript cues (speaker + start). Empty for a document. */
  cues: Cue[];
}

const OLE_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

function startsWith(buf: Uint8Array, bytes: readonly number[]): boolean {
  return bytes.every((b, i) => buf[i] === b);
}

/** Pure: decode bytes as strict UTF-8 text; null when the bytes are not text (NUL bytes or invalid UTF-8). */
export function asText(buf: Uint8Array): string | null {
  if (buf.includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf).replace(/^﻿/, "");
  } catch {
    return null;
  }
}

/** Pure: XML character data -> text (the five named entities plus numeric references). */
export function decodeXml(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** docx: word/document.xml, paragraphs in order, a new page at every explicit or rendered page break. */
export function docxPages(xml: string): Segment[] {
  const body = xml.replace(/<w:lastRenderedPageBreak\s*\/>/g, "<w:br w:type=\"page\"/>");
  const pages: string[][] = [[]];
  for (const p of body.split(/<\/w:p>/)) {
    const pieces = p.split(/<w:br\b[^>]*w:type="page"[^>]*\/>/);
    pieces.forEach((piece, i) => {
      if (i > 0) pages.push([]);
      const text = [...piece.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:tab\/>/g)]
        .map((m) => (m[0] === "<w:tab/>" ? "\t" : decodeXml(m[1] ?? "")))
        .join("");
      if (text.trim()) pages[pages.length - 1].push(text);
    });
  }
  return pages
    .map((lines, i) => ({ text: lines.join("\n"), page: String(i + 1) }))
    .filter((s) => s.text.trim());
}

/** pptx: ppt/slides/slideN.xml in NUMERIC order, one segment per slide, paragraphs on separate lines. */
export function pptxSlides(read: (n: string) => Buffer | null, names: readonly string[]): Segment[] {
  const slides = names
    .map((n) => /^ppt\/slides\/slide(\d+)\.xml$/.exec(n))
    .filter((m): m is RegExpExecArray => !!m)
    .sort((a, b) => Number(a[1]) - Number(b[1]));
  const out: Segment[] = [];
  for (const m of slides) {
    const xml = read(m[0])?.toString("utf8") ?? "";
    const paras = xml
      .split(/<\/a:p>/)
      .map((p) => [...p.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((t) => decodeXml(t[1])).join(""))
      .filter((t) => t.trim());
    if (paras.length) out.push({ text: paras.join("\n"), page: `slide ${m[1]}` });
  }
  return out;
}

/** Column letters of a cell ref ("BC12" -> "BC"). */
function colOf(ref: string): string {
  return /^[A-Z]+/.exec(ref)?.[0] ?? "";
}

const XLSX_ROWS_PER_SEGMENT = 50;

/** xlsx: every sheet in workbook order, rows as "a | b | c" lines, one segment per 50 rows (location "sheet <name>
 *  rows a-b"). Shared strings and inline strings are both read. */
export function xlsxSheets(read: (n: string) => Buffer | null): Segment[] {
  const wb = read("xl/workbook.xml")?.toString("utf8") ?? "";
  const rels = read("xl/_rels/workbook.xml.rels")?.toString("utf8") ?? "";
  const shared = [...(read("xl/sharedStrings.xml")?.toString("utf8") ?? "").matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) =>
    [...m[1].matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)].map((t) => decodeXml(t[1])).join(""),
  );
  const relTarget = new Map(
    [...rels.matchAll(/<Relationship\b[^>]*>/g)].map((m) => {
      const id = /Id="([^"]+)"/.exec(m[0])?.[1] ?? "";
      const target = /Target="([^"]+)"/.exec(m[0])?.[1] ?? "";
      return [id, target.replace(/^\/?xl\//, "").replace(/^\//, "")] as const;
    }),
  );
  const out: Segment[] = [];
  for (const s of wb.matchAll(/<sheet\b[^>]*>/g)) {
    const name = decodeXml(/name="([^"]*)"/.exec(s[0])?.[1] ?? "Sheet");
    const rid = /r:id="([^"]+)"/.exec(s[0])?.[1] ?? "";
    const path = relTarget.get(rid);
    if (!path) continue;
    const xml = read(`xl/${path}`)?.toString("utf8") ?? "";
    const rows: Array<{ n: number; line: string }> = [];
    for (const r of xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
      const n = Number(/r="(\d+)"/.exec(r[1])?.[1] ?? rows.length + 1);
      const cells: string[] = [];
      for (const c of r[2].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = c[1];
        const inner = c[2] ?? "";
        const t = /\bt="([^"]+)"/.exec(attrs)?.[1];
        let v = "";
        if (t === "inlineStr") v = [...inner.matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)].map((x) => decodeXml(x[1])).join("");
        else {
          const raw = /<v>([^<]*)<\/v>/.exec(inner)?.[1];
          if (raw == null) continue;
          v = t === "s" ? (shared[Number(raw)] ?? "") : decodeXml(raw);
        }
        if (v.trim()) cells.push(`${colOf(/r="([A-Z]+\d+)"/.exec(attrs)?.[1] ?? "")}: ${v}`.replace(/^: /, ""));
      }
      if (cells.length) rows.push({ n, line: cells.join(" | ") });
    }
    for (let i = 0; i < rows.length; i += XLSX_ROWS_PER_SEGMENT) {
      const part = rows.slice(i, i + XLSX_ROWS_PER_SEGMENT);
      out.push({
        text: part.map((r) => r.line).join("\n"),
        page: `sheet ${name} rows ${part[0].n}-${part[part.length - 1].n}`,
      });
    }
  }
  return out;
}

async function pdfPages(buf: Uint8Array): Promise<Segment[]> {
  const { extractText, getDocumentProxy } = await import("unpdf");
  let pdf;
  try {
    pdf = await getDocumentProxy(new Uint8Array(buf));
  } catch (e) {
    const name = String((e as { name?: string })?.name ?? "");
    if (/Password/i.test(name) || /password/i.test(String((e as Error)?.message))) throw new ExtractError("protected_file");
    throw new ExtractError("corrupt_file");
  }
  const { text } = await extractText(pdf, { mergePages: false });
  return text.map((t, i) => ({ text: t, page: String(i + 1) })).filter((s) => s.text.trim());
}

const OFFICE_MARKER: Record<string, string> = {
  docx: "word/document.xml",
  pptx: "ppt/presentation.xml",
  xlsx: "xl/workbook.xml",
};

/**
 * Read a file into segments (documents) or cues (transcripts). Throws ExtractError with a reason code:
 *  - type_mismatch: the bytes are not what the extension says (AC-L1: a ".pdf" that is really a zip).
 *  - protected_file: password-protected PDF or encrypted Office file (stored as an OLE container) (AC-L11).
 *  - no_readable_text: empty, whitespace-only, or an image-only PDF with no text layer (AC-L11).
 *  - corrupt_file: the container could not be parsed.
 */
export async function extractFile(name: string, bytes: Uint8Array, kind: LibraryKind): Promise<Extracted> {
  const ext = extOf(name);
  let segments: Segment[] = [];
  let cues: Cue[] = [];
  if (ext === "pdf") {
    if (!startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) throw new ExtractError("type_mismatch"); // %PDF-
    segments = await pdfPages(bytes);
  } else if (ext === "docx" || ext === "pptx" || ext === "xlsx") {
    if (startsWith(bytes, OLE_MAGIC)) throw new ExtractError("protected_file");
    if (!isZip(bytes)) throw new ExtractError("type_mismatch");
    try {
      const z = readZip(bytes);
      const names = z.entries.map((e) => e.name);
      if (!names.includes(OFFICE_MARKER[ext])) throw new ExtractError("type_mismatch");
      if (ext === "docx") segments = docxPages(z.read("word/document.xml")?.toString("utf8") ?? "");
      else if (ext === "pptx") segments = pptxSlides(z.read, names);
      else segments = xlsxSheets(z.read);
    } catch (e) {
      if (e instanceof ExtractError) throw e;
      if (e instanceof ZipError) throw new ExtractError(e.code === "encrypted" ? "protected_file" : "corrupt_file");
      throw new ExtractError("corrupt_file");
    }
  } else if (ext === "txt" || ext === "md" || ext === "vtt" || ext === "srt") {
    const text = asText(bytes);
    if (text == null) throw new ExtractError("type_mismatch");
    if (ext === "vtt" || ext === "srt") {
      if (!/-->/.test(text)) throw new ExtractError(text.trim() ? "type_mismatch" : "no_readable_text");
      cues = parseCues(text);
    } else if (kind === "transcript") cues = parseTextTranscript(text);
    else segments = text.trim() ? [{ text, page: null }] : [];
  } else throw new ExtractError("unsupported_type");
  if (!segments.length && !cues.length) throw new ExtractError("no_readable_text");
  // A document the owner re-typed as a transcript (or the reverse) still reads: keep what was found.
  return { segments, cues };
}
