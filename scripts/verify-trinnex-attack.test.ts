// WHAT:          Verifier loop-1 attack tests for PR #289 (Trinnex workspace): URL guard vs what pg ACTUALLY
//                connects to, every-agent gate with a pool spy, and delete/re-ingest semantics against an
//                in-memory model of rag_chunks / rag_triples.
// WHY:           Independent check of the isolation and delete claims (VERIFY-trinnex-workspace-1.md).
// SUPERSEDES:    nothing. SUPERSEDED-BY: nothing -- current.
// EVIDENCE:      bun test scripts/verify-trinnex-attack.test.ts
import { test, expect, mock } from "bun:test";
import parsePg from "pg-connection-string";

const SRC = `${import.meta.dir}/../src/features/huddle/lib`;

// ── 1. URL guard: compare against pg-connection-string's own parse ──────────────────────────────────
const { trinnexUrlRefusal } = await import(`${SRC}/db/shared-pool.server.ts`);
const PERSONAL = "postgresql://adm:pw@eds-postgresql.postgres.database.azure.com:5432/RAG_AI_Agents?sslmode=require";
const H = "eds-postgresql.postgres.database.azure.com";
const SPELLINGS = [
  `postgresql://a:b@${H}:5432/RAG_AI_Agents`,
  `postgres://a:b@${H}/rag_ai_agents`,
  `postgresql://a:b@${H}/RAG%5FAI%5FAgents`,
  `postgresql://a:b@${H}/RAG_AI_Agents#frag`,
  `postgresql://a:b@${H}/RAG_AI_Agents?sslmode=require`,
  `  postgresql://a:b@${H}/RAG_AI_Agents  `,
  `postgresql://a:b@${H}/RAG_AI_\tAgents`,
  `postgresql://a:b@${H}/RAG_AI_Agents\n`,
  `postgresql://a:b@${H}/%52AG_AI_Agents`,
  `postgresql://a:b@${H}//RAG_AI_Agents`,
  `POSTGRESQL://a:b@${H}/RAG_AI_Agents`,
  `postgresql://a:b@${H.toUpperCase()}/RAG_AI_Agents`,
  `postgresql://a:b@10.0.0.1/RAG_AI_Agents`,
  `postgresql://a:b@${H}/`, // pg would default the db to the USER name
  `postgresql://RAG_AI_Agents:b@${H}/`, // ... which here is the personal DB
  `postgresql://a:b@${H}`,
  `socket://a:b@/var/run/pg?db=RAG_AI_Agents`,
  `/var/run/pg RAG_AI_Agents`,
  `host=${H} dbname=RAG_AI_Agents`,
  `postgresql://a:b@${H}/RAG_AI_Agents%zz`,
  PERSONAL,
];
const LEGIT = [
  `postgresql://a:b@${H}:5432/Trinnex_Memory?sslmode=require`,
  `postgresql://a:b@${H}/Trinnex_Memory`,
];

test("VA1 every spelling that pg would resolve to the personal DB (or to an unknown db) is refused", () => {
  const leaks: string[] = [];
  for (const u of SPELLINGS) {
    const code = trinnexUrlRefusal(u, PERSONAL);
    let pgDb: string | null | undefined = "(parse threw)";
    try {
      const c = parsePg.parse(u.trim()) as { database?: string | null; user?: string };
      pgDb = c.database ?? `(null -> user ${c.user})`;
    } catch {
      /* pg cannot open it either */
    }
    console.log(`VA1 ${JSON.stringify(u)} pg.database=${JSON.stringify(pgDb)} refusal=${code}`);
    if (code === null) leaks.push(u);
  }
  expect(leaks).toEqual([]);
});

test("VA2 the legit Trinnex_Memory URLs are accepted (no over-refusal of the real setting)", () => {
  for (const u of LEGIT) expect(trinnexUrlRefusal(u, PERSONAL)).toBeNull();
});

test("VA3 TRINNEX_PG_URL byte-identical to AZURE_PG_URL is refused even if the db name differs", () => {
  const same = `postgresql://a:b@${H}/Other_DB`;
  expect(trinnexUrlRefusal(same, same)).not.toBeNull();
});

