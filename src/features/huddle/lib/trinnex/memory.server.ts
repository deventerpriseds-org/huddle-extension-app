// WHAT:          The Trinnex memory lane contract (AC doc §10): ingestTrinnexSource, deleteTrinnexSource,
//                trinnexConfigured -- plus searchTrinnex / dispatchTrinnexTool for the search_trinnex tool.
//                Everything runs against the SEPARATE Trinnex database through the SAME store code as personal
//                memory (createRagStore over getTrinnexPool, AC-M3). Nothing here touches the shared pool.
// WHY:           Owner decision "A" (2026-11-20): work material in its own database, searchable only by
//                iris-chase and eli-vaughn, with cited answers. Tier 1: stores model output (facts).
// SUPERSEDES:    the MEETINGS/LIBRARY lanes' local stubs with the same three signatures.
// SUPERSEDED-BY: nothing -- current.
// EVIDENCE:      scripts/trinnex-memory.test.ts; docs/qc-evidence/BUILD-trinnex-memory.md.
//
// LOGGING (AC-C4): ids, counts, step names and error CODES only. Never passage text, titles or names.

import { createRagStore, RagStoreUnavailableError, type PoolLike } from "../rag/azure-pg.server";
import { getTrinnexPool, trinnexPgConfigured } from "../db/shared-pool.server";
import { embed as realEmbed } from "../rag/embed.server";
import { extractTriples as realExtractTriples } from "../rag/triples.server";
import { chunkText } from "../rag/chunk";
import type { ChunkRow, RagStore } from "../rag/types";
import { AGENT_BY_ID, type AgentId } from "../../data/agents";
import {
  TRINNEX_LIBRARY_HINT,
  TRINNEX_MIN_SCORE,
  TRINNEX_MISS_TEXT,
  agentHasTrinnexAccess,
  recencyFromQuestion,
  selectSources,
  type CatalogEntry,
  type SourceFilters,
} from "./search";

// ── contract types (§10) ─────────────────────────────────────────────────────────────────────────────

export type TrinnexSourceKind = "meeting" | "upload";

export interface TrinnexSegment {
  text: string;
  speaker?: string | null;
  at?: string | null;
  page?: string | null;
}

export interface TrinnexIngestInput {
  sourceId: string;
  sourceKind: TrinnexSourceKind;
  title: string;
  date: string | null;
  series?: string | null;
  category?: string | null;
  participants: string[];
  segments: TrinnexSegment[];
}

// ── dependencies (injectable for tests; no test ever reaches a live DB or model) ─────────────────────

interface Deps {
  getPool: () => PoolLike;
  configured: () => boolean;
  embed: (text: string) => Promise<number[]>;
  extractTriples: (text: string) => Promise<Array<{ subject: string; predicate: string; object: string; confidence: number }>>;
}
const REAL: Deps = {
  getPool: getTrinnexPool,
  configured: trinnexPgConfigured,
  embed: realEmbed,
  extractTriples: realExtractTriples,
};
let deps: Deps = REAL;
let _store: RagStore | null = null;

/** TEST ONLY: swap the pool / embed / extract. Pass null to restore the real ones. */
export function __setTrinnexDepsForTest(d: Partial<Deps> | null): void {
  deps = d ? { ...REAL, ...d } : REAL;
  _store = null;
}

function store(): RagStore {
  if (_store) return _store;
  _store = createRagStore({
    getPool: () => deps.getPool(),
    label: "Trinnex Postgres",
    bootstrap: async () => {
      throw new RagStoreUnavailableError("Trinnex bootstrap runs from bootstrap-trinnex-db.yml, never from the app");
    },
    ping: async () => {
      try {
        const r = await deps.getPool().query("SELECT version() AS v");
        return { ok: true as const, version: String((r.rows[0] as { v?: unknown })?.v ?? ""), extensions: [] };
      } catch (e) {
        return { ok: false as const, error: (e as { code?: string })?.code ?? "query_failed" };
      }
    },
  });
  return _store;
}

export class TrinnexNotConfiguredError extends Error {
  constructor() {
    super("Trinnex memory is not set up yet");
    this.name = "TrinnexNotConfiguredError";
  }
}

/** False while the Trinnex DB connection is absent. Callers then skip ingestion. Never throws. */
export function trinnexConfigured(): boolean {
  try {
    return deps.configured();
  } catch {
    return false;
  }
}

export function trinnexSourceKey(kind: TrinnexSourceKind, sourceId: string): string {
  return `trinnex:${kind}:${sourceId}`;
}

// ── chunking ─────────────────────────────────────────────────────────────────────────────────────────

