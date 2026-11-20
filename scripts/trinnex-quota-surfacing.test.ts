// WHAT:          Embedding failures and a missing OpenAI key are surfaced by KIND (org rule: log the failure kind,
//                surface quota failures): the embed quota path reaches the same alert as fact extraction, and a
//                missing key is recorded on the item instead of a silent "0 facts".
// WHY:           Verifier loop 1, claim 3 LOWs (VERIFY-trinnex-workspace-1.md): an embed-step quota failure failed the
//                item but never reached the ai-quota bell; extractTriplesDetailed returned failureKind null with no key.
// SUPERSEDES:    nothing. SUPERSEDED-BY: nothing -- current.
// EVIDENCE:      docs/qc-evidence/BUILD-trinnex-integration.md "Verifier loop-1 fix round". Run: bun test scripts/trinnex-quota-surfacing.test.ts
import { test, expect } from "bun:test";

const SRC = `${import.meta.dir}/../src/features/huddle/lib`;
process.env.AZURE_PG_URL = "postgresql://fake:fake@localhost:5432/fake";

const chunks: Array<{ id: string; source: string }> = [];
let seq = 0;
const fakePool = {
  query: async (sql: string, p: unknown[] = []) => {
    if (/INSERT INTO rag_chunks/.test(sql)) {
      const id = `c${++seq}`;
      chunks.push({ id, source: String(p[3]) });
      return { rows: [{ id }] };
    }
    if (/INSERT INTO rag_triples/.test(sql)) return { rows: [{ id: `t${++seq}` }] };
    if (/^\s*DELETE FROM rag_chunks/.test(sql)) {
      const sources = p[0] as string[];
      const gone = chunks.filter((c) => sources.includes(c.source));
      for (const g of gone) chunks.splice(chunks.indexOf(g), 1);
      return { rows: gone };
    }
    return { rows: [] };
  },
};

const mem = await import(`${SRC}/trinnex/memory.server.ts`);
const lib = await import(`${SRC}/trinnex/library.server.ts`);
const core = await import(`${SRC}/trinnex/library-core.ts`);
const { isQuotaError } = await import(`${SRC}/fallbacks.ts`);

const seg = (n: number) => Array.from({ length: n }, (_, i) => ({ text: `Page ${i + 1} words. `.repeat(150), page: String(i + 1) }));
const input = (id: string) => ({ sourceId: id, sourceKind: "upload" as const, title: "Test-q.pdf", date: null, participants: [], segments: seg(3), ownerEmail: "owner@x.com", series: null });

function setup(embed: () => Promise<number[]>, extract?: () => Promise<{ triples: unknown[]; failureKind: string | null }>) {
  const reported: string[] = [];
  mem.__setTrinnexDepsForTest({
    getPool: () => fakePool,
    configured: () => true,
    embed,
    extractTriples: extract ?? (async () => ({ triples: [], failureKind: null })),
    reportFailure: async (kind: string) => {
      reported.push(kind);
    },
  });
  return reported;
}

test("QUOTA1 an EMBEDDING quota failure goes to the same alert path as facts (reportFailure with the kind) and fails the item as ai_quota", async () => {
  let n = 0;
  const reported = setup(async () => {
    if (++n === 2) throw new Error(`OpenAI embeddings 429: {"error":{"message":"You exceeded your current quota","type":"insufficient_quota","code":"insufficient_quota"}}`);
    return new Array(3072).fill(0.01);
  });
  let err: unknown = null;
  try {
    await mem.ingestTrinnexSource(input("q1"));
  } catch (e) {
    err = e;
  }
  expect((err as { kind?: string })?.kind).toBe("429 insufficient_quota");
  expect(reported).toEqual(["429 insufficient_quota"]);
  // The alert path classifies the reported kind exactly like the fact path's (trinnexAlertError -> isQuotaError).
  expect(isQuotaError(mem.trinnexAlertError(reported[0]).message)).toBe(true);
  expect(lib.ingestFailReason(err)).toBe("ai_quota");
  // the message carries no provider text
  expect(String((err as Error).message)).toBe("OpenAI embeddings 429 insufficient_quota");
});

