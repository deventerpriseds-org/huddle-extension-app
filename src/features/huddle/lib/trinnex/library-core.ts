// WHAT:       the PURE rules of the Trinnex Library (no pg, no blob, no React): which files are accepted, what
//             Type a file gets, which Category is suggested, the 25 MB cap, the processing steps, transcript
//             (vtt/srt) cue parsing with speakers, and the passage splitter that keeps every passage under the
//             embedding cap without losing text. Imported by BOTH the browser view and the server worker, so the
//             form and the server can never disagree about a rule.
// WHY:        AC-trinnex-workspace.md section 2 (AC-L1, L2, L3, L5, L6, L9, L11, L12) and decision Q5 (25 MB).
// SUPERSEDES: the prototype's inline rules in docs/trinnex/prototype/library.html (never shipped).
// SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   scripts/trinnex-library.test.ts; docs/qc-evidence/BUILD-trinnex-library.md.

/** The eight accepted extensions (AC-L1). Compared lower-case, so `.PDF` is accepted. */
export const ACCEPTED_EXTS = ["pdf", "docx", "pptx", "xlsx", "txt", "md", "vtt", "srt"] as const;
export type AcceptedExt = (typeof ACCEPTED_EXTS)[number];

/** Decision Q5: 25 MB per upload, refused BEFORE upload (AC-L12) and re-checked on the server. */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/** The embedding input is truncated at 8000 chars (lib/rag/embed.server.ts:18). Passages stay under this with
 *  margin, so no tail is ever silently not embedded (AC-L9). */
export const PASSAGE_MAX_CHARS = 7000;

export type LibraryKind = "document" | "transcript";

/** The five steps, in order, exactly as the approved prototype labels them (library.html:272, AC-L6). */
export const STEPS = ["Uploaded", "Read", "Split into passages", "Facts pulled out", "Searchable"] as const;

/** Server-side status values. `waiting_memory` = text is read but the Trinnex DB is not set up yet. */
export type LibraryStatus =
  | "uploaded"
  | "read"
  | "split"
  | "facts"
  | "searchable"
  | "waiting_memory"
  | "failed"
  | "removing"
  | "remove_incomplete";

/** Status -> index of the step it has reached (for the stepper). Failed / waiting have their own labels. */
export function stepIndex(s: LibraryStatus): number {
  switch (s) {
    case "uploaded":
      return 0;
    case "read":
      return 1;
    case "split":
      return 2;
    case "facts":
      return 3;
    case "searchable":
      return 4;
    case "waiting_memory":
      return 2;
    default:
      return -1;
  }
}

/** True while the server still has work to do (the view polls only then). */
export function isInFlight(s: LibraryStatus): boolean {
  return s === "uploaded" || s === "read" || s === "split" || s === "facts" || s === "removing";
}

/** Reason codes a failed item can carry. Codes only: they are logged and shown, never file text (AC-C4). */
export type FailReason =
  | "unsupported_type"
  | "type_mismatch"
  | "too_large"
  | "no_readable_text"
  | "protected_file"
  | "corrupt_file"
  | "storage_error"
  | "ai_quota"
  | "no_api_key"
  | "ingest_error";

export const FAIL_LABEL: Record<FailReason, string> = {
  unsupported_type: "unsupported type",
  type_mismatch: "file content does not match its type",
  too_large: "over 25 MB",
  no_readable_text: "no readable text",
  protected_file: "protected file",
  corrupt_file: "file could not be read",
  storage_error: "storage error",
  ai_quota: "AI quota",
  no_api_key: "AI key not set",
  ingest_error: "memory error",
};

/** AC-C5: a fact-extraction failure on an otherwise searchable item is stored as `facts:<kind>` in fail_reason
 *  (the kind is "429 insufficient_quota", "500", "timeout": status + provider code, never message text). */
export const FACTS_QUOTA_TEXT = "Facts not extracted: AI quota exhausted";
/** AC-C5 (verifier loop 1): a missing OpenAI key is shown, never a silent "0 facts". */
export const FACTS_NO_KEY_TEXT = "Facts not extracted: AI key not set";
export const isQuotaKind = (kind: string | null | undefined): boolean => /insufficient_quota/.test(kind ?? "");
export const factsFailReason = (kind: string): string => `facts:${kind}`.slice(0, 80);
/** The owner-facing notice for a stored fact failure, or null when facts were extracted. Used by the Library and
 *  Meetings items alike. */
