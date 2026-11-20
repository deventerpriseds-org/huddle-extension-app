// WHAT:          Guard for AC-M3: the rag store functions take their Postgres pool as a parameter, and the
//                EXISTING store (azurePgStore, on the shared Huddle pool) still sends byte-for-byte the SQL and
//                params it sent before the refactor. A second store over a Trinnex pool writes only there.
// WHY:           Trinnex needs the SAME writeChunk/searchChunks/writeTriples/lookupTriples against a second
//                database (AC-M3 forbids a copy). The refactor must be invisible to every current caller.
// SUPERSEDES:    nothing. SUPERSEDED-BY: nothing -- current.
// EVIDENCE:      scripts/fixtures/rag-store-sql.golden.json was captured from the PRE-refactor
//                azure-pg.server.ts (origin/claude_trinnex-workspace dd88c0f2) with GOLDEN_WRITE=1.
//                Run: bun test scripts/rag-store-pool-param.test.ts
// Failing tests also print `FAIL <name>` so scripts/mutate.sh can attribute them.
import { test, expect, mock } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";

const SRC = `${import.meta.dir}/../src/features/huddle/lib`;
const P = (rel: string) => require.resolve(`${SRC}/${rel}`);
const GOLDEN = `${import.meta.dir}/fixtures/rag-store-sql.golden.json`;

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
// azurePgStore caches its pool on first use, so the 42P10 path is driven by a flag on the SAME pool.
const failNext = { on: false };
function fakePool(calls: Call[]) {
  return {
    query: async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      if (failNext.on && /ON CONFLICT/.test(sql)) {
        failNext.on = false;
        const e = new Error("no unique or exclusion constraint matching the ON CONFLICT specification") as Error & {
          code: string;
        };
        e.code = "42P10";
        throw e;
      }
      return { rows: [{ id: "row-1", text: "t", score: 0.5, scope: "global" }] };
    },
  };
}

const sharedCalls: Call[] = [];
const sharedPool = fakePool(sharedCalls);
mock.module(P("db/shared-pool.server.ts"), () => ({
  SHARED_POOL_MAX: 8,
  getSharedPool: () => sharedPool,
}));
process.env.AZURE_PG_URL = "postgresql://fake:fake@localhost:5432/fake";
const VEC = [0.1, 0.2, 0.3];

const mod = await import(`${SRC}/rag/azure-pg.server.ts`);
const { azurePgStore } = mod;

async function exercise(store: typeof azurePgStore): Promise<void> {
  await store.writeChunk({
    scope: "global",
    text: "hello world",
    source: "huddle:all-members",
    embedding: VEC,
    authorAgentIds: ["iris-chase"],
    ownerEntraOid: "oid-1",
  });
  await store.writeChunk({ scope: "agent", agentId: "finn-reid", text: "x", embedding: VEC });
  await store.writeTriples([
    { scope: "global", subject: "user", predicate: "likes", object: "tea", sourceChunkId: "c1", supersede: true },
    { scope: "agent", agentId: "a", subject: "s", predicate: "p", object: "o", confidence: 0.4 },
  ]);
  await store.searchChunks({ query: "q", queryVec: VEC, mode: "shared", agentId: "iris-chase", k: 20 });
  await store.searchChunks({ query: "q", queryVec: VEC, mode: "private", agentId: "iris-chase" });
  await store.searchChunks({ query: "q", queryVec: VEC, mode: "readonly-shared" });
  await store.searchChunks({ query: "q", queryVec: VEC, scope: "global", k: 50 });
  await store.lookupTriples({ subject: "user", predicate: "likes", query: "tea", excludeSuperseded: true, mode: "shared", agentId: "x" });
  await store.lookupTriples({ mode: "private", agentId: "x", k: 99 });
}

t("M3a existing azurePgStore SQL + params are byte-for-byte the pre-refactor golden", async () => {
  sharedCalls.length = 0;
  await exercise(azurePgStore);
  const main = [...sharedCalls];
  // the 42P10 fallback path too (ON CONFLICT refused -> plain INSERT)
  sharedCalls.length = 0;
  failNext.on = true;
  await azurePgStore.writeChunk({ scope: "global", text: "fb", embedding: VEC });
  const got = { main, fallback: [...sharedCalls] };
  if (got.fallback.length !== 2) throw new Error(`42P10 fallback not exercised: ${got.fallback.length} calls`);
  if (process.env.GOLDEN_WRITE === "1") {
    writeFileSync(GOLDEN, JSON.stringify(got, null, 2) + "\n");
    console.log(`wrote golden: ${GOLDEN}`);
  }
  const want = JSON.parse(readFileSync(GOLDEN, "utf8"));
  expect(JSON.parse(JSON.stringify(got))).toEqual(want);
});

t("M3b a store built over a second pool sends the same SQL there and NOTHING to the shared pool", async () => {
  if (typeof mod.createRagStore !== "function") throw new Error("createRagStore is not exported");
  sharedCalls.length = 0;
  const otherCalls: Call[] = [];
  const other = fakePool(otherCalls);
  const store = mod.createRagStore({ getPool: () => other, label: "Trinnex Postgres" });
  await exercise(store);
  expect(sharedCalls.length).toBe(0);
  const want = JSON.parse(readFileSync(GOLDEN, "utf8"));
  expect(JSON.parse(JSON.stringify(otherCalls))).toEqual(want.main);
});

t("M3c there is still exactly one writeChunk/searchChunks/writeTriples/lookupTriples implementation", () => {
  const src = readFileSync(P("rag/azure-pg.server.ts"), "utf8");
  for (const fn of ["writeChunk", "writeTriples", "searchChunks", "lookupTriples"]) {
    const n = (src.match(new RegExp(`async ${fn}\\(`, "g")) ?? []).length;
    expect(`${fn}:${n}`).toBe(`${fn}:1`);
  }
});
