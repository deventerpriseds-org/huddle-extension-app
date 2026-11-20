// WHAT:          Guards for the Trinnex integration pass: AC-C5 (fact-extraction failure KIND recorded + quota
//                surfaced), the Lovable-path search_trinnex gate, AC-C7 (owner stamped + every search owner-scoped),
//                AC-L9 (slide/sheet locations round-trip into citations exactly).
// WHY:           The three lanes each listed these seams as not covered (BUILD-trinnex-{memory,meetings,library}.md).
// SUPERSEDES:    nothing. SUPERSEDED-BY: nothing -- current.
// EVIDENCE:      Run: bun test scripts/trinnex-integration.test.ts. Every pool is a fake; no live DB, model or fetch.
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

mock.module(P("db/shared-pool.server.ts"), () => ({
  SHARED_POOL_MAX: 8,
  TRINNEX_POOL_MAX: 2,
  getSharedPool: () => ({ query: async () => ({ rows: [] }) }),
  trinnexPgConfigured: () => true,
  getTrinnexPool: () => {
    throw new Error("real Trinnex pool must never be reached in tests");
  },
}));
process.env.AZURE_PG_URL = "postgresql://fake:fake@localhost:5432/fake";

// A STATEFUL fake Trinnex DB: it keeps the written passages and answers the two read shapes the store issues
// (the owner-scoped catalog and the ANN search), honouring the owner/source/metadata predicates the SQL binds.
type Row = { id: string; text: string; source: string; metadata: Record<string, unknown> };
let rows: Row[] = [];
let queries: Array<{ sql: string; params: unknown[] }> = [];
let seq = 0;
const fakePool = {
  query: async (sql: string, params: unknown[] = []) => {
    queries.push({ sql, params });
    if (/INSERT INTO rag_chunks/.test(sql)) {
      const md = typeof params[5] === "string" ? JSON.parse(params[5] as string) : (params[5] as Record<string, unknown>);
      const r = { id: `c-${++seq}`, text: String(params[2]), source: String(params[3]), metadata: md };
      rows.push(r);
      return { rows: [{ id: r.id }] };
    }
    if (/INSERT INTO rag_triples/.test(sql)) return { rows: [{ id: `f-${++seq}` }] };
    if (/DELETE FROM/.test(sql)) return { rows: [] };
    if (sql.includes("LIKE 'trinnex:%'")) {
      const m = /owner_email'\) = \$(\d+)/.exec(sql);
      const owner = m ? String(params[Number(m[1]) - 1]) : null;
      return { rows: rows.filter((r) => owner === null || String(r.metadata.owner_email ?? "").toLowerCase() === owner).map((r) => ({ source: r.source, metadata: r.metadata })) };
    }
    if (sql.includes("ORDER BY embedding")) {
      let out = rows;
      const src = /source = ANY\(\$(\d+)::text\[\]\)/.exec(sql);
      if (src) out = out.filter((r) => (params[Number(src[1]) - 1] as string[]).includes(r.source));
      for (const mm of sql.matchAll(/lower\(metadata->>\$(\d+)\) = lower\(\$(\d+)\)/g)) {
        const k = String(params[Number(mm[1]) - 1]);
        const v = String(params[Number(mm[2]) - 1]).toLowerCase();
        out = out.filter((r) => String(r.metadata[k] ?? "").toLowerCase() === v);
      }
      return { rows: out.map((r) => ({ ...r, scope: "global", agent_id: null, created_at: new Date(), author_agent_ids: [], score: 0.9 })) };
    }
    return { rows: [] };
  },
};

const mem = await import(`${SRC}/trinnex/memory.server.ts`);
const search = await import(`${SRC}/trinnex/search.ts`);
const core = await import(`${SRC}/trinnex/library-core.ts`);
const lib = await import(`${SRC}/trinnex/library.server.ts`);
const { AGENTS } = await import(`${SRC}/../data/agents.ts`);
const { isQuotaError, aiFailureKind } = await import(`${SRC}/fallbacks.ts`);

let extract: { triples: Array<{ subject: string; predicate: string; object: string; confidence: number }>; failureKind: string | null } = {
  triples: [],
  failureKind: null,
};
let reported: Array<{ kind: string; owner: string }> = [];
beforeEach(() => {
  rows = [];
  queries = [];
  reported = [];
  extract = { triples: [{ subject: "vendor review", predicate: "outcome", object: "passed", confidence: 0.9 }], failureKind: null };
  mem.__setTrinnexDepsForTest({
    getPool: () => fakePool,
    configured: () => true,
    embed: async () => [0.1, 0.2, 0.3],
    extractTriples: async () => extract,
    reportFailure: async (kind: string, owner: string) => {
      reported.push({ kind, owner });
    },
  });
});