export function factsFailureNotice(stored: string | null | undefined): string | null {
  if (!stored || !stored.startsWith("facts:")) return null;
  const kind = stored.slice("facts:".length);
  if (kind === "no_api_key") return FACTS_NO_KEY_TEXT;
  return isQuotaKind(kind) ? FACTS_QUOTA_TEXT : `Facts not extracted (${kind || "error"})`;
}

/** Pure: lower-case extension of a file name, "" when there is none (an extensionless file is rejected). */
export function extOf(name: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(String(name ?? ""));
  return m ? m[1].toLowerCase() : "";
}

/** Pure (AC-L1): is this name one of the eight types? `.PDF.exe` -> "exe" -> no; `.doc` -> no. */
export function isAcceptedName(name: string): boolean {
  return (ACCEPTED_EXTS as readonly string[]).includes(extOf(name));
}

/** Pure (AC-L1): split a drop into accepted and rejected names, keeping order. */
export function partitionFiles<T extends { name: string }>(files: readonly T[]): { accepted: T[]; rejected: string[] } {
  const accepted: T[] = [];
  const rejected: string[] = [];
  for (const f of files) {
    if (isAcceptedName(f.name)) accepted.push(f);
    else rejected.push(f.name);
  }
  return { accepted, rejected };
}

/** Pure (AC-L2): the automatic Type. vtt/srt -> transcript; md/txt named "...transcript..." -> transcript. */
export function guessKind(name: string): LibraryKind {
  const e = extOf(name);
  if (e === "vtt" || e === "srt") return "transcript";
  if ((e === "md" || e === "txt") && String(name).toLowerCase().includes("transcript")) return "transcript";
  return "document";
}

/** Pure: a category typed by the owner -> its stored form (whitespace collapsed, max 60 chars). Empty -> "General"
 *  (library.html:642, AC-L3). */
export function cleanCategory(raw: unknown): string {
  const s = String(raw ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
  return s || "General";
}

/** Pure (AC-L3): merge category lists case-insensitively, first spelling wins, order kept. No fixed list. */
export function mergeCategories(...lists: ReadonlyArray<readonly string[]>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const l of lists)
    for (const c of l) {
      const v = String(c ?? "").replace(/\s+/g, " ").trim();
      const k = v.toLowerCase();
      if (!v || seen.has(k)) continue;
      seen.add(k);
      out.push(v);
    }
  return out;
}

/** Hints the prototype used to suggest a NEW category from the file name (library.html:263-271). */
const CATEGORY_HINTS: Array<[RegExp, string]> = [
  [/travel|expense|reimburs|per ?diem|mileage|card/, "Travel and expenses"],
  [/vendor|contract|procure|supplier|renewal/, "Vendors"],
  [/engineer|on-?call|incident|architecture|runbook/, "Engineering"],
  [/leader|weekly|sync|staff|1-?1|one-on-one/, "Leadership meetings"],
  [/\bhr\b|benefit|pto|leave|handbook|onboard/, "People and HR"],
  [/budget|forecast|finance|invoice|\bq[1-4]\b/, "Finance"],
  [/security|privacy|compliance|access/, "Security and compliance"],
];

/**
 * Pure (AC-L3): the suggested category. An EXISTING category is preferred over a new one: first, an existing
 * category whose words appear in the file name; then a hint, mapped onto an existing category of the same name
 * (case-insensitive) when there is one; else "General".
 */
export function suggestCategory(fileName: string, existing: readonly string[]): string {
  const n = String(fileName ?? "").toLowerCase().replace(/\.[a-z0-9]+$/i, "").replace(/[_.\-]+/g, " ");
  const padded = ` ${n.replace(/\s+/g, " ")} `;
  for (const c of existing) {
    const words = c.toLowerCase().split(/\s+/).filter((w) => w.length > 2 && w !== "and" && w !== "the");
    if (words.length && words.some((w) => padded.includes(` ${w} `) || padded.includes(` ${w.replace(/s$/, "")} `)))
      return c;
  }
  for (const [re, cat] of CATEGORY_HINTS) {
    if (re.test(n)) return existing.find((c) => c.toLowerCase() === cat.toLowerCase()) ?? cat;
  }
  return existing.find((c) => c.toLowerCase() === "general") ?? "General";
}