test("QUOTA2 embedFailureKind reads status + code only, and every other kind is still reported", async () => {
  expect(mem.embedFailureKind(new Error(`OpenAI embeddings 500: {"error":{"message":"boom secret text"}}`))).toBe("500");
  expect(mem.embedFailureKind(new Error(`OpenAI embeddings 429: {"error":{"code":"rate_limit_exceeded"}}`))).toBe("429 rate_limit_exceeded");
  expect(mem.embedFailureKind(new Error("fetch failed"))).toBe("embed_error");
  const reported = setup(async () => {
    throw new Error(`OpenAI embeddings 500: {"error":{"message":"boom"}}`);
  });
  await mem.ingestTrinnexSource(input("q2")).catch(() => {});
  expect(reported).toEqual(["500"]);
});

test("NOKEY1 a missing OpenAI key at the EMBED step is kind no_api_key, reported, and shown on the item", async () => {
  const reported = setup(async () => {
    throw new Error("OPENAI_API_KEY not configured (required for embeddings)");
  });
  let err: unknown = null;
  await mem.ingestTrinnexSource(input("k1")).catch((e: unknown) => (err = e));
  expect((err as { kind?: string }).kind).toBe("no_api_key");
  expect(reported).toEqual(["no_api_key"]);
  expect(lib.ingestFailReason(err)).toBe("no_api_key");
  expect(core.FAIL_LABEL.no_api_key).toBe("AI key not set");
});

test("NOKEY2 extractTriplesDetailed with no key returns failureKind no_api_key (extractTriples still returns [])", async () => {
  const saved = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    const t = await import(`${SRC}/rag/triples.server.ts`);
    expect(await t.extractTriplesDetailed("Dana owns the budget")).toEqual({ triples: [], failureKind: "no_api_key" });
    expect(await t.extractTriples("Dana owns the budget")).toEqual([]);
  } finally {
    if (saved !== undefined) process.env.OPENAI_API_KEY = saved;
  }
});

test("NOKEY3 facts with no key: passages kept, factsFailure no_api_key, the Library item says so instead of 0 facts", async () => {
  chunks.length = 0;
  const reported = setup(async () => new Array(3072).fill(0.01), async () => ({ triples: [], failureKind: "no_api_key" }));
  const r = await mem.ingestTrinnexSource(input("k3"));
  expect(r.chunks).toBeGreaterThan(0);
  expect(r.facts).toBe(0);
  expect(r.factsFailure).toBe("no_api_key");
  expect(reported).toEqual(["no_api_key"]);
  expect(core.factsFailureNotice(core.factsFailReason("no_api_key"))).toBe("Facts not extracted: AI key not set");
  // through the real pipeline: the item stays searchable and carries the kind
  const patches: Array<Record<string, unknown>> = [];
  const status = await lib.runPipeline(
    { id: crypto.randomUUID(), ownerEmail: "owner@x.com", name: "Test-k.pdf", kind: "document", blobPath: "p", docDate: null, category: "General", participants: [], speakerMap: {}, chunks: 0, facts: 0, status: "uploaded" } as never,
    {
      getBytes: async () => new Uint8Array([1]),
      deleteBytes: async () => true,
      extract: async () => ({ segments: seg(2), cues: [] }),
      memory: { configured: () => true, ingest: (i: never) => mem.ingestTrinnexSource({ ...(i as object), series: null } as never), remove: async () => ({ chunks: 0, facts: 0 }) },
      update: async (_id: string, p: Record<string, unknown>) => {
        patches.push(p);
      },
      deleteRow: async () => {},
    } as never,
  );
  expect(status).toBe("searchable");
  expect(patches.at(-1)).toEqual({ status: "searchable", failReason: "facts:no_api_key" });
});
