// WHAT:          RED-TEAM failing tests for Trinnex isolation and delete (shared-pool.server.ts getTrinnexPool guard,
//                memory.server.ts deleteTrinnexSource / ingestTrinnexSource, huddle.functions.ts reply persistence).
// WHY:           Tier 1 red-team pre-pass, docs/qc-evidence/REDTEAM-trinnex-workspace.md. Isolation is the reason the
//                owner chose a separate database; each test here is a path where Trinnex content or deletes cross a line.
// SUPERSEDES:    nothing. SUPERSEDED-BY: nothing -- current.
// EVIDENCE:      docs/qc-evidence/REDTEAM-trinnex-workspace.md rows I1-I5. Run: bun test scripts/trinnex-redteam-isolation.test.ts
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";

const LIB = `${import.meta.dir}/../src/features/huddle/lib`;
process.env.AZURE_PG_URL = "postgresql://fake:fake@localhost:5432/fake";

async function guardRefuses(url: string, tag: string): Promise<boolean> {
  process.env.TRINNEX_PG_URL = url;
  const mod = await import(`${LIB}/db/shared-pool.server.ts?rt=${tag}`);
  try {
    const p = mod.getTrinnexPool();
    await p.end?.().catch?.(() => {});
    return false;
  } catch {
    return true;
  }
}

test("RT-I1 TRINNEX_PG_URL naming the personal DB percent-encoded (RAG%5FAI%5FAgents) is refused", async () => {
  // pg-connection-string decodes the path: database = "RAG_AI_Agents".
  expect(await guardRefuses("postgresql://u:p@eds-postgresql.example:5432/RAG%5FAI%5FAgents?sslmode=require", "enc")).toBe(true);
});

test("RT-I2 TRINNEX_PG_URL naming the personal DB with a trailing #fragment is refused", async () => {
  // pg-connection-string ignores the fragment: database = "RAG_AI_Agents".
  expect(await guardRefuses("postgresql://u:p@eds-postgresql.example:5432/RAG_AI_Agents#x", "frag")).toBe(true);
});

type Call = { sql: string; params: unknown[] | undefined };
const calls: Call[] = [];
const pool = {
  query: async (sql: string, params?: unknown[]) => {
    calls.push({ sql, params });
    if (/INSERT INTO rag_(chunks|triples)/.test(sql)) return { rows: [{ id: `id-${calls.length}` }] };
    return { rows: [] };
  },
};
const mem = await import(`${LIB}/trinnex/memory.server.ts`);
mem.__setTrinnexDepsForTest({
  getPool: () => pool,
  configured: () => true,
  embed: async () => [0.1, 0.2, 0.3],
  extractTriples: async () => ({ triples: [], failureKind: null }),
  reportFailure: async () => {},
});

const base = {
  sourceId: "ff-shared-1",
  sourceKind: "meeting" as const,
  title: "Test-Edited title",
  date: "2026-11-18T15:00:00Z",
  series: "Engineering Leaders",
  participants: [],
  segments: [{ text: "Test-we agreed to ship on Friday", speaker: "Michael R.", at: "00:01:05" }],
};

test("RT-I3 a second owner ingesting the SAME sourceId must not delete the first owner's passages/facts", async () => {
  calls.length = 0;
  await mem.ingestTrinnexSource({ ...base, ownerEmail: "test-owner-b@example.com" });
  const deletes = calls.filter((c) => /^\s*DELETE/i.test(c.sql));
  expect(deletes.length).toBeGreaterThan(0);
  // Every DELETE must be scoped to the ingesting owner; today it deletes `trinnex:meeting:<id>` for EVERY owner.
  for (const d of deletes) expect(JSON.stringify(d.params)).toContain("test-owner-b@example.com");
});

test("RT-I4 a meeting passage stores fireflies_title + speaker_label (AC-M4); catalog title filter reads fireflies_title", async () => {
  calls.length = 0;
  await mem.ingestTrinnexSource({ ...base, ownerEmail: "test-owner-a@example.com" });
  const ins = calls.find((c) => /INSERT INTO rag_chunks/.test(c.sql));
  expect(ins).toBeDefined();
  const meta = JSON.stringify(ins!.params);
  expect(meta).toContain("fireflies_title");
  expect(meta).toContain("speaker_label");
});

test("RT-I5 an agent reply built from search_trinnex results is NOT persisted into PERSONAL rag_chunks", () => {
  // persistResearchedMemory writes every agent reply gist (1:1 included since 2026-08-26) into the personal store as
  // scope='global', which per-turn auto-retrieval serves to EVERY agent. Iris answering from Trinnex therefore copies
  // Trinnex passages into personal memory. The block must exclude replies whose turn used search_trinnex.
  const src = readFileSync(`${LIB}/huddle.functions.ts`, "utf8");
  const start = src.indexOf("function persistResearchedMemory()");
  const end = src.indexOf("TRIPLES ARE USER-ONLY", start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  expect(src.slice(start, end)).toMatch(/search_trinnex|trinnex/i);
});
