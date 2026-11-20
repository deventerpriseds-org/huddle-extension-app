// WHAT:          Verifier loop-3 attacks on the loop-2 fix round: the live-source search filter (VC1), the orphan
//                sweeper's grace window vs a slow / stuck source (VC2), and lease renewal during a long or hung run (VC3).
// WHY:           VERIFY-trinnex-workspace-2.md said FIX FIRST on 2b (VB1c orphan). These probe the NEW backstops for a
//                derived row that is visible or permanent with no live source, and for a LIVE source's rows being swept.
// SUPERSEDES:    nothing. SUPERSEDED-BY: nothing -- current.
// EVIDENCE:      docs/qc-evidence/VERIFY-trinnex-workspace-3.md. Run: bun test ./scripts/verify-trinnex-attack-3.test.ts
import { test, expect } from "bun:test";

const SRC = `${import.meta.dir}/../src/features/huddle/lib`;
process.env.AZURE_PG_URL = "postgresql://fake:fake@localhost:5432/fake";
const mem = await import(`${SRC}/trinnex/memory.server.ts`);
const lib = await import(`${SRC}/trinnex/library.server.ts`);

type Row = Record<string, unknown> & { id: string };
let chunks: Row[] = [];
let triples: Row[] = [];
const A = "owner-a@x.com";
const B = "owner-b@x.com";
const MIN = 60_000;
const NOW = new Date("2026-11-20T12:00:00Z");
const ago = (m: number) => new Date(NOW.getTime() - m * MIN);
const chunk = (id: string, source: string, owner = A, created = ago(30)): Row => ({
  id, source, text: `Test-passage ${id}`, created_at: created, metadata: { owner_email: owner, sourceId: source.split(":")[2] },
});
const ownerOf = (c: Row) => String((c.metadata as { owner_email?: string }).owner_email ?? "").toLowerCase();

// Fake Trinnex pool: same SQL shapes as the builder's trinnex-live-sources.test.ts (search, catalog, sweep, deletes).
const fakePool = {
  query: async (sql: string, p: unknown[] = []) => {
    if (sql.includes("ORDER BY embedding")) {
      const owner = (p as unknown[]).find((x) => typeof x === "string" && x.includes("@")) as string | undefined;
      return {
        rows: chunks
          .filter((c) => !owner || ownerOf(c) === owner || JSON.stringify(p).includes(ownerOf(c)))
          .map((c) => ({ id: c.id, text: c.text, source: c.source, score: 0.6, metadata: c.metadata })),
      };
    }
    if (/SELECT source, metadata FROM rag_chunks/.test(sql)) {
      return { rows: chunks.filter((c) => ownerOf(c) === p[0]).map((c) => ({ source: c.source, metadata: c.metadata })) };
    }
    if (/GROUP BY owner, source/.test(sql)) {
      const m = new Map<string, { owner: string; source: string; newest: Date }>();
      for (const c of chunks) {
        const k = `${ownerOf(c)}\u0000${c.source}`;
        const e = m.get(k);
        if (!e || e.newest < (c.created_at as Date)) m.set(k, { owner: ownerOf(c), source: c.source as string, newest: c.created_at as Date });
      }
      return { rows: [...m.values()] };
    }
    if (/^\s*DELETE FROM rag_triples/.test(sql)) {
      const [, , keys] = p as [string[], string, string[]];
      const gone = triples.filter((t) => keys.includes(t.agent_id as string));
      triples = triples.filter((t) => !gone.includes(t));
      return { rows: gone.map((g) => ({ id: g.id })) };
    }
    if (/^\s*DELETE FROM rag_chunks/.test(sql)) {
      const [sources, owner] = p as [string[], string];
      const gone = chunks.filter((c) => sources.includes(c.source as string) && ownerOf(c) === owner);
      chunks = chunks.filter((c) => !gone.includes(c));
      return { rows: gone.map((g) => ({ id: g.id })) };
    }
    return { rows: [] };
  },
};

// Main-DB model, written from my reading of liveTrinnexSources' SQL (library.server.ts ~588-640):
//  upload live  <=> library_items row with that id AND lower(owner_email) = owner, classified by the REAL classifyLiveRows;
//  meeting live <=> chat.fireflies_meetings row with that meeting_id AND lower(owner_email) IN owner's aliases.
let libraryRows: Array<{ id: string; owner: string; status: string; updated_at: Date }> = [];
let meetingRows: Array<{ id: string; owner: string }> = [];
const aliases: Record<string, string[]> = {};
const liveSources = async (owner: string, keys: string[]) => {
  const owners = new Set([owner, ...(aliases[owner] ?? [])]);
  const rows: Array<{ k: string; status: string; updated_at: Date | null }> = [];
  for (const k of new Set(keys)) {
    const [, kind, id] = k.split(":");
    if (kind === "upload") {
      const r = libraryRows.find((x) => x.id === id && x.owner.toLowerCase() === owner);
      if (r) rows.push({ k, status: r.status, updated_at: r.updated_at });
    } else if (kind === "meeting" && meetingRows.some((x) => x.id === id && owners.has(x.owner.toLowerCase()))) {
      rows.push({ k, status: "live", updated_at: null });
    }
  }
  return lib.classifyLiveRows(rows, { live: new Set<string>(), removingSince: new Map<string, number>(), meetingsChecked: true }, NOW.getTime());
};