const A = "Test-Owner-A@Example.com";
const B = "test-owner-b@example.com";
const meetingFor = (ownerEmail: string, sourceId: string, line: string) => ({
  ownerEmail,
  sourceId,
  sourceKind: "meeting" as const,
  title: `Test-${sourceId}`,
  date: "2026-11-18T15:00:00Z",
  series: "Engineering Leaders",
  participants: ["Michael R."],
  segments: [{ text: line, speaker: "Michael R.", at: "65.2" }],
});

// ── AC-C7 owner scoping ──────────────────────────────────────────────────────────────────────────────
t("C7 ingest stamps every passage with the lower-cased owner email", async () => {
  await mem.ingestTrinnexSource(meetingFor(A, "m-a", "The vendor review passed."));
  expect(rows.length).toBeGreaterThan(0);
  for (const r of rows) expect(r.metadata.owner_email).toBe(A.toLowerCase());
});

t("C7 ingest without an owner is refused before anything is written", async () => {
  await expect(mem.ingestTrinnexSource({ ...meetingFor("  ", "m-x", "x"), ownerEmail: "  " })).rejects.toThrow("ownerEmail");
  expect(queries.length).toBe(0);
});

t("C7 a second owner's rows are never returned", async () => {
  await mem.ingestTrinnexSource(meetingFor(A, "m-a", "Owner A vendor review passed."));
  await mem.ingestTrinnexSource(meetingFor(B, "m-b", "Owner B vendor review failed."));
  for (const [owner, mine] of [
    [A, "m-a"],
    [B, "m-b"],
  ] as const) {
    // unfiltered, speaker-filtered and series-filtered searches all stay inside the owner's rows
    for (const args of [{ query: "vendor" }, { query: "vendor", speaker: "Michael" }, { query: "vendor", series: "Engineering Leaders" }]) {
      const r: any = await mem.searchTrinnex(args, owner);
      expect(r.status).toBe("ok");
      expect(r.results.map((c: any) => c.sourceId)).toEqual([mine]);
    }
  }
});

t("C7 no resolved owner means no search at all", async () => {
  await mem.ingestTrinnexSource(meetingFor(A, "m-a", "x"));
  queries = [];
  const r: any = await mem.searchTrinnex({ query: "vendor" }, null);
  expect(r.status).toBe("unavailable");
  expect(queries.length).toBe(0);
});

// ── AC-L9 locations ──────────────────────────────────────────────────────────────────────────────────
t("L9 slide and sheet locations are stored in metadata.page and cited exactly", async () => {
  const pages = ["slide 3", "sheet Budget rows 1-40", "14"];
  await mem.ingestTrinnexSource({
    ownerEmail: A,
    sourceId: "doc-1",
    sourceKind: "upload",
    title: "Test-deck.pptx",
    date: null,
    category: "General",
    participants: [],
    segments: pages.map((p, i) => ({ text: `Location test passage ${i}.`, page: p })),
  });
  expect(rows.map((r) => r.metadata.page)).toEqual(pages);
  const r: any = await mem.searchTrinnex({ query: "location" }, A);
  expect(r.status).toBe("ok");
  expect(r.results.map((c: any) => c.page).sort()).toEqual([...pages].sort());
});

// ── AC-C5 fact-extraction failures ───────────────────────────────────────────────────────────────────
t("C5 a quota failure is recorded by kind, passages stay stored, and the alert path is called", async () => {
  extract = { triples: [], failureKind: "429 insufficient_quota" };
  const r = await mem.ingestTrinnexSource(meetingFor(A, "m-a", "The vendor review passed."));
  expect(r.chunks).toBeGreaterThan(0);
  expect(r.facts).toBe(0);
  expect(r.factsFailure).toBe("429 insufficient_quota");
  expect(reported).toEqual([{ kind: "429 insufficient_quota", owner: A.toLowerCase() }]);
  expect(core.factsFailureNotice(core.factsFailReason(r.factsFailure!))).toBe("Facts not extracted: AI quota exhausted");
});

t("C5 success records no failure and raises no alert", async () => {
  const r = await mem.ingestTrinnexSource(meetingFor(A, "m-a", "The vendor review passed."));
  expect(r.factsFailure).toBe(null);
  expect(r.facts).toBeGreaterThan(0);
  expect(reported).toEqual([]);
  expect(core.factsFailureNotice(null)).toBe(null);
});

