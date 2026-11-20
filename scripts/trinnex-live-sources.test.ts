// WHAT:          The two loop-2 structural backstops: search_trinnex answers ONLY from live sources (LIVE*), and the
//                heartbeat orphan sweeper deletes rows whose source has not been live for 10+ minutes (SWEEP*).
// WHY:           VERIFY-trinnex-workspace-2.md claim 2b: race paths patched one at a time kept leaving orphans (VB1c: a
//                passage with no Library row, permanent). These make ANY orphan unsearchable at once and gone soon after.
// SUPERSEDES:    nothing. SUPERSEDED-BY: nothing -- current.
// EVIDENCE:      docs/qc-evidence/BUILD-trinnex-integration.md "Verifier loop-2 fix round". Run: bun test scripts/trinnex-live-sources.test.ts
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";

const SRC = `${import.meta.dir}/../src/features/huddle/lib`;
process.env.AZURE_PG_URL = "postgresql://fake:fake@localhost:5432/fake";
const mem = await import(`${SRC}/trinnex/memory.server.ts`);
const lib = await import(`${SRC}/trinnex/library.server.ts`);

type Row = Record<string, unknown> & { id: string };
let chunks: Row[] = [];
let triples: Row[] = [];
const OWNER = "owner@x.com";
const MIN = 60_000;
const NOW = new Date("2026-11-20T12:00:00Z");
const ago = (m: number) => new Date(NOW.getTime() - m * MIN);
const chunk = (id: string, source: string, owner = OWNER, created = ago(30), meta: Record<string, unknown> = {}): Row => ({
  id, source, text: `Test-passage ${id}`, created_at: created, metadata: { owner_email: owner, sourceId: source.split(":")[2], ...meta },
});
const fact = (id: string, source: string, owner = OWNER, created = ago(30), superseded = false): Row => ({
  id, agent_id: `${source}|trinnex-owner:${owner}`, source_chunk_id: null, created_at: created, superseded_at: superseded ? ago(20) : null,
});
const ownerOf = (c: Row) => String((c.metadata as { owner_email?: string }).owner_email ?? "").toLowerCase();