/** Passage target. Well under the embed cap (embed.server.ts truncates input at 8000 chars, AC-L9). */
export const TRINNEX_PASSAGE_CHARS = 1800;
export const EMBED_INPUT_CAP = 8000;

export interface TrinnexPassage {
  text: string;
  speaker: string | null;
  at: string | null;
  page: string | null;
}

const clean = (s: string | null | undefined) => {
  const t = (s ?? "").trim();
  return t ? t : null;
};

/**
 * Transcript (any segment has a speaker): consecutive lines by the SAME speaker form one turn and stay
 * together; a passage never mixes two speakers, and carries that speaker and the turn's first `at`. A turn
 * longer than a passage is split (each part keeps speaker + the `at` of the line it starts at).
 * Document: segments are grouped by page and split per page; each passage carries its page.
 */
export function chunkTrinnexSegments(segments: TrinnexSegment[]): { kind: "transcript" | "document"; passages: TrinnexPassage[] } {
  const segs = segments.filter((s) => (s.text ?? "").trim().length > 0);
  const isTranscript = segs.some((s) => clean(s.speaker) !== null);
  const passages: TrinnexPassage[] = [];
  if (isTranscript) {
    let cur: { speaker: string | null; lines: TrinnexSegment[] } | null = null;
    const turns: Array<{ speaker: string | null; lines: TrinnexSegment[] }> = [];
    for (const s of segs) {
      const sp = clean(s.speaker);
      if (cur && cur.speaker === sp) cur.lines.push(s);
      else {
        cur = { speaker: sp, lines: [s] };
        turns.push(cur);
      }
    }
    for (const turn of turns) {
      let buf = "";
      let bufAt: string | null = null;
      const flush = () => {
        if (buf) passages.push({ text: buf, speaker: turn.speaker, at: bufAt, page: null });
        buf = "";
        bufAt = null;
      };
      for (const line of turn.lines) {
        const text = line.text.trim();
        if (text.length > TRINNEX_PASSAGE_CHARS) {
          flush();
          for (const part of chunkText(text, { maxChars: TRINNEX_PASSAGE_CHARS, overlap: 0 })) {
            passages.push({ text: part, speaker: turn.speaker, at: clean(line.at), page: null });
          }
          continue;
        }
        if (buf && buf.length + 1 + text.length > TRINNEX_PASSAGE_CHARS) flush();
        if (!buf) bufAt = clean(line.at);
        buf = buf ? `${buf}\n${text}` : text;
      }
      flush();
    }
    return { kind: "transcript", passages };
  }
  const byPage: Array<{ page: string | null; texts: string[] }> = [];
  for (const s of segs) {
    const pg = clean(s.page);
    const last = byPage[byPage.length - 1];
    if (last && last.page === pg) last.texts.push(s.text.trim());
    else byPage.push({ page: pg, texts: [s.text.trim()] });
  }
  for (const g of byPage) {
    for (const part of chunkText(g.texts.join("\n\n"), { maxChars: TRINNEX_PASSAGE_CHARS, overlap: 0 })) {
      passages.push({ text: part, speaker: null, at: null, page: g.page });
    }
  }
  return { kind: "document", passages };
}

// ── facts (AC-M8) ────────────────────────────────────────────────────────────────────────────────────

/** Caps for a stored Trinnex fact. Model output is DATA: anything empty or oversized is dropped. */
export const FACT_CAPS = { subject: 200, predicate: 200, object: 1000 } as const;

export function validFact(t: { subject?: unknown; predicate?: unknown; object?: unknown }): boolean {
  const ok = (v: unknown, cap: number) => typeof v === "string" && v.trim().length > 0 && v.length <= cap;
  return ok(t.subject, FACT_CAPS.subject) && ok(t.predicate, FACT_CAPS.predicate) && ok(t.object, FACT_CAPS.object);
}

// ── ingest / delete (§10) ────────────────────────────────────────────────────────────────────────────

/**
 * Idempotent per sourceId: deletes that source's passages AND facts first, so a re-ingest replaces, never
 * duplicates. Supersede is never used (decision Q3: two sources that disagree are both kept and cited).
 * Facts are stored with scope='agent' and agent_id = the passage source, so each source's facts are their
 * own rows in the shared dedup key (a fact asserted by two sources is two rows, and deleting one source
 * cannot take the other's fact with it).
 */
