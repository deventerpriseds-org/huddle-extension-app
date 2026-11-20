// WHAT:          Tier 1 guards for the Trinnex memory lane (lib/trinnex/memory.server.ts + search.ts): bootstrap SQL
//                identity, chunking, provenance of stored facts, explicit delete, both directions of isolation,
//                the honest miss (Trinnex only), unavailable handling, and spelling table S-C rows.
// WHY:           The lane stores model output and decides what an agent may retrieve. AC-trinnex-workspace.md §3.
// SUPERSEDES:    nothing. SUPERSEDED-BY: nothing -- current.
// EVIDENCE:      Run: bun test scripts/trinnex-memory.test.ts. All pools are fakes; no live DB or model call.
// Failing tests also print `FAIL <name>` so scripts/mutate.sh can attribute them.
import { test, expect, mock, beforeEach } from "bun:test";
import { readFileSync } from "node:fs";

const SRC = `${import.meta.dir}/../src/features/huddle/lib`;
const P = (rel: string) => require.resolve(`${SRC}/${rel}`);

const t = (name: string, fn: () => Promise<void> | void) =>
  test(name, async () => {
    try {
      await fn();
    } catch (e) {
      console.log(`FAIL ${name}`);
      throw e;
    }
  });

type Call = { sql: string; params: unknown[] | undefined };
const sharedCalls: Call[] = [];
let trinnexCalls: Call[] = [];
let trinnexRows: (sql: string, params?: unknown[]) => unknown[] = () => [];
let trinnexThrows = false;
let idSeq = 0;

mock.module(P("db/shared-pool.server.ts"), () => ({
  SHARED_POOL_MAX: 8,
  TRINNEX_POOL_MAX: 2,
  getSharedPool: () => ({
    query: async (sql: string, params?: unknown[]) => {
      sharedCalls.push({ sql, params });
      return { rows: [] };
    },
  }),
  trinnexPgConfigured: () => true,
  getTrinnexPool: () => {
    throw new Error("real Trinnex pool must never be reached in tests");
  },
}));
process.env.AZURE_PG_URL = "postgresql://fake:fake@localhost:5432/fake";

const trinnexPool = {
  query: async (sql: string, params?: unknown[]) => {
    trinnexCalls.push({ sql, params });
    if (trinnexThrows) {
      const e = new Error("connection refused") as Error & { code: string };
      e.code = "ECONNREFUSED";
      throw e;
    }
    if (/INSERT INTO rag_(chunks|triples)/.test(sql)) return { rows: [{ id: `id-${++idSeq}` }] };
    return { rows: trinnexRows(sql, params) };
  },
};

const mem = await import(`${SRC}/trinnex/memory.server.ts`);
const search = await import(`${SRC}/trinnex/search.ts`);
const { BOOTSTRAP_SQL } = await import(`${SRC}/rag/azure-pg.server.ts`);
const { TRINNEX_BOOTSTRAP_SQL } = await import(`${SRC}/trinnex/bootstrap-sql.ts`);
const { AGENTS } = await import(`${SRC}/../data/agents.ts`);
const { dispatchTool } = await import(`${SRC}/rag/tools.ts`);
const { azurePgStore } = await import(`${SRC}/rag/azure-pg.server.ts`);

let extracted: Array<{ subject: string; predicate: string; object: string; confidence: number }> = [];
let configured = true;
beforeEach(() => {
  sharedCalls.length = 0;
  trinnexCalls = [];
  trinnexRows = () => [];
  trinnexThrows = false;
  extracted = [];
  configured = true;
  mem.__setTrinnexDepsForTest({
    getPool: () => trinnexPool,
    configured: () => configured,
    embed: async () => [0.1, 0.2, 0.3],
    extractTriples: async () => ({ triples: extracted, failureKind: null }),
    reportFailure: async () => {},
  });
});

const OWNER = "test-owner@example.com";
const meeting = {
  ownerEmail: OWNER,
  sourceId: "ff-123",
  sourceKind: "meeting" as const,
  title: "Test-Leadership weekly",
  date: "2026-11-18T15:00:00Z",
  series: "Engineering Leaders",
  participants: ["Michael R."],
  segments: [
    { text: "Kickoff.", speaker: "Von", at: "0.0" },
    { text: "The vendor review passed.", speaker: "Michael R.", at: "65.2" },
    { text: "We sign Friday.", speaker: "Michael R.", at: "70.0" },
    { text: "Great.", speaker: "Von", at: "80.0" },
  ],
};

// ── bootstrap (AC-M2) ──
t("M2 Trinnex bootstrap is BOOTSTRAP_SQL byte-for-byte, then the owner columns", () => {
  expect(TRINNEX_BOOTSTRAP_SQL.startsWith(BOOTSTRAP_SQL)).toBe(true);
  expect(TRINNEX_BOOTSTRAP_SQL).toContain("ADD COLUMN IF NOT EXISTS owner_entra_oid");
});

