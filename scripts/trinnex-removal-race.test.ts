// WHAT:          Library Remove racing the processing worker, at every pipeline stage (Read, Split, Facts, Searchable),
//                in one process and across two (the remove request and the worker in different server instances).
// WHY:           Verifier loop 1, VA9 (docs/qc-evidence/VERIFY-trinnex-workspace-1.md claim 2b): Remove during an
//                in-flight ingest returned "removed", deleted the row and blob, and 5 passages + 3 facts written
//                afterwards survived, searchable, with no Library row left to remove them from.
// SUPERSEDES:    nothing. SUPERSEDED-BY: nothing -- current.
// EVIDENCE:      docs/qc-evidence/BUILD-trinnex-integration.md "Verifier loop-1 fix round (2026-11-20)".
//                Run: bun test scripts/trinnex-removal-race.test.ts
//
// The invariant every test checks: after Remove returns, no passage or fact is WRITTEN, and at no moment does a
// passage or fact exist while its Library row is gone. Real runPipeline / runRemoval / ingestTrinnexSource /
// deleteTrinnexSource; the Trinnex DB and the Library row are in-memory fakes. No network, no real data.
import { test, expect } from "bun:test";

const SRC = `${import.meta.dir}/../src/features/huddle/lib`;
process.env.AZURE_PG_URL = "postgresql://fake:fake@localhost:5432/fake";

type Row = Record<string, unknown> & { id: string };
const chunks: Row[] = [];
const triples: Row[] = [];
let seq = 0;
/** Writes (INSERTs) into the Trinnex store that happened after Remove returned. Must stay 0. */
let lateWrites = 0;
/** Moments where a Trinnex row existed while its Library row did not. Must stay 0. */
let orphanMoments = 0;
let removalReturned = false;
const row = { exists: true, status: "uploaded" };
const ownerOf = (c: Row) => String((c.metadata as { owner_email?: string }).owner_email ?? "").toLowerCase();
const checkOrphan = () => {
  if (!row.exists && (chunks.length > 0 || triples.length > 0)) orphanMoments++;
};
const fakePool = {
  query: async (sql: string, p: unknown[] = []) => {
    if (/INSERT INTO rag_chunks/.test(sql)) {
      if (removalReturned) lateWrites++;
      const [scope, agent_id, text, source, , metadata] = p as [string, string, string, string, unknown, Record<string, unknown>];
      const id = `c${++seq}`;
      chunks.push({ id, scope, agent_id, text, source, metadata });
      checkOrphan();
      return { rows: [{ id }] };
    }
    if (/INSERT INTO rag_triples/.test(sql)) {
      if (removalReturned) lateWrites++;
      const [scope, agent_id, subject, predicate, object, , source_chunk_id] = p as string[];
      const id = `t${++seq}`;
      triples.push({ id, scope, agent_id, subject, predicate, object, source_chunk_id });
      checkOrphan();
      return { rows: [{ id }] };
    }
    if (/^\s*DELETE FROM rag_triples/.test(sql)) {
      const [sources, owner, keys] = p as [string[], string, string[]];
      const own = new Set(chunks.filter((c) => sources.includes(c.source as string) && ownerOf(c) === owner).map((c) => c.id));
      const gone = triples.filter((t) => keys.includes(t.agent_id as string) || own.has(t.source_chunk_id as string));
      for (const g of gone) triples.splice(triples.indexOf(g), 1);
      return { rows: gone.map((g) => ({ id: g.id })) };
    }
    if (/^\s*DELETE FROM rag_chunks/.test(sql)) {
      const [sources, owner] = p as [string[], string];
      const gone = chunks.filter((c) => sources.includes(c.source as string) && ownerOf(c) === owner);
      for (const g of gone) chunks.splice(chunks.indexOf(g), 1);
      return { rows: gone.map((g) => ({ id: g.id })) };
    }
    return { rows: [] };
  },
};

const mem = await import(`${SRC}/trinnex/memory.server.ts`);
// Two module instances = two server processes: in-process tombstones are NOT shared between them.
const workerLib = await import(`${SRC}/trinnex/library.server.ts?proc=worker`);
const removerLib = await import(`${SRC}/trinnex/library.server.ts?proc=remover`);

type Stage = "read" | "split" | "facts" | "searchable" | "embed";