function reset() {
  chunks = [];
  triples = [];
  libraryRows = [];
  meetingRows = [];
  for (const k of Object.keys(aliases)) delete aliases[k];
  mem.__setTrinnexDepsForTest({ getPool: () => fakePool, configured: () => true, embed: async () => [0.1, 0.2, 0.3], liveSources });
}
const ids = (r: { results?: Array<{ sourceId: string | null }> }) => (r.results ?? []).map((x) => x.sourceId).sort();
const remaining = () => chunks.map((c) => c.source as string).sort();

// ── VC1: the live-source filter ────────────────────────────────────────────────────────────────────────
test("VC1a a meeting passage owned by A whose fireflies row belongs to B is NOT searchable by A (unfiltered and filtered)", async () => {
  reset();
  chunks = [chunk("c1", "trinnex:meeting:m-b"), chunk("c2", "trinnex:meeting:m-a")];
  meetingRows = [{ id: "m-b", owner: B }, { id: "m-a", owner: A }];
  const r1 = await mem.searchTrinnex({ query: "budget" }, A, NOW);
  expect(ids(r1 as never)).toEqual(["m-a"]);
  const r2 = await mem.searchTrinnex({ query: "budget", title: "Test" }, A, NOW);
  expect((r2 as { results?: unknown[] }).results ?? []).not.toContainEqual(expect.objectContaining({ sourceId: "m-b" }));
});

test("VC1b a library row stuck in `removing` forever: never searchable, and swept once 10 min past the row's updated_at", async () => {
  reset();
  chunks = [chunk("c1", "trinnex:upload:u-stuck", A, ago(240))];
  libraryRows = [{ id: "u-stuck", owner: A, status: "removing", updated_at: ago(5) }];
  expect((await mem.searchTrinnex({ query: "x" }, A, NOW)).status).toBe("miss");
  await mem.sweepTrinnexOrphans(NOW); // 5 min since it stopped being live: inside the grace
  expect(remaining()).toEqual(["trinnex:upload:u-stuck"]);
  libraryRows[0].updated_at = ago(11);
  await mem.sweepTrinnexOrphans(NOW);
  expect(remaining()).toEqual([]);
});

test("VC1c an alias-owned meeting (row under A's alias) stays searchable and is NOT swept", async () => {
  reset();
  aliases[A] = ["a.alias@x.com"];
  chunks = [chunk("c1", "trinnex:meeting:m-alias", A, ago(600))];
  meetingRows = [{ id: "m-alias", owner: "A.Alias@x.com" }];
  expect(ids((await mem.searchTrinnex({ query: "x" }, A, NOW)) as never)).toEqual(["m-alias"]);
  await mem.sweepTrinnexOrphans(NOW);
  expect(remaining()).toEqual(["trinnex:meeting:m-alias"]);
});

// ── VC2: the sweeper's grace window vs live / slow sources ─────────────────────────────────────────────
test("VC2a a LIVE upload mid-ingest (status split / facts / uploaded / waiting_memory / failed) is never swept, however old its writes", async () => {
  reset();
  const sts = ["uploaded", "read", "split", "facts", "waiting_memory", "failed", "searchable"];
  chunks = sts.map((s, i) => chunk(`c${i}`, `trinnex:upload:u-${s}`, A, ago(60 * 24 * 30)));
  libraryRows = sts.map((s) => ({ id: `u-${s}`, owner: A, status: s, updated_at: ago(60 * 24 * 30) }));
  const r = await mem.sweepTrinnexOrphans(NOW);
  expect(r.sources).toBe(0);
  expect(remaining().length).toBe(sts.length);
});

test("VC2b a source with NO row whose newest write is 9 min old is kept (an ingest may still be finishing); at 11 min it is swept", async () => {
  reset();
  chunks = [chunk("c1", "trinnex:upload:u-gone", A, ago(9))];
  await mem.sweepTrinnexOrphans(NOW);
  expect(remaining()).toEqual(["trinnex:upload:u-gone"]);
  chunks[0].created_at = ago(11);
  await mem.sweepTrinnexOrphans(NOW);
  expect(remaining()).toEqual([]);
});

