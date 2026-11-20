// WHAT:          Verifier loop-2 attacks on Library Remove vs the processing worker (VB1-VB3). Verifier-written probe;
//                no product code is changed by it.
// WHY:           Loop 1 VA9 found derived rows surviving a Remove. The fix (removal tombstone + defer-to-worker) is
//                attacked here with three races the builder's own suite does not run: Remove twice, Remove during a
//                re-ingest after a speaker remap, and a worker that dies mid-run after Remove.
// SUPERSEDES:    nothing. SUPERSEDED-BY: nothing -- current.
// EVIDENCE:      docs/qc-evidence/VERIFY-trinnex-workspace-2.md claim 2b. Run: bun test scripts/verify-trinnex-attack-2.test.ts
//
// beginRemoval is modelled on the LIVE SQL in library.server.ts beginRemoval(). Loop-2 fix round (builder, 2026-11-20):
// the live SQL now decides in_flight from the unexpired lease ALONE, so the model follows it; LEASE1 in
// scripts/trinnex-removal-lease.test.ts pins the live SQL to that shape so this model cannot drift from it.
// (Before: lease unexpired AND old status in uploaded/read/split/facts/waiting_memory.)
import { test, expect } from "bun:test";

const SRC = `${import.meta.dir}/../src/features/huddle/lib`;
process.env.AZURE_PG_URL = "postgresql://fake:fake@localhost:5432/fake";