// ── 2. every agent except iris-chase / eli-vaughn: no tool, executor refuses, Trinnex pool untouched ──
type Row = Record<string, unknown> & { id: string };
const chunks: Row[] = [];
const triples: Row[] = [];
let seq = 0;
let trinnexQueries = 0;
const fakePool = {
  query: async (sql: string, p: unknown[] = []) => {
    trinnexQueries++;
    if (/INSERT INTO rag_chunks/.test(sql)) {
      const [scope, agent_id, text, source, , metadata] = p as [string, string, string, string, unknown, Record<string, unknown>];
      const hit = chunks.find((c) => c.scope === scope && c.agent_id === agent_id && c.source === source && c.text === text);
      if (hit) return { rows: [{ id: hit.id }] };
      const id = `c${++seq}`;
      chunks.push({ id, scope, agent_id, text, source, metadata });
      return { rows: [{ id }] };
    }
    if (/INSERT INTO rag_triples/.test(sql)) {
      const [scope, agent_id, subject, predicate, object, , source_chunk_id] = p as string[];
      const hit = triples.find(
        (t) => t.scope === scope && t.agent_id === agent_id && t.subject === subject && t.predicate === predicate && t.object === object && !t.superseded_at,
      );
      if (hit) return { rows: [{ id: hit.id }] };
      const id = `t${++seq}`;
      triples.push({ id, scope, agent_id, subject, predicate, object, source_chunk_id });
      return { rows: [{ id }] };
    }
    if (/^\s*DELETE FROM rag_triples/.test(sql)) {
      const [sources, owner, keys] = p as [string[], string, string[]];
      const ownChunkIds = new Set(
        chunks.filter((c) => sources.includes(c.source as string) && String((c.metadata as { owner_email?: string }).owner_email ?? "").toLowerCase() === owner).map((c) => c.id),
      );
      const gone = triples.filter((t) => keys.includes(t.agent_id as string) || ownChunkIds.has(t.source_chunk_id as string));
      for (const g of gone) triples.splice(triples.indexOf(g), 1);
      return { rows: gone.map((g) => ({ id: g.id })) };
    }
    if (/^\s*DELETE FROM rag_chunks/.test(sql)) {
      const [sources, owner] = p as [string[], string];
      const gone = chunks.filter((c) => sources.includes(c.source as string) && String((c.metadata as { owner_email?: string }).owner_email ?? "").toLowerCase() === owner);
      for (const g of gone) chunks.splice(chunks.indexOf(g), 1);
      // FK ON DELETE SET NULL (BOOTSTRAP_SQL): surviving triples pointing at a deleted chunk get NULL.
      for (const t of triples) if (gone.some((g) => g.id === t.source_chunk_id)) t.source_chunk_id = null;
      return { rows: gone.map((g) => ({ id: g.id })) };
    }
    return { rows: [] };
  },
};

const mem = await import(`${SRC}/trinnex/memory.server.ts`);
const search = await import(`${SRC}/trinnex/search.ts`);
const { AGENTS } = await import(`${SRC}/../data/agents.ts`);
mem.__setTrinnexDepsForTest({
  getPool: () => fakePool,
  configured: () => true,
  embed: async () => new Array(3072).fill(0.01),
  extractTriples: async (text: string) => ({ triples: [{ subject: "Vendor", predicate: "said", object: text.slice(0, 20), confidence: 0.9 }], failureKind: null }),
  reportFailure: async () => {},
});

test("VA4 enumerate ALL agents: only iris-chase + eli-vaughn get the tool; every other agent's executor call makes 0 Trinnex queries", async () => {
  const allowed: string[] = [];
  for (const a of AGENTS) {
    const tools = search.trinnexToolsFor(a);
    const lov = search.trinnexLovableToolsFor(a, (d: unknown) => d);
    if (tools.length > 0 || Object.keys(lov).length > 0) allowed.push(a.id);
    if (a.id === "iris-chase" || a.id === "eli-vaughn") continue;
    const before = trinnexQueries;
    const out = await mem.dispatchTrinnexTool(a.id, { query: "vendor review" }, "owner@x.com");
    expect(out).toContain("not available");
    expect(trinnexQueries).toBe(before);
  }
  // unknown / spoofed agent id
  const before = trinnexQueries;
  expect(await mem.dispatchTrinnexTool("nobody", { query: "x" }, "owner@x.com")).toContain("not available");
  expect(trinnexQueries).toBe(before);
  expect(allowed.sort()).toEqual(["eli-vaughn", "iris-chase"]);
});

test("VA5 search with no / blank owner never queries the Trinnex DB", async () => {
  const before = trinnexQueries;
  for (const o of [null, undefined, "", "   "]) {
    const r = await mem.searchTrinnex({ query: "vendor" }, o as string | null);
    expect(r.status).toBe("unavailable");
  }
  expect(trinnexQueries).toBe(before);
});

const seg = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ text: `Passage number ${i} about the vendor review outcome. `.repeat(40), speaker: "Michael R.", at: `00:0${i}:00` }));