test("VC2c owner scoping: B's live upload with the same id as A's orphan is untouched when A's orphan is swept", async () => {
  reset();
  chunks = [chunk("c1", "trinnex:upload:u-same", A, ago(60)), chunk("c2", "trinnex:upload:u-same", B, ago(60))];
  libraryRows = [{ id: "u-same", owner: B, status: "searchable", updated_at: ago(60) }];
  await mem.sweepTrinnexOrphans(NOW);
  expect(chunks.map((c) => ownerOf(c))).toEqual([B]);
});

// ── VC3: lease renewal while the worker is slow / hung ─────────────────────────────────────────────────
// The real ingestTrinnexSource (fake store pool) with a clock that advances per AI call. runPipeline renews ONLY
// from its `removed()` check, which ingest calls through `shouldStop`. Record every shouldStop time.
async function ingestGaps(passages: number, extractMs: number, triplesPerPassage: number): Promise<{ maxGapMs: number; calls: number }> {
  let clock = 0;
  const seen: number[] = [0];
  let idSeq = 0;
  mem.__setTrinnexDepsForTest({
    getPool: () => ({
      query: async (sql: string) => (/INSERT INTO rag_(chunks|triples)/.test(sql) ? { rows: [{ id: `id-${++idSeq}` }] } : { rows: [] }),
    }),
    configured: () => true,
    embed: async () => { clock += 1_000; return [0.1, 0.2, 0.3]; },
    extractTriples: async () => {
      clock += extractMs;
      return { triples: Array.from({ length: triplesPerPassage }, (_, i) => ({ subject: `Test-S${i}`, predicate: "owns", object: "Test-O", confidence: 0.9 })), failureKind: null };
    },
    reportFailure: async () => {},
  });
  await mem.ingestTrinnexSource({
    sourceId: crypto.randomUUID(), sourceKind: "upload", title: "Test-long.pdf", date: null, category: "General", participants: [],
    segments: Array.from({ length: passages }, (_, i) => ({ text: `Test-paragraph ${i} `.repeat(200), page: String(i + 1) })),
    ownerEmail: A,
    shouldStop: () => { seen.push(clock); return false; },
  } as never);
  seen.push(clock);
  let maxGapMs = 0;
  for (let i = 1; i < seen.length; i++) maxGapMs = Math.max(maxGapMs, seen[i] - seen[i - 1]);
  return { maxGapMs, calls: seen.length - 2 };
}

test("VC3a OBSERVE: a facts phase where extraction finds NO facts calls shouldStop (the only renewal point) how often?", async () => {
  const r = await ingestGaps(20, 15_000, 0); // 20 passages, 15 s per extraction, no facts
  console.log(`VC3a passages=20 extract=15s facts=0 -> shouldStop calls=${r.calls} maxGapSec=${r.maxGapMs / 1000} lease=180s`);
  expect(r.calls).toBeGreaterThan(0);
});

test("VC3b with facts found on every passage the gap stays one extraction long", async () => {
  const r = await ingestGaps(20, 15_000, 1);
  console.log(`VC3b passages=20 extract=15s facts=1/passage -> shouldStop calls=${r.calls} maxGapSec=${r.maxGapMs / 1000}`);
  expect(r.maxGapMs).toBeLessThanOrEqual(16_000);
});

test("VC3c a Remove that lands after the lease lapsed (hung worker): the worker's next check cancels and leaves NO passage", async () => {
  reset();
  // Model the removal winning while the worker is between writes: isRemoved flips true after the 2nd passage.
  let written = 0;
  let removedNow = false;
  mem.__setTrinnexDepsForTest({
    getPool: () => ({
      query: async (sql: string, p: unknown[] = []) => {
        if (/INSERT INTO rag_chunks/.test(sql)) {
          written++;
          chunks.push(chunk(`w${written}`, "trinnex:upload:u-hang", A, NOW));
          if (written === 2) removedNow = true; // the Remove completes (row gone) right after this write
          return { rows: [{ id: `w${written}` }] };
        }
        return fakePool.query(sql, p);
      },
    }),
    configured: () => true,
    embed: async () => [0.1, 0.2, 0.3],
    extractTriples: async () => ({ triples: [], failureKind: null }),
    reportFailure: async () => {},
    liveSources,
  });
  const out = await mem.ingestTrinnexSource({
    sourceId: "u-hang", sourceKind: "upload", title: "Test-hang.pdf", date: null, category: "General", participants: [],
    segments: Array.from({ length: 5 }, (_, i) => ({ text: `Test-paragraph ${i} `.repeat(200), page: String(i + 1) })),
    ownerEmail: A,
    shouldStop: () => removedNow,
  } as never);
  expect((out as { cancelled?: boolean }).cancelled).toBe(true);
  expect(remaining()).toEqual([]);
});