type Row = Record<string, unknown> & { id: string };
const chunks: Row[] = [];
const triples: Row[] = [];
let seq = 0;
let orphanMoments = 0;
let writesAfterRemovedTrue = 0;
let removedReturnedTrue = false;
let crashed = false;
let insertHook: (() => Promise<void>) | null = null;
let crashAfterThisInsert = false;
const row = { exists: true, status: "uploaded" };
const ownerOf = (c: Row) => String((c.metadata as { owner_email?: string }).owner_email ?? "").toLowerCase();
const checkOrphan = () => {
  if (!row.exists && (chunks.length > 0 || triples.length > 0)) orphanMoments++;
};
const fakePool = {
  query: async (sql: string, p: unknown[] = []) => {
    if (crashed) throw new Error("process died");
    if (/INSERT INTO rag_chunks/.test(sql)) {
      if (insertHook) {
        const h = insertHook;
        insertHook = null;
        await h();
      }
      const [scope, agent_id, text, source, , metadata] = p as [string, string, string, string, unknown, Record<string, unknown>];
      const id = `c${++seq}`;
      chunks.push({ id, scope, agent_id, text, source, metadata });
      if (crashAfterThisInsert) {
        crashAfterThisInsert = false;
        crashed = true;
      }
      if (removedReturnedTrue) writesAfterRemovedTrue++;
      checkOrphan();
      return { rows: [{ id }] };
    }
    if (/INSERT INTO rag_triples/.test(sql)) {
      const [scope, agent_id, subject, predicate, object, , source_chunk_id] = p as string[];
      const id = `t${++seq}`;
      triples.push({ id, scope, agent_id, subject, predicate, object, source_chunk_id });
      if (removedReturnedTrue) writesAfterRemovedTrue++;
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
const workerLib = await import(`${SRC}/trinnex/library.server.ts?proc=w2`);
const removerA = await import(`${SRC}/trinnex/library.server.ts?proc=rA`);
const removerB = await import(`${SRC}/trinnex/library.server.ts?proc=rB`);
const heartbeat = await import(`${SRC}/trinnex/library.server.ts?proc=hb`);


function reset(status = "uploaded") {
  chunks.length = 0;
  triples.length = 0;
  orphanMoments = 0;
  writesAfterRemovedTrue = 0;
  removedReturnedTrue = false;
  crashed = false;
  crashAfterThisInsert = false;
  insertHook = null;
  row.exists = true;
  row.status = status;
  mem.__setTrinnexDepsForTest({
    getPool: () => fakePool,
    configured: () => true,
    embed: async () => new Array(3072).fill(0.01),
    extractTriples: async (text: string) => ({ triples: [{ subject: "Vendor", predicate: "said", object: text.slice(0, 20), confidence: 0.9 }], failureKind: null }),
    reportFailure: async () => {},
  });
}

function makeDeps(lease: { held: boolean }) {
  return {
    getBytes: async () => new Uint8Array([1]),
    deleteBytes: async () => {
      if (crashed) throw new Error("process died");
      return true;
    },
    extract: async () => ({ segments: [1, 2, 3].map((p) => ({ text: `Page ${p} words. `.repeat(150), page: String(p) })), cues: [] }),
    memory: {
      configured: () => true,
      ingest: (input: Parameters<typeof mem.ingestTrinnexSource>[0]) => mem.ingestTrinnexSource({ ...input, series: null }),
      remove: (sid: string, owner: string) => mem.deleteTrinnexSource(sid, owner),
    },
    update: async (_id: string, p: { status?: string }) => {
      if (crashed) throw new Error("process died");
      if (!row.exists) return;
      const removalWrite = p.status === "removing" || p.status === "remove_incomplete";
      if (!removalWrite && (row.status === "removing" || row.status === "remove_incomplete")) return;
      if (p.status) row.status = p.status;
    },
    deleteRow: async () => {
      checkOrphan();
      row.exists = false;
      checkOrphan();
    },
    isRemoved: async () => {
      if (crashed) throw new Error("process died");
      return !row.exists || row.status === "removing" || row.status === "remove_incomplete";
    },
    beginRemoval: async () => {
      // live SQL (loop-2 fix round): in_flight = lease unexpired, from the LEASE ALONE (no status list).
      // Was: lease unexpired AND old.status IN processing statuses -- the defect VB1/VB1c exposed.
      const alreadyRemoving = row.status === "removing";
      const inFlight = lease.held;
      if (row.exists) row.status = "removing";
      return { inFlight, alreadyRemoving };
    },
  };
}

const baseItem = (id: string, extra: Record<string, unknown> = {}) => ({
  id, ownerEmail: "owner@x.com", name: "Test-race.pdf", kind: "document", blobPath: "p", docDate: null,
  category: "General", participants: [], speakerMap: {}, chunks: 0, facts: 0, status: "uploaded", ...extra,
});

/** Pause the worker INSIDE its 2nd passage INSERT (after its stopped() check passed). */
function pauseInSecondInsert() {
  let n = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let reached = false;
  const orig = fakePool.query;
  // count inserts by wrapping the hook on each call
  const arm = () => {
    insertHook = async () => {
      n++;
      if (n === 2) {
        reached = true;
        await gate;
      } else arm();
    };
  };
  arm();
  void orig;
  return { release: () => release(), reached: () => reached };
}

test("VB1 Remove TWICE (two processes) while the worker holds the lease and is inside a passage write", async () => {
  reset();
  const id = crypto.randomUUID();
  const lease = { held: true };
  const deps = makeDeps(lease);
  const p = pauseInSecondInsert();
  const pipeline = workerLib.runPipeline(baseItem(id) as never, deps as never);
  while (!p.reached()) await new Promise((r) => setTimeout(r, 1));
  const r1 = await removerA.runRemoval(baseItem(id, { status: row.status }) as never, deps as never);
  // The UI shows "Removing..." but the server function can be called again directly.
  const r2 = await removerB.runRemoval(baseItem(id, { status: row.status }) as never, deps as never);
  if (r2.removed) removedReturnedTrue = true;
  const rowAfterR2 = row.exists;
  p.release();
  await pipeline;
  const out = { r1, r2, rowAfterR2, left: chunks.length, factsLeft: triples.length, rowExists: row.exists, orphanMoments, writesAfterRemovedTrue };
  console.log("VB1", JSON.stringify(out));
  expect(r1.pending).toBe(true);
  expect(chunks.length + triples.length).toBe(0); // eventual state
  expect(orphanMoments).toBe(0); // no window with derived rows and no Library row
  expect(writesAfterRemovedTrue).toBe(0);
});

test("VB1c Remove TWICE, then the worker process dies right after its in-flight write lands", async () => {
  reset();
  const id = crypto.randomUUID();
  const lease = { held: true };
  const deps = makeDeps(lease);
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let reached = false;
  let n = 0;
  const arm = () => {
    insertHook = async () => {
      n++;
      if (n === 2) {
        reached = true;
        await gate;
        // after this INSERT commits, the process dies
        crashAfterThisInsert = true;
      } else arm();
    };
  };
  arm();
  const pipeline = workerLib.runPipeline(baseItem(id) as never, deps as never).catch((e: Error) => `died:${e.message}`);
  while (!reached) await new Promise((r) => setTimeout(r, 1));
  await removerA.runRemoval(baseItem(id, { status: row.status }) as never, deps as never);
  const r2 = await removerB.runRemoval(baseItem(id, { status: row.status }) as never, deps as never);
  release();
  const end = await pipeline;
  crashed = false; // the DB is still up; only the worker died
  const out = { r2, end, left: chunks.length, factsLeft: triples.length, rowExists: row.exists, orphanMoments };
  console.log("VB1c", JSON.stringify(out));
  // Recovery is impossible if the row is gone: the heartbeat only finds rows.
  expect(chunks.length + triples.length === 0 || row.exists).toBe(true);
});

test("VB2 Remove during the RE-INGEST after a speaker remap (prior run's rows exist), cross-process, lease held", async () => {
  reset();
  const id = crypto.randomUUID();
  // run 1: full ingest to searchable, no removal
  const lease = { held: true };
  const deps = makeDeps(lease);
  await workerLib.runPipeline(baseItem(id) as never, deps as never);
  const afterRun1 = { chunks: chunks.length, facts: triples.length, status: row.status };
  // speaker remap -> status uploaded, worker claims and re-ingests; Remove arrives inside a passage write
  row.status = "uploaded";
  const p = pauseInSecondInsert();
  const pipeline = workerLib.runPipeline(baseItem(id, { chunks: afterRun1.chunks, facts: afterRun1.facts }) as never, deps as never);
  while (!p.reached()) await new Promise((r) => setTimeout(r, 1));
  const r = await removerA.runRemoval(baseItem(id, { status: row.status, chunks: afterRun1.chunks, facts: afterRun1.facts }) as never, deps as never);
  p.release();
  await pipeline;
  const out = { afterRun1, r, left: chunks.length, factsLeft: triples.length, rowExists: row.exists, orphanMoments };
  console.log("VB2", JSON.stringify(out));
  expect(afterRun1.chunks).toBeGreaterThan(0);
  expect(chunks.length + triples.length).toBe(0);
  expect(row.exists).toBe(false);
  expect(orphanMoments).toBe(0);
});

test("VB2b Remove during re-ingest after remap with the lease CLEARED (setSpeakerMap sets lease_until=NULL mid-run, or a run outlives its 3-minute lease)", async () => {
  reset();
  const id = crypto.randomUUID();
  const lease = { held: false };
  const deps = makeDeps(lease);
  await workerLib.runPipeline(baseItem(id) as never, deps as never);
  const n1 = chunks.length;
  row.status = "uploaded";
  const p = pauseInSecondInsert();
  const pipeline = workerLib.runPipeline(baseItem(id, { chunks: n1 }) as never, deps as never);
  while (!p.reached()) await new Promise((r) => setTimeout(r, 1));
  const r = await workerLib.runRemoval(baseItem(id, { status: row.status, chunks: n1 }) as never, deps as never);
  p.release();
  await pipeline;
  const out = { r, left: chunks.length, factsLeft: triples.length, rowExists: row.exists, orphanMoments };
  console.log("VB2b", JSON.stringify(out));
  expect(chunks.length + triples.length).toBe(0);
  expect(row.exists).toBe(false);
});

test("VB3 worker dies mid-run AFTER a deferred Remove; the next heartbeat finishes the removal", async () => {
  reset();
  const id = crypto.randomUUID();
  const lease = { held: true };
  const deps = makeDeps(lease);
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let reached = false;
  let n = 0;
  const arm = () => {
    insertHook = async () => {
      n++;
      if (n === 2) {
        reached = true;
        await gate;
        crashed = true; // dies before its INSERT commits
        throw new Error("process died");
      } else arm();
    };
  };
  arm();
  const pipeline = workerLib.runPipeline(baseItem(id) as never, deps as never).catch((e: Error) => `died:${e.message}`);
  while (!reached) await new Promise((r) => setTimeout(r, 1));
  const r = await removerA.runRemoval(baseItem(id, { status: row.status }) as never, deps as never);
  release();
  const end = await pipeline;
  crashed = false;
  const stranded = { rowExists: row.exists, status: row.status, chunks: chunks.length };
  // Heartbeat: lease expired, the row is `removing` and stale -> claim() returns it -> completeRemoval.
  // completeRemoval is not exported; runRemoval with an expired lease takes the same path.
  lease.held = false;
  const hb = await heartbeat.runRemoval(baseItem(id, { status: row.status }) as never, deps as never);
  const out = { r, end, stranded, hb, left: chunks.length, factsLeft: triples.length, rowExists: row.exists, orphanMoments };
  console.log("VB3", JSON.stringify(out));
  expect(r.pending).toBe(true);
  expect(stranded.rowExists).toBe(true); // the row survives the crash, so the heartbeat can find it
  expect(stranded.status).toBe("removing");
  expect(hb.removed).toBe(true);
  expect(chunks.length + triples.length).toBe(0);
  expect(orphanMoments).toBe(0);
});