test("VA6 delete means gone: 0 chunks, 0 facts (superseded included) for owner+source; other owner untouched", async () => {
  chunks.length = 0;
  triples.length = 0;
  const base = { sourceKind: "meeting" as const, title: "Test-VA6", date: "2026-11-01", participants: [] };
  await mem.ingestTrinnexSource({ ...base, sourceId: "m1", segments: seg(4), ownerEmail: "Owner@X.com" });
  await mem.ingestTrinnexSource({ ...base, sourceId: "m1", segments: seg(2), ownerEmail: "other@y.com" });
  await mem.ingestTrinnexSource({ ...base, sourceId: "m2", segments: seg(2), ownerEmail: "owner@x.com" });
  // a superseded fact on the owner's source (written by some older path)
  const c0 = chunks.find((c) => c.source === "trinnex:meeting:m1" && (c.metadata as { owner_email: string }).owner_email === "owner@x.com")!;
  triples.push({ id: "tsup", scope: "agent", agent_id: mem.trinnexFactKey("trinnex:meeting:m1", "owner@x.com"), subject: "a", predicate: "b", object: "old", source_chunk_id: c0.id, superseded_at: "2026-01-01" });
  const otherBefore = chunks.filter((c) => (c.metadata as { owner_email: string }).owner_email === "other@y.com").length;
  const m2Before = chunks.filter((c) => c.source === "trinnex:meeting:m2").length;
  expect(otherBefore).toBeGreaterThan(0);
  // a DIFFERENT owner deleting by the same id removes nothing of the owner's
  await mem.deleteTrinnexSource("m1", "intruder@z.com");
  const ownerM1 = () => chunks.filter((c) => c.source === "trinnex:meeting:m1" && (c.metadata as { owner_email: string }).owner_email === "owner@x.com");
  expect(ownerM1().length).toBeGreaterThan(0);
  const r = await mem.deleteTrinnexSource("m1", " OWNER@x.com ");
  expect(r.chunks).toBeGreaterThan(0);
  expect(ownerM1().length).toBe(0);
  const ownerFactKey = mem.trinnexFactKey("trinnex:meeting:m1", "owner@x.com");
  expect(triples.filter((t) => t.agent_id === ownerFactKey).length).toBe(0);
  expect(triples.filter((t) => t.source_chunk_id === null).length).toBe(0); // no orphan facts left searchable
  expect(chunks.filter((c) => (c.metadata as { owner_email: string }).owner_email === "other@y.com").length).toBe(otherBefore);
  expect(chunks.filter((c) => c.source === "trinnex:meeting:m2").length).toBe(m2Before);
  await expect(mem.deleteTrinnexSource("m2", "")).rejects.toThrow();
  await expect(mem.deleteTrinnexSource("m2", "   ")).rejects.toThrow();
  expect(chunks.filter((c) => c.source === "trinnex:meeting:m2").length).toBe(m2Before);
});

test("VA7 re-ingest replaces EVERY earlier row (shorter re-ingest leaves no stale passage/fact) and every fact has an existing source chunk", async () => {
  chunks.length = 0;
  triples.length = 0;
  const base = { sourceKind: "upload" as const, title: "Test-VA7", date: null, participants: [], ownerEmail: "owner@x.com" };
  await mem.ingestTrinnexSource({ ...base, sourceId: "d1", segments: [1, 2, 3, 4, 5].map((p) => ({ text: `Page ${p} text. `.repeat(200), page: String(p) })) });
  const firstIds = new Set(chunks.map((c) => c.id));
  await mem.ingestTrinnexSource({ ...base, sourceId: "d1", segments: [{ text: "Only page now.", page: "1" }] });
  expect(chunks.some((c) => firstIds.has(c.id))).toBe(false);
  expect(chunks.length).toBe(1);
  const ids = new Set(chunks.map((c) => c.id));
  for (const t of triples) expect(ids.has(t.source_chunk_id as string)).toBe(true);
});

test("VA8 extraction failure (quota) still stores passages, stores 0 facts, and calls the alert with the kind", async () => {
  chunks.length = 0;
  triples.length = 0;
  const reported: string[] = [];
  mem.__setTrinnexDepsForTest({
    getPool: () => fakePool,
    configured: () => true,
    embed: async () => new Array(3072).fill(0.01),
    extractTriples: async () => ({ triples: [], failureKind: "429 insufficient_quota" }),
    reportFailure: async (k: string) => {
      reported.push(k);
    },
  });
  const r = await mem.ingestTrinnexSource({ sourceKind: "upload", sourceId: "q1", title: "Test-VA8", date: null, participants: [], ownerEmail: "o@x.com", segments: [{ text: "x".repeat(4000), page: "1" }] });
  expect(r.chunks).toBeGreaterThan(0);
  expect(chunks.length).toBe(r.chunks);
  expect(triples.length).toBe(0);
  expect(r.factsFailure).toBe("429 insufficient_quota");
  expect(reported).toEqual(["429 insufficient_quota"]);
});