// ── Transcripts (vtt / srt) ─────────────────────────────────────────────────────────────────────────

export interface Cue {
  /** Speaker label exactly as written in the file ("" when the cue carries none). */
  speaker: string;
  /** Start time in seconds. */
  start: number;
  text: string;
}

/** Pure: "01:02:03.500" / "02:03,5" / "65.2" -> seconds. NaN-safe (returns 0). */
export function parseTimestamp(raw: string): number {
  const s = String(raw ?? "").trim().replace(",", ".");
  const parts = s.split(":").map(Number);
  if (parts.some((p) => !Number.isFinite(p))) return 0;
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}

/** Pure: "h:mm:ss" / "m:ss" for a source card. */
export function formatTimestamp(sec: number): string {
  const t = Math.max(0, Math.floor(sec));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = String(t % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

const ARROW = /^\s*(\S+)\s+-->\s+(\S+)/;

/** Pure: pull a speaker off one cue's text: WebVTT `<v Name>` voice span, else a "Name: text" prefix of at most
 *  five words. Remaining markup tags are stripped (the text is DATA, rendered as text). */
function speakerOf(text: string): { speaker: string; text: string } {
  const v = /^<v(?:\.[^\s>]*)?\s+([^>]+)>/i.exec(text);
  if (v) return { speaker: v[1].trim(), text: text.slice(v[0].length).replace(/<\/v>/gi, "").replace(/<[^>]+>/g, "").trim() };
  const clean = text.replace(/<[^>]+>/g, "").trim();
  const p = /^([^:\n]{1,60}):\s+(.+)$/s.exec(clean);
  if (p && p[1].trim().split(/\s+/).length <= 5 && !/^\d+$/.test(p[1].trim())) return { speaker: p[1].trim(), text: p[2].trim() };
  return { speaker: "", text: clean };
}

/** Pure: parse a WebVTT or SRT body into cues (both formats share the `start --> end` line). */
export function parseCues(body: string): Cue[] {
  const lines = String(body ?? "").replace(/^﻿/, "").replace(/\r\n?/g, "\n").split("\n");
  const cues: Cue[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = ARROW.exec(lines[i]);
    if (!m) continue;
    const textLines: string[] = [];
    let j = i + 1;
    for (; j < lines.length && lines[j].trim() !== ""; j++) {
      if (ARROW.test(lines[j])) break;
      textLines.push(lines[j]);
    }
    i = j - 1;
    // SRT puts a bare cue number on the line BEFORE the timing line; it was never collected (we start after it).
    const joined = textLines.join("\n").trim();
    if (!joined) continue;
    const { speaker, text } = speakerOf(joined);
    if (!text) continue;
    cues.push({ speaker, start: parseTimestamp(m[1]), text });
  }
  return cues;
}

/** Pure: a plain-text transcript ("Name: line" per line, optional leading [mm:ss]) -> cues. */
export function parseTextTranscript(body: string): Cue[] {
  const out: Cue[] = [];
  for (const raw of String(body ?? "").replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const ts = /^\[?(\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d+)?)\]?\s+/.exec(line);
    const rest = ts ? line.slice(ts[0].length) : line;
    const { speaker, text } = speakerOf(rest);
    if (!text) continue;
    const start = ts ? parseTimestamp(ts[1]) : out.length ? out[out.length - 1].start : 0;
    if (!speaker && out.length) {
      out[out.length - 1].text += `\n${text}`;
      continue;
    }
    out.push({ speaker, start, text });
  }
  return out;
}

export interface SpeakerStat {
  label: string;
  lines: number;
  /** Share of all words, 0-100. */
  talkPct: number;
  sample: string;
  sampleAt: number;
}

/** Pure (AC-L5 / AC-T10 shape): one row per distinct label (verbatim, so "Speaker 1" and "Speaker 10" stay apart). */
export function speakerStats(cues: readonly Cue[], keyOf: (raw: string) => string): SpeakerStat[] {
  const by = new Map<string, { lines: number; words: number; sample: string; at: number }>();
  let total = 0;
  for (const c of cues) {
    const k = keyOf(c.speaker);
    const w = c.text.split(/\s+/).filter(Boolean).length;
    total += w;
    const cur = by.get(k);
    if (cur) {
      cur.lines += 1;
      cur.words += w;
      if (cur.sample.length < 20 && c.text.length > cur.sample.length) {
        cur.sample = c.text;
        cur.at = c.start;
      }
    } else by.set(k, { lines: 1, words: w, sample: c.text, at: c.start });
  }
  return [...by.entries()].map(([label, v]) => ({
    label,
    lines: v.lines,
    talkPct: total ? Math.round((v.words / total) * 100) : 0,
    sample: v.sample.slice(0, 160),
    sampleAt: v.at,
  }));
}

// ── Segments and the splitter ───────────────────────────────────────────────────────────────────────

/** One unit of extracted text, before the memory lane turns it into passages. Mirrors section 10's segment. */
export interface Segment {
  text: string;
  speaker?: string | null;
  /** Timestamp for a transcript turn, "m:ss" / "h:mm:ss". */
  at?: string | null;
  /** Location label for a document: "3" (pdf/docx page), "slide 3", "sheet Budget rows 1-40". */
  page?: string | null;
}

/**
 * Pure (AC-L9): cut `text` into consecutive slices of at most `max` chars, preferring a paragraph break, then a
 * line break, then a space, in the back half of the window. Slices are EXACT substrings and concatenate back to
 * `text` byte for byte, so no text is lost between passages.
 */
export function splitText(text: string, max = PASSAGE_MAX_CHARS): string[] {
  const out: string[] = [];
  let i = 0;
  const s = String(text ?? "");
  while (i < s.length) {
    if (s.length - i <= max) {
      out.push(s.slice(i));
      break;
    }
    const window = s.slice(i, i + max);
    const floor = Math.floor(max / 2);
    let cut = -1;
    for (const sep of ["\n\n", "\n", " "]) {
      const at = window.lastIndexOf(sep);
      if (at >= floor) {
        cut = at + sep.length;
        break;
      }
    }
    if (cut <= 0) cut = max;
    out.push(s.slice(i, i + cut));
    i += cut;
  }
  return out;
}

/** Pure (AC-L9): segments whose text exceeds the cap are split; each part keeps its location and speaker.
 *  Whitespace-only segments are dropped (they carry no readable text). */
export function capSegments(segs: readonly Segment[], max = PASSAGE_MAX_CHARS): Segment[] {
  const out: Segment[] = [];
  for (const seg of segs) {
    if (!seg.text || !seg.text.trim()) continue;
    for (const part of splitText(seg.text, max)) if (part.trim()) out.push({ ...seg, text: part });
  }
  return out;
}

/**
 * Pure (AC-L2 / AC-L5): transcript cues -> one segment per speaker TURN (consecutive cues by the same mapped
 * speaker merge), each carrying the mapped speaker and the turn's first timestamp. Unmapped labels stay raw.
 */
export function turnsFromCues(
  cues: readonly Cue[],
  keyOf: (raw: string) => string,
  speakerMap: Readonly<Record<string, string>>,
): Segment[] {
  const out: Segment[] = [];
  for (const c of cues) {
    const label = keyOf(c.speaker);
    // RT-N4: own keys only (a cue labelled "constructor" must not read Object.prototype.constructor).
    const mapped = Object.prototype.hasOwnProperty.call(speakerMap, label) ? speakerMap[label] : undefined;
    const speaker = (typeof mapped === "string" ? mapped.trim() : "") || label;
    const last = out[out.length - 1];
    if (last && last.speaker === speaker && last.text.length + c.text.length + 1 <= PASSAGE_MAX_CHARS) {
      last.text += `\n${c.text}`;
      continue;
    }
    out.push({ text: c.text, speaker, at: formatTimestamp(c.start) });
  }
  return out;
}