export async function ingestTrinnexSource(input: TrinnexIngestInput): Promise<{ chunks: number; facts: number }> {
  if (!trinnexConfigured()) throw new TrinnexNotConfiguredError();
  if (!input.sourceId?.trim()) throw new Error("sourceId is required");
  const source = trinnexSourceKey(input.sourceKind, input.sourceId);
  await deleteTrinnexSource(input.sourceId);

  const { kind, passages } = chunkTrinnexSegments(input.segments);
  const chunkIds = new Set<string>();
  const written: Array<{ id: string; text: string }> = [];
  for (const p of passages) {
    const vec = await deps.embed(p.text);
    const metadata: Record<string, unknown> = {
      sourceId: input.sourceId,
      kind,
      sourceKind: input.sourceKind,
      title: input.title,
      date: input.date,
      series: clean(input.series),
      category: clean(input.category),
      participants: input.participants ?? [],
      speaker: p.speaker,
      at: p.at,
      page: p.page,
    };
    const { id } = await store().writeChunk({ scope: "global", text: p.text, source, metadata, embedding: vec });
    if (!chunkIds.has(id)) {
      chunkIds.add(id);
      written.push({ id, text: p.text });
    }
  }

  let facts = 0;
  for (const w of written) {
    const triples = (await deps.extractTriples(w.text)).filter(validFact);
    if (triples.length === 0) continue;
    const res = await store().writeTriples(
      triples.map((t) => ({
        scope: "agent" as const,
        agentId: source,
        subject: t.subject.trim(),
        predicate: t.predicate.trim(),
        object: t.object.trim(),
        confidence: typeof t.confidence === "number" ? t.confidence : 0.8,
        sourceChunkId: w.id,
        supersede: false,
      })),
    );
    facts += res.ids.length;
  }
  console.info(`[trinnex] ingest source_kind=${input.sourceKind} passages=${chunkIds.size} facts=${facts}`);
  return { chunks: chunkIds.size, facts };
}

/**
 * Deletes the source's facts FIRST, explicitly, superseded ones included -- rag_triples.source_chunk_id is
 * ON DELETE SET NULL (azure-pg.server.ts BOOTSTRAP_SQL), so deleting passages alone would ORPHAN the facts
 * and leave them searchable (AC-L7). Then the passages. A failure between the two leaves passages only,
 * and a retry finishes the job (AC-L8).
 */
export async function deleteTrinnexSource(sourceId: string): Promise<{ chunks: number; facts: number }> {
  if (!trinnexConfigured()) throw new TrinnexNotConfiguredError();
  const sources = [trinnexSourceKey("meeting", sourceId), trinnexSourceKey("upload", sourceId)];
  const pool = deps.getPool();
  try {
    const f = await pool.query(
      `DELETE FROM rag_triples
        WHERE agent_id = ANY($1::text[])
           OR source_chunk_id IN (SELECT id FROM rag_chunks WHERE source = ANY($1::text[]))
        RETURNING id`,
      [sources],
    );
    const c = await pool.query(`DELETE FROM rag_chunks WHERE source = ANY($1::text[]) RETURNING id`, [sources]);
    return { chunks: c.rows.length, facts: f.rows.length };
  } catch (err) {
    console.error(`[trinnex] delete failed code=${(err as { code?: string })?.code ?? "unknown"}`);
    throw new RagStoreUnavailableError("Trinnex delete failed", err);
  }
}

// ── search (search_trinnex) ──────────────────────────────────────────────────────────────────────────

export interface TrinnexCitation {
  title: string | null;
  date: string | null;
  speaker: string | null;
  at: string | null;
  page: string | null;
  quote: string;
  sourceId: string | null;
  kind: string | null;
  score: number;
}

export type TrinnexSearchResult =
  | { status: "ok"; results: TrinnexCitation[] }
  | { status: "miss"; message: string; hint: string }
  | { status: "ambiguous"; field: string; options: string[]; message: string }
  | { status: "unavailable"; message: string };

export const TRINNEX_UNAVAILABLE_TEXT =
  "Trinnex memory is unavailable right now. Say so. Do not answer from general knowledge as if it were sourced, and do not use personal memory instead.";
export const TRINNEX_NOT_SET_UP_TEXT = "Trinnex memory is not set up yet. Say so; do not answer from personal memory instead.";

const QUOTE_CAP = 600;