// ── chunking (AC-L9, transcripts) ──
t("CH1 transcript turns stay together; a passage never mixes speakers; speaker+at on every passage", () => {
  const { kind, passages } = mem.chunkTrinnexSegments(meeting.segments);
  expect(kind).toBe("transcript");
  expect(passages.map((p: any) => [p.speaker, p.at])).toEqual([["Von", "0.0"], ["Michael R.", "65.2"], ["Von", "80.0"]]);
  expect(passages[1].text).toBe("The vendor review passed.\nWe sign Friday.");
});
t("CH2 every passage stays under the embed cap and no text is lost", () => {
  const long = Array.from({ length: 400 }, (_, i) => `Sentence ${i} about the plan.`).join(" ");
  const { passages } = mem.chunkTrinnexSegments([{ text: long, page: "3" }]);
  expect(passages.every((p: any) => p.text.length <= mem.EMBED_INPUT_CAP && p.page === "3")).toBe(true);
  for (let i = 0; i < 400; i += 37) expect(passages.some((p: any) => p.text.includes(`Sentence ${i} `))).toBe(true);
});

// ── ingest: provenance, idempotence, isolation (AC-M4, M6, M8, M9) ──
t("IN1 ingest writes only to the Trinnex pool, deleting the source first", async () => {
  const r = await mem.ingestTrinnexSource(meeting);
  expect(r.chunks).toBe(3);
  expect(sharedCalls.length).toBe(0);
  expect(trinnexCalls[0].sql).toContain("DELETE FROM rag_triples");
  expect(trinnexCalls[1].sql).toContain("DELETE FROM rag_chunks");
  const ins = trinnexCalls.filter((c) => c.sql.startsWith("INSERT INTO rag_chunks"));
  expect(ins.length).toBe(3);
  expect(ins.every((c) => c.params![3] === "trinnex:meeting:ff-123")).toBe(true);
  const md = ins[1].params![5] as Record<string, unknown>;
  for (const k of ["sourceId", "kind", "title", "date", "series", "category", "participants", "speaker", "at", "page"]) {
    expect(Object.keys(md)).toContain(k);
  }
  expect(md.speaker).toBe("Michael R.");
});
t("IN2 every stored fact carries source_chunk_id; invalid model output is dropped; no supersede", async () => {
  extracted = [
    { subject: "vendor review", predicate: "outcome", object: "passed", confidence: 0.9 },
    { subject: "", predicate: "p", object: "o", confidence: 0.9 },
    { subject: "s", predicate: "p", object: "x".repeat(5000), confidence: 0.9 },
  ];
  const r = await mem.ingestTrinnexSource(meeting);
  const tri = trinnexCalls.filter((c) => c.sql.startsWith("INSERT INTO rag_triples"));
  expect(tri.length).toBe(3); // one valid fact per passage x 3 passages
  expect(r.facts).toBe(3);
  expect(tri.every((c) => typeof c.params![6] === "string" && (c.params![6] as string).startsWith("id-"))).toBe(true);
  // RT-I3 contract change: a fact's agent_id is the source PLUS the owner tag, so two owners never share a fact row.
  expect(tri.every((c) => c.params![0] === "agent" && c.params![1] === "trinnex:meeting:ff-123|trinnex-owner:test-owner@example.com")).toBe(true);
  expect(trinnexCalls.some((c) => /superseded_at = now\(\)/.test(c.sql))).toBe(false);
});
t("IN3 not configured: trinnexConfigured() false, ingest refuses, nothing is queried", async () => {
  configured = false;
  expect(mem.trinnexConfigured()).toBe(false);
  await expect(mem.ingestTrinnexSource(meeting)).rejects.toThrow("not set up");
  expect(trinnexCalls.length + sharedCalls.length).toBe(0);
});

// ── delete (AC-L7) ──
t("DEL1 delete removes facts explicitly (incl. superseded + orphaned) before passages", async () => {
  await mem.deleteTrinnexSource("ff-123", OWNER);
  expect(trinnexCalls.length).toBe(2);
  const [f, c] = trinnexCalls;
  expect(f.sql).toContain("DELETE FROM rag_triples");
  expect(f.sql).toContain("agent_id = ANY");
  expect(f.sql).toContain("source_chunk_id IN (SELECT id FROM rag_chunks");
  expect(f.sql).not.toContain("superseded_at IS NULL");
  expect(c.sql).toContain("DELETE FROM rag_chunks");
  expect(f.params![0]).toEqual(["trinnex:meeting:ff-123", "trinnex:upload:ff-123"]);
  // RT-I3: both deletes are scoped to the caller-owner.
  expect(f.params![1]).toBe(OWNER);
  expect(c.sql).toContain("lower(metadata->>'owner_email') = $2");
  expect(c.params![1]).toBe(OWNER);
});