const fakePool = {
  query: async (sql: string, p: unknown[] = []) => {
    if (sql.includes("ORDER BY embedding")) {
      // Honour the `sources` restriction (azure-pg searchChunks pushes it as a string[] param).
      const only = (p as unknown[]).find((x) => Array.isArray(x) && x.every((y) => typeof y === "string" && y.startsWith("trinnex:"))) as string[] | undefined;
      return {
        rows: chunks
          .filter((c) => ownerOf(c) === OWNER && (!only || only.includes(c.source as string)))
          .map((c) => ({ id: c.id, text: c.text, source: c.source, score: 0.6, metadata: c.metadata })),
      };
    }
    if (/SELECT source, metadata FROM rag_chunks/.test(sql)) {
      return { rows: chunks.filter((c) => ownerOf(c) === p[0]).map((c) => ({ source: c.source, metadata: c.metadata })) };
    }
    if (/GROUP BY owner, source/.test(sql)) {
      const m = new Map<string, { owner: string; source: string; newest: Date }>();
      const add = (owner: string, source: string, t: Date) => {
        const k = `${owner}\u0000${source}`;
        const e = m.get(k);
        if (!e || e.newest < t) m.set(k, { owner, source, newest: t });
      };
      for (const c of chunks) add(ownerOf(c), c.source as string, c.created_at as Date);
      for (const t of triples) {
        const [source, owner] = String(t.agent_id).split("|trinnex-owner:");
        add(owner, source, t.created_at as Date);
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

/** The main-DB side, modelled on liveTrinnexSources: library rows + meeting rows, classified by the REAL pure
 *  classifyLiveRows (so the removal-status predicate under test is the product's own). */
let libraryRows: Array<{ id: string; owner: string; status: string; updated_at: Date }> = [];
let meetingRows: Array<{ id: string; owner: string }> = [];
let lookups = 0;
let meetingsChecked = true;
let lookupThrows = false;
const liveSources = async (owner: string, keys: string[]) => {
  lookups++;
  if (lookupThrows) throw Object.assign(new Error("main db down"), { code: "ECONNREFUSED" });
  const rows: Array<{ k: string; status: string; updated_at: Date | null }> = [];
  for (const k of new Set(keys)) {
    const [, kind, id] = k.split(":");
    if (kind === "upload") {
      const r = libraryRows.find((x) => x.id === id && x.owner === owner);
      if (r) rows.push({ k, status: r.status, updated_at: r.updated_at });
    } else if (kind === "meeting" && meetingRows.some((x) => x.id === id && x.owner === owner)) rows.push({ k, status: "live", updated_at: null });
  }
  return lib.classifyLiveRows(rows, { live: new Set<string>(), removingSince: new Map<string, number>(), meetingsChecked });
};

function reset() {
  chunks = [];
  triples = [];
  libraryRows = [];
  meetingRows = [];
  lookups = 0;
  meetingsChecked = true;
  lookupThrows = false;
  mem.__setTrinnexDepsForTest({
    getPool: () => fakePool,
    configured: () => true,
    embed: async () => [0.1, 0.2, 0.3],
    liveSources,
  });
}
const sourcesOf = (r: { status: string; results?: Array<{ sourceId: string | null }> }) => (r.results ?? []).map((x) => x.sourceId).sort();

test("LIVE1 an orphan passage left by VB1c (Library row gone) never appears in search_trinnex results", async () => {
  reset();
  chunks = [chunk("c1", "trinnex:upload:u-orphan"), chunk("c2", "trinnex:upload:u-live")];
  libraryRows = [{ id: "u-live", owner: OWNER, status: "searchable", updated_at: ago(60) }];
  const r = await mem.searchTrinnex({ query: "vendor" }, OWNER, NOW);
  expect(r.status).toBe("ok");
  expect(sourcesOf(r as never)).toEqual(["u-live"]);
});

test("LIVE2 a removing / remove_incomplete item's rows never appear; failed and searchable rows do", async () => {
  reset();
  chunks = ["removing", "remove_incomplete", "searchable", "failed"].map((s, i) => chunk(`c${i}`, `trinnex:upload:u-${s}`));
  libraryRows = ["removing", "remove_incomplete", "searchable", "failed"].map((s) => ({ id: `u-${s}`, owner: OWNER, status: s, updated_at: ago(1) }));
  const r = await mem.searchTrinnex({ query: "vendor" }, OWNER, NOW);
  expect(sourcesOf(r as never)).toEqual(["u-failed", "u-searchable"]);
});

test("LIVE3 a filtered question picks from LIVE sources only: an orphan newer meeting cannot be 'the last meeting'", async () => {
  reset();
  chunks = [
    chunk("c1", "trinnex:meeting:m-old", OWNER, ago(30), { date: "2026-11-10T15:00:00Z", title: "Test-Weekly" }),
    chunk("c2", "trinnex:meeting:m-orphan", OWNER, ago(30), { date: "2026-11-18T15:00:00Z", title: "Test-Weekly" }),
  ];
  meetingRows = [{ id: "m-old", owner: OWNER }];
  const r = await mem.searchTrinnex({ query: "to-dos", question: "what were the to-dos from the last meeting" }, OWNER, NOW);
  expect(sourcesOf(r as never)).toEqual(["m-old"]);
});

test("LIVE4 the live lookup failing makes search unavailable (fails closed, never unfiltered)", async () => {
  reset();
  chunks = [chunk("c1", "trinnex:upload:u-live")];
  libraryRows = [{ id: "u-live", owner: OWNER, status: "searchable", updated_at: ago(60) }];
  lookupThrows = true;
  const r = await mem.searchTrinnex({ query: "vendor" }, OWNER, NOW);
  expect(r.status).toBe("unavailable");
});

test("LIVE5 exactly one batched live lookup per search, with and without a catalog", async () => {
  reset();
  chunks = [chunk("c1", "trinnex:upload:u-a"), chunk("c2", "trinnex:upload:u-b"), chunk("c3", "trinnex:meeting:m-a", OWNER, ago(30), { date: "2026-11-10" })];
  libraryRows = [{ id: "u-a", owner: OWNER, status: "searchable", updated_at: ago(60) }];
  await mem.searchTrinnex({ query: "vendor" }, OWNER, NOW);
  expect(lookups).toBe(1);
  lookups = 0;
  await mem.searchTrinnex({ query: "vendor", question: "what did we decide last week" }, OWNER, NOW);
  expect(lookups).toBe(1);
});

test("LIVE6 the real lookup scopes uploads and meetings to the owner, excludes removal states, and is one statement", () => {
  const s = readFileSync(`${SRC}/trinnex/library.server.ts`, "utf8");
  const b = s.slice(s.indexOf("export async function liveTrinnexSources("), s.indexOf("export type LiveRow"));
  expect(b).toContain("WHERE id = ANY($${params.length}::uuid[]) AND lower(owner_email) = $1");
  expect(b).toContain("lower(owner_email) = ANY($${params.length}::text[])");
  expect(b.match(/getPool\(\)\.query\(/g)?.length).toBe(1);
  expect(lib.REMOVAL_STATUSES).toEqual(["removing", "remove_incomplete"]);
});

test("SWEEP1 deletes an orphan source's passages and facts (superseded included), only for its owner", async () => {
  reset();
  chunks = [chunk("c1", "trinnex:upload:u-orphan"), chunk("c2", "trinnex:upload:u-orphan", "other@x.com")];
  triples = [fact("t1", "trinnex:upload:u-orphan"), fact("t2", "trinnex:upload:u-orphan", OWNER, ago(30), true), fact("t3", "trinnex:upload:u-orphan", "other@x.com")];
  libraryRows = [{ id: "u-orphan", owner: "other@x.com", status: "searchable", updated_at: ago(60) }]; // live for the OTHER owner only
  const r = await mem.sweepTrinnexOrphans(NOW);
  expect(r).toMatchObject({ kind: "ok", sources: 1, chunks: 1, facts: 2 });
  expect(chunks.map((c) => c.id)).toEqual(["c2"]);
  expect(triples.map((t) => t.id)).toEqual(["t3"]);
  expect(mem.lastTrinnexSweep?.kind).toBe("ok");
});

test("SWEEP2 never deletes a source whose newest write is inside the 10-minute grace (an in-flight ingest)", async () => {
  reset();
  chunks = [chunk("c1", "trinnex:upload:u-new", OWNER, ago(30)), chunk("c2", "trinnex:upload:u-new", OWNER, ago(9))];
  const r = await mem.sweepTrinnexOrphans(NOW);
  expect(r.sources).toBe(0);
  expect(chunks.length).toBe(2);
});

test("SWEEP3 a removing row's rows wait until 10 minutes after it entered removal", async () => {
  reset();
  chunks = [chunk("c1", "trinnex:upload:u-rm", OWNER, ago(60))];
  libraryRows = [{ id: "u-rm", owner: OWNER, status: "removing", updated_at: ago(5) }];
  expect((await mem.sweepTrinnexOrphans(NOW)).sources).toBe(0);
  libraryRows[0].updated_at = ago(11);
  expect((await mem.sweepTrinnexOrphans(NOW)).sources).toBe(1);
  expect(chunks.length).toBe(0);
});

test("SWEEP4 a live source is never deleted, however old", async () => {
  reset();
  chunks = [chunk("c1", "trinnex:upload:u-live", OWNER, ago(9000)), chunk("c2", "trinnex:meeting:m-live", OWNER, ago(9000))];
  triples = [fact("t1", "trinnex:upload:u-live", OWNER, ago(9000))];
  libraryRows = [{ id: "u-live", owner: OWNER, status: "searchable", updated_at: ago(9000) }];
  meetingRows = [{ id: "m-live", owner: OWNER }];
  const r = await mem.sweepTrinnexOrphans(NOW);
  expect(r.sources).toBe(0);
  expect(chunks.length + triples.length).toBe(3);
});

test("SWEEP5 meetings are left alone when the owner's aliases could not be resolved", async () => {
  reset();
  chunks = [chunk("c1", "trinnex:meeting:m-x", OWNER, ago(60))];
  meetingsChecked = false;
  expect((await mem.sweepTrinnexOrphans(NOW)).sources).toBe(0);
  meetingsChecked = true;
  expect((await mem.sweepTrinnexOrphans(NOW)).sources).toBe(1);
});

test("SWEEP6 the sweep rides the EXISTING heartbeat (no new timer), throttled, never failing the tick", () => {
  const s = readFileSync(`${SRC}/tasks/scheduler.server.ts`, "utf8");
  expect(s).toContain(".then((m) => m.sweepTrinnexOrphansIfDue())");
  expect(s).toContain("await trinnexSweep;");
  const m = readFileSync(`${SRC}/trinnex/memory.server.ts`, "utf8");
  expect(m).not.toMatch(/setInterval|setTimeout\(/);
  expect(mem.SWEEP_GRACE_MS).toBe(10 * MIN);
});