async function loadCatalog(pool: PoolLike): Promise<CatalogEntry[]> {
  const { rows } = await pool.query(
    `SELECT source, metadata FROM rag_chunks WHERE source LIKE 'trinnex:%'`,
  );
  const by = new Map<string, CatalogEntry>();
  for (const r of rows as Array<{ source: string; metadata: Record<string, unknown> | null }>) {
    const m = r.metadata ?? {};
    let e = by.get(r.source);
    if (!e) {
      e = {
        source: r.source,
        title: typeof m.title === "string" ? m.title : null,
        firefliesTitle: typeof m.fireflies_title === "string" ? m.fireflies_title : null,
        date: typeof m.date === "string" ? m.date : null,
        series: typeof m.series === "string" ? m.series : null,
        participants: Array.isArray(m.participants) ? m.participants.filter((x): x is string => typeof x === "string") : [],
        speakers: [],
      };
      by.set(r.source, e);
    }
    if (typeof m.speaker === "string" && !e.speakers.includes(m.speaker)) e.speakers.push(m.speaker);
  }
  return [...by.values()];
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : undefined;
}
function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

export async function searchTrinnex(args: Record<string, unknown>, now = new Date()): Promise<TrinnexSearchResult> {
  if (!trinnexConfigured()) return { status: "unavailable", message: TRINNEX_NOT_SET_UP_TEXT };
  const query = str(args.query) ?? str(args.question) ?? "";
  if (!query) return { status: "miss", message: TRINNEX_MISS_TEXT, hint: TRINNEX_LIBRARY_HINT };
  try {
    const recency = num(args.most_recent)
      ? { mostRecent: num(args.most_recent), skip: num(args.skip_recent) }
      : recencyFromQuestion(str(args.question), now) ?? {};
    const filters: SourceFilters = {
      speaker: str(args.speaker),
      series: str(args.series),
      participants: Array.isArray(args.participants)
        ? args.participants.filter((x): x is string => typeof x === "string" && x.trim().length > 0)
        : undefined,
      title: str(args.title),
      dateFrom: str(args.date_from) ?? recency.dateFrom,
      dateTo: str(args.date_to) ?? recency.dateTo,
      mostRecent: recency.mostRecent,
      skip: recency.skip,
    };
    const pool = deps.getPool();
    const needsCatalog = Object.values(filters).some((v) => v !== undefined && !(Array.isArray(v) && v.length === 0));
    const sel = needsCatalog ? selectSources(await loadCatalog(pool), filters) : ({ kind: "all" } as const);
    if (sel.kind === "ambiguous") {
      return {
        status: "ambiguous",
        field: sel.field,
        options: sel.options,
        message: `More than one ${sel.field} matches. Ask the owner which one they mean.`,
      };
    }
    if (sel.kind === "none") return { status: "miss", message: TRINNEX_MISS_TEXT, hint: TRINNEX_LIBRARY_HINT };

    const queryVec = await deps.embed(query);
    const rows: ChunkRow[] = await store().searchChunks({
      query,
      queryVec,
      k: 8,
      scope: "global",
      withMetadata: true,
      sources: sel.kind === "sources" ? sel.sources : undefined,
      metadataMatch: sel.kind === "sources" && sel.speaker ? { speaker: sel.speaker } : undefined,
    });
    const hits = rows.filter((r) => (r.score ?? 0) >= TRINNEX_MIN_SCORE && (r.source ?? "").startsWith("trinnex:"));
    console.info(`[trinnex] search candidates=${rows.length} cited=${hits.length} filtered=${sel.kind === "sources"}`);
    if (hits.length === 0) return { status: "miss", message: TRINNEX_MISS_TEXT, hint: TRINNEX_LIBRARY_HINT };
    return {
      status: "ok",
      results: hits.map((r) => {
        const m = r.metadata ?? {};
        const s = (k: string) => (typeof m[k] === "string" ? (m[k] as string) : null);
        return {
          title: s("title"),
          date: s("date"),
          speaker: s("speaker"),
          at: s("at"),
          page: s("page"),
          // Verbatim prefix of the stored passage, so the quote is always a substring of it (AC-M13).
          quote: r.text.slice(0, QUOTE_CAP),
          sourceId: s("sourceId"),
          kind: s("kind"),
          score: r.score ?? 0,
        };
      }),
    };
  } catch (err) {
    console.error(`[trinnex] search failed code=${(err as { code?: string })?.code ?? "unknown"}`);
    return { status: "unavailable", message: TRINNEX_UNAVAILABLE_TEXT };
  }
}

/**
 * The search_trinnex executor. Re-checks the data gate itself, so a tool call that reached here for any
 * agent without `trinnexAccess` is refused before the Trinnex pool is ever touched (AC-M7).
 */
export async function dispatchTrinnexTool(agentId: string, args: Record<string, unknown>): Promise<string> {
  if (!agentHasTrinnexAccess(AGENT_BY_ID[agentId as AgentId])) {
    return JSON.stringify({ error: "search_trinnex is not available to this agent" });
  }
  return JSON.stringify(await searchTrinnex(args));
}