t("C5 the alert message carries the kind only and the existing quota alert recognises it", () => {
  const e = mem.trinnexAlertError("429 insufficient_quota");
  expect(isQuotaError(e.message)).toBe(true);
  expect(aiFailureKind(e)).toBe("429 insufficient_quota");
  expect(isQuotaError(mem.trinnexAlertError("500").message)).toBe(false);
  const src = readFileSync(`${SRC}/trinnex/memory.server.ts`, "utf8");
  // the REAL reporter rides the existing background-AI quota alert (bell row + Iris notice), not a new sender
  expect(src).toMatch(/runAsAiJob\("Trinnex memory", ownerEmail, async \(\) => q\.noteAiFailure\(trinnexAlertError\(kind\)\)\)/);
});

t("C5 extractTriplesDetailed returns status and provider code, never the message", async () => {
  const realFetch = globalThis.fetch;
  process.env.OPENAI_API_KEY = "test-key";
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ error: { code: "insufficient_quota", message: "SECRET-MARKER you exceeded" } }), { status: 429 })) as typeof fetch;
  try {
    const { extractTriplesDetailed, extractTriples } = await import(`${SRC}/rag/triples.server.ts`);
    const r = await extractTriplesDetailed("x");
    expect(r).toEqual({ triples: [], failureKind: "429 insufficient_quota" });
    expect(JSON.stringify(r)).not.toContain("SECRET-MARKER");
    expect(await extractTriples("x")).toEqual([]); // existing callers unchanged
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.OPENAI_API_KEY;
  }
});

t("C5 a library item with a facts failure stays searchable and shows the quota notice", async () => {
  const patches: Array<Record<string, unknown>> = [];
  const item = {
    id: "00000000-0000-4000-8000-000000000009", ownerEmail: A, name: "Test-x.txt", sizeBytes: 5, fileType: "txt", kind: "document",
    category: "General", participants: [], speakerMap: {}, docDate: null, status: "uploaded", failedStep: null, failReason: null,
    chunks: 0, facts: 0, blobPath: "t/x.txt", createdAt: "",
  } as any;
  let ingestedOwner = "";
  const status = await lib.runPipeline(item, {
    getBytes: async () => new Uint8Array([1]),
    deleteBytes: async () => true,
    extract: async () => ({ segments: [{ text: "hello", page: "1" }], cues: [] }),
    memory: {
      configured: () => true,
      ingest: async (input: any) => {
        ingestedOwner = input.ownerEmail;
        return { chunks: 1, facts: 0, factsFailure: "429 insufficient_quota" };
      },
      remove: async () => ({ chunks: 0, facts: 0 }),
    },
    update: async (_id: string, p: Record<string, unknown>) => {
      patches.push(p);
    },
    deleteRow: async () => {},
  });
  expect(status).toBe("searchable");
  expect(ingestedOwner).toBe(A);
  const last = patches.at(-1)!;
  expect(last.status).toBe("searchable");
  expect(core.factsFailureNotice(last.failReason as string)).toBe("Facts not extracted: AI quota exhausted");
});

// ── search_trinnex on BOTH dispatch paths ────────────────────────────────────────────────────────────
t("LOV1 no agent without trinnexAccess gets search_trinnex on either path", () => {
  const allowed: string[] = [];
  for (const a of AGENTS) {
    const openai = (search.trinnexToolsFor(a) as Array<{ name: string }>).map((x) => x.name);
    const lovable = Object.keys(search.trinnexLovableToolsFor(a, (d: unknown) => d));
    const want = a.trinnexAccess === true ? ["search_trinnex"] : [];
    expect(openai).toEqual(want);
    expect(lovable).toEqual(want);
    if (want.length) allowed.push(a.id);
  }
  expect(allowed.sort()).toEqual(["eli-vaughn", "iris-chase"]);
});

t("LOV2 huddle.functions wires search_trinnex on both paths only through the gate, with the owner", () => {
  const src = readFileSync(`${SRC}/huddle.functions.ts`, "utf8");
  expect(src).toContain("trinnexToolsFor(winner)");
  expect(src).toContain("trinnexLovableToolsFor(winner,");
  expect(src).not.toMatch(/lovableTools\.search_trinnex|lovableTools\["search_trinnex"\]/);
  // both executors pass the resolved owner (AC-C7)
  expect(src.match(/dispatchTrinnexTool\(winner\.id, [^)]*, trinnexOwner\)/g)?.length).toBe(2);
});