// ── isolation (AC-M7) ──
t("ISO1 search_trinnex is offered only to iris-chase and eli-vaughn (every agent enumerated)", () => {
  const offered = AGENTS.filter((a: any) => search.trinnexToolsFor(a).length > 0).map((a: any) => a.id).sort();
  expect(offered).toEqual(["eli-vaughn", "iris-chase"]);
});
t("ISO2 every other agent's search_trinnex call is refused without touching the Trinnex pool", async () => {
  for (const a of AGENTS) {
    if (a.id === "iris-chase" || a.id === "eli-vaughn") continue;
    const out = JSON.parse(await mem.dispatchTrinnexTool(a.id, { query: "vendor" }, OWNER));
    expect(out.error).toContain("not available");
  }
  expect(trinnexCalls.length).toBe(0);
});
t("ISO3 personal auto-retrieval never queries the Trinnex pool", async () => {
  const { retrieveAgentMemory } = await import(`${SRC}/rag/memory-context.server.ts`);
  await retrieveAgentMemory({ query: "vendor", queryVec: [0.1], agent: { id: "iris-chase", domains: [], themes: [] } });
  expect(sharedCalls.length).toBe(1);
  expect(trinnexCalls.length).toBe(0);
  expect(readFileSync(P("rag/memory-context.server.ts"), "utf8")).not.toMatch(/trinnex/i);
});

// ── honest miss, Trinnex only (AC-M14) + unavailable (AC-M16) ──
t("MISS1 Trinnex miss is honest; personal search_memory miss stays silent", async () => {
  const r = await mem.searchTrinnex({ query: "vendor" }, OWNER);
  expect(r.status).toBe("miss");
  expect((r as any).message).toBe(search.TRINNEX_MISS_TEXT);
  const emptyStore = { ...azurePgStore, searchChunks: async () => [] };
  const personal = await dispatchTool(emptyStore, "iris-chase", { name: "search_memory", arguments: { query: "x" } });
  expect(personal).not.toContain(search.TRINNEX_MISS_TEXT);
  expect(personal).toContain("NOT a problem to report");
});
t("MISS2 a below-floor hit is a miss, not a citation", async () => {
  trinnexRows = (sql) => (sql.includes("ORDER BY embedding") ? [{ id: "c1", text: "weak", source: "trinnex:meeting:1", score: 0.1, metadata: {} }] : []);
  const r = await mem.searchTrinnex({ query: "vendor" }, OWNER);
  expect(r.status).toBe("miss");
});
t("UNAV1 a Trinnex DB error says unavailable and never falls back to personal memory", async () => {
  trinnexThrows = true;
  const r = await mem.searchTrinnex({ query: "vendor", speaker: "Michael" }, OWNER);
  expect(r.status).toBe("unavailable");
  expect(sharedCalls.length).toBe(0);
});
t("CITE1 a hit returns title, date, speaker, at and a verbatim quote", async () => {
  const text = "The vendor review passed.\nWe sign Friday.";
  trinnexRows = (sql) =>
    sql.includes("ORDER BY embedding")
      ? [{ id: "c1", text, source: "trinnex:meeting:ff-123", score: 0.5, metadata: { title: "T", date: "2026-11-18", speaker: "Michael R.", at: "65.2", sourceId: "ff-123" } }]
      : [];
  const r: any = await mem.searchTrinnex({ query: "vendor" }, OWNER);
  expect(r.status).toBe("ok");
  expect(r.results[0]).toMatchObject({ title: "T", date: "2026-11-18", speaker: "Michael R.", at: "65.2" });
  expect(text.includes(r.results[0].quote)).toBe(true);
});