/** Run the pipeline, pause it at `stage`, Remove, resume. Returns what is left. */
async function race(stage: Stage, opts: { crossProcess: boolean; leased: boolean }) {
  chunks.length = 0;
  triples.length = 0;
  lateWrites = 0;
  orphanMoments = 0;
  removalReturned = false;
  row.exists = true;
  row.status = "uploaded";
  let ingestCalls = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let reached = false;
  const pause = async (s: Stage) => {
    if (s === stage && !reached) {
      reached = true;
      await gate;
    }
  };
  let embeds = 0;
  mem.__setTrinnexDepsForTest({
    getPool: () => fakePool,
    configured: () => true,
    embed: async () => {
      embeds++;
      if (embeds === 2) await pause("embed");
      return new Array(3072).fill(0.01);
    },
    extractTriples: async (text: string) => {
      await pause("facts");
      return { triples: [{ subject: "Vendor", predicate: "said", object: text.slice(0, 20), confidence: 0.9 }], failureKind: null };
    },
    reportFailure: async () => {},
  });
  const id = crypto.randomUUID();
  let leaseHeld = true; // the worker holds the processing lease for the whole run
  const deps = {
    getBytes: async () => new Uint8Array([1]),
    deleteBytes: async () => true,
    extract: async () => {
      await pause("read");
      return { segments: [1, 2, 3].map((p) => ({ text: `Page ${p} words. `.repeat(150), page: String(p) })), cues: [] };
    },
    memory: {
      configured: () => true,
      ingest: (input: Parameters<typeof mem.ingestTrinnexSource>[0]) => {
        ingestCalls++;
        return mem.ingestTrinnexSource({ ...input, series: null });
      },
      remove: (sid: string, owner: string) => mem.deleteTrinnexSource(sid, owner),
    },
    update: async (_id: string, p: { status?: string }) => {
      // Live SQL guard: a pipeline write never overwrites removing / remove_incomplete; a deleted row updates 0 rows.
      if (!row.exists) return;
      const removalWrite = p.status === "removing" || p.status === "remove_incomplete";
      if (!removalWrite && (row.status === "removing" || row.status === "remove_incomplete")) return;
      if (p.status) row.status = p.status;
      if (p.status === "split") await pause("split");
      if (p.status === "searchable") await pause("searchable");
    },
    deleteRow: async () => {
      checkOrphan();
      row.exists = false;
      checkOrphan();
    },
    isRemoved: async () => !row.exists || row.status === "removing" || row.status === "remove_incomplete",
    beginRemoval: async () => {
      const inFlight = opts.leased && leaseHeld;
      row.status = "removing";
      return { inFlight };
    },
  };
  const item = { id, ownerEmail: "owner@x.com", name: "Test-race.pdf", kind: "document", blobPath: "p", docDate: null, category: "General", participants: [], speakerMap: {}, chunks: 0, facts: 0, status: "uploaded" };
  const pipeline = workerLib.runPipeline(item as never, deps as never);
  while (!reached) await new Promise((r) => setTimeout(r, 1));
  const remover = opts.crossProcess ? removerLib : workerLib;
  const removal = await remover.runRemoval({ ...item, status: row.status } as never, deps as never);
  const rowAtRemovalReturn = row.exists;
  const chunksAtRemovalReturn = chunks.length + triples.length;
  removalReturned = true;
  release();
  await pipeline;
  leaseHeld = false;
  return { removal, rowAtRemovalReturn, chunksAtRemovalReturn, left: chunks.length, factsLeft: triples.length, rowExists: row.exists, ingestCalls };
}

for (const stage of ["read", "split", "embed", "facts", "searchable"] as const) {
  test(`RACE-${stage} Remove during the ${stage} stage leaves no passage, fact, file or row, and nothing is written after Remove`, async () => {
    const r = await race(stage, { crossProcess: false, leased: false });
    console.log(`RACE-${stage}`, JSON.stringify(r));
    expect(r.removal.removed).toBe(true);
    expect(r.left).toBe(0);
    expect(r.factsLeft).toBe(0);
    expect(r.rowExists).toBe(false);
    expect(lateWrites).toBe(0);
    expect(orphanMoments).toBe(0);
    if (stage === "read" || stage === "split") expect(r.ingestCalls).toBe(0); // never started embedding
  });
}

for (const stage of ["read", "split", "embed", "facts", "searchable"] as const) {
  test(`XPROC-${stage} Remove from ANOTHER process while the worker holds the lease: the row stays until the worker has removed everything`, async () => {
    const r = await race(stage, { crossProcess: true, leased: true });
    console.log(`XPROC-${stage}`, JSON.stringify(r));
    // The remove request defers to the worker, so the row still points at whatever exists at that moment.
    expect(r.removal.pending).toBe(true);
    expect(r.rowAtRemovalReturn).toBe(true);
    // The worker sees the DB tombstone (status removing) before its next write and finishes the removal.
    expect(r.left).toBe(0);
    expect(r.factsLeft).toBe(0);
    expect(r.rowExists).toBe(false);
    expect(lateWrites).toBe(0);
    expect(orphanMoments).toBe(0);
  });
}

test("XPROC-free Remove from another process with NO worker lease removes everything at once", async () => {
  // Not raced: the pipeline already finished (searchable), no lease is held.
  chunks.length = 0;
  triples.length = 0;
  const r = await race("searchable", { crossProcess: true, leased: false });
  expect(r.removal.removed).toBe(true);
  expect(r.left + r.factsLeft).toBe(0);
  expect(r.rowExists).toBe(false);
  expect(orphanMoments).toBe(0);
});