// ── speaker + series filters (AC-M11, M12) ──
const catalogRows = [
  { source: "trinnex:meeting:a", metadata: { title: "EL 1", date: "2026-11-04", series: "Engineering Leaders", speaker: "Michael R.", participants: ["Michael R."] } },
  { source: "trinnex:meeting:b", metadata: { title: "EL 2", date: "2026-11-11", series: "Engineering Leaders", speaker: "Priya S." } },
  { source: "trinnex:meeting:c", metadata: { title: "EL 3", date: "2026-11-18", series: "Engineering Leaders", speaker: "Michael R." } },
  { source: "trinnex:meeting:d", metadata: { title: "The Last Mile review", date: "2026-11-19", series: null, speaker: "Dana K." } },
];
t("FIL1 'the last Engineering Leaders meeting' searches ONLY the max-date meeting of that series", async () => {
  trinnexRows = (sql) => (sql.includes("LIKE 'trinnex:%'") ? catalogRows : []);
  await mem.searchTrinnex({ query: "to-dos", series: "Engineering Leaders", question: "to-dos from the last Engineering Leaders meeting" }, OWNER);
  const s = trinnexCalls.find((c) => c.sql.includes("ORDER BY embedding"))!;
  const at = (s.params ?? []).findIndex((p) => JSON.stringify(p) === JSON.stringify(["trinnex:meeting:c"]));
  expect(at).toBeGreaterThan(-1);
  // the param must actually be bound into the WHERE, not merely sent
  expect(s.sql).toContain(`source = ANY($${at + 1}::text[])`);
});
t("FIL2 'what did Michael say' filters to speaker Michael R. through metadata", async () => {
  trinnexRows = (sql) => (sql.includes("LIKE 'trinnex:%'") ? catalogRows : []);
  await mem.searchTrinnex({ query: "vendor outcome", speaker: "Michael" }, OWNER);
  const s = trinnexCalls.find((c) => c.sql.includes("ORDER BY embedding"))!;
  expect(s.sql).toContain("lower(metadata->>");
  expect(s.params).toContain("Michael R.");
  expect(s.params).toContain("speaker");
});
t("FIL3 two Michaels is ambiguous, never auto-picked", async () => {
  trinnexRows = (sql) =>
    sql.includes("LIKE 'trinnex:%'") ? [...catalogRows, { source: "trinnex:meeting:e", metadata: { date: "2026-11-01", speaker: "Michael T." } }] : [];
  const r: any = await mem.searchTrinnex({ query: "x", speaker: "Michael" }, OWNER);
  expect(r.status).toBe("ambiguous");
  expect(r.options.sort()).toEqual(["Michael R.", "Michael T."]);
});

// ── spelling table S-C (recency phrasing) ──
const NOW = new Date("2026-11-20T12:00:00Z"); // a Friday
const SC: Array<[string, string, unknown]> = [
  ["S-C1", "the last Engineering Leaders meeting", { mostRecent: 1 }],
  ["S-C2a", "the latest Engineering Leaders", { mostRecent: 1 }],
  ["S-C2b", "most recent Eng Leaders sync", { mostRecent: 1 }],
  ["S-C3", "last week's Engineering Leaders meeting", { dateFrom: "2026-11-09", dateTo: "2026-11-15" }],
  ["S-C4", "the last two Engineering Leaders meetings", { mostRecent: 2 }],
  ["S-C5", "the Engineering Leaders meeting before last", { mostRecent: 1, skip: 1 }],
  ["S-C6", "last time we discussed the vendor", null],
  ["S-C7", "the last meeting", { mostRecent: 1 }],
  ["S-C10", "what did Michael say last", { mostRecent: 1 }],
  ["S-C11", 'the "Last Mile" review', null],
];
for (const [id, phrase, want] of SC) {
  t(`${id} recency of ${JSON.stringify(phrase)}`, () => {
    expect(search.recencyFromQuestion(phrase, NOW)).toEqual(want);
  });
}
const CAT = catalogRows.map((r) => ({
  source: r.source,
  title: r.metadata.title,
  date: r.metadata.date,
  series: r.metadata.series,
  participants: (r.metadata as any).participants ?? [],
  speakers: [r.metadata.speaker],
}));
const SEL: Array<[string, Record<string, unknown>, unknown]> = [
  ["S-C1/sel", { series: "Engineering Leaders", mostRecent: 1 }, ["trinnex:meeting:c"]],
  ["S-C2/sel", { series: "Eng Leaders", mostRecent: 1 }, ["trinnex:meeting:c"]],
  ["S-C2b/sel", { series: "eng leaders sync", mostRecent: 1 }, ["trinnex:meeting:c"]],
  ["S-C3/sel", { series: "Engineering Leaders", dateFrom: "2026-11-09", dateTo: "2026-11-15" }, ["trinnex:meeting:b"]],
  ["S-C4/sel", { series: "Engineering Leaders", mostRecent: 2 }, ["trinnex:meeting:c", "trinnex:meeting:b"]],
  ["S-C5/sel", { series: "Engineering Leaders", mostRecent: 1, skip: 1 }, ["trinnex:meeting:b"]],
  ["S-C7/sel", { mostRecent: 1 }, ["trinnex:meeting:d"]],
  ["S-C10/sel", { speaker: "Michael", mostRecent: 1 }, ["trinnex:meeting:c"]],
  ["S-C11/sel", { title: "Last Mile" }, ["trinnex:meeting:d"]],
  ["S-C8/sel", { series: "Weekly sync", mostRecent: 1 }, "none"],
];
for (const [id, f, want] of SEL) {
  t(`${id} selection ${JSON.stringify(f)}`, () => {
    const r: any = search.selectSources(CAT, f);
    if (want === "none") expect(r.kind).toBe("none");
    else expect(r.sources).toEqual(want);
  });
}
