// WHAT:          Loop-2 2b fixes: Remove/Replace/speaker remap decided from the worker LEASE, never a status list; the
//                worker renews its lease during long runs.
// WHY:           VERIFY-trinnex-workspace-2.md claim 2b: a SECOND Remove read `removing` as "not processing" and deleted
//                the row under a running worker (VB1, VB1c permanent orphan); setSpeakerMap cleared a held lease (VB2b);
//                Upload Replace re-removed a `removing` row; "Removing..." was client-only.
// SUPERSEDES:    nothing. SUPERSEDED-BY: nothing -- current.
// EVIDENCE:      docs/qc-evidence/BUILD-trinnex-integration.md "Verifier loop-2 fix round". Run: bun test scripts/trinnex-removal-lease.test.ts
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";

const SRC = `${import.meta.dir}/../src/features/huddle/lib/trinnex`;
process.env.AZURE_PG_URL = "postgresql://fake:fake@localhost:5432/fake";
const lib = await import(`${SRC}/library.server.ts`);
const libSrc = readFileSync(`${SRC}/library.server.ts`, "utf8");
const fnSrc = readFileSync(`${SRC}/library.functions.ts`, "utf8");
const block = (src: string, start: string) => {
  const i = src.indexOf(start);
  if (i < 0) throw new Error(`missing ${start}`);
  const j = src.indexOf("\n}\n", i);
  return src.slice(i, j);
};

test("LEASE1 beginRemoval decides in_flight from the lease ALONE (no status list), so a removing row can be worker-held", () => {
  const b = block(libSrc, "async function beginRemoval(");
  const inFlight = b.slice(b.indexOf("RETURNING"), b.indexOf("AS in_flight"));
  expect(inFlight).toContain("old.lease_until > now()");
  expect(inFlight).not.toMatch(/old\.status/);
  expect(b).toContain("(old.status = 'removing') AS already_removing");
});

test("LEASE2 setSpeakerMap never clears a lease a worker holds", () => {
  const b = block(libSrc, "export async function setSpeakerMap(");
  const where = b.slice(b.indexOf("WHERE id = $1"));
  expect(where).toContain("AND (lease_until IS NULL OR lease_until <= now())");
});

test("LEASE3 a long run renews its lease from the before-every-write check", async () => {
  let clock = 1_000_000;
  const realNow = Date.now;
  Date.now = () => clock;
  const renewed: string[] = [];
  try {
    const id = crypto.randomUUID();
    const deps = {
      getBytes: async () => new Uint8Array([1]),
      deleteBytes: async () => true,
      extract: async () => ({ segments: [{ text: "words ".repeat(50), page: "1" }], cues: [] }),
      memory: {
        configured: () => true,
        ingest: async (input: { shouldStop?: () => boolean | Promise<boolean> }) => {
          for (let i = 0; i < 5; i++) {
            clock += lib.LEASE_RENEW_MS; // each passage write takes a full renew interval
            await input.shouldStop?.();
          }
          return { chunks: 5, facts: 0 };
        },
        remove: async () => ({ chunks: 0, facts: 0 }),
      },
      update: async () => {},
      deleteRow: async () => {},
      isRemoved: async () => false,
      renewLease: async (x: string) => {
        renewed.push(x);
      },
    };
    const st = await lib.runPipeline(
      { id, ownerEmail: "o@x.com", name: "Test-a.txt", kind: "document", blobPath: "p", docDate: null, category: "General",
        participants: [], speakerMap: {}, chunks: 0, facts: 0, status: "uploaded" } as never,
      deps as never,
    );
    expect(st).toBe("searchable");
    expect(renewed.length).toBeGreaterThanOrEqual(5);
    expect(new Set(renewed)).toEqual(new Set([id]));
  } finally {
    Date.now = realNow;
  }
});

test("LEASE4 a second Remove while the worker holds the lease is refused: nothing deleted, row kept", async () => {
  const id = crypto.randomUUID();
  const calls: string[] = [];
  const deps = {
    getBytes: async () => null,
    deleteBytes: async () => (calls.push("blob"), true),
    extract: async () => ({ segments: [], cues: [] }),
    memory: { configured: () => true, ingest: async () => ({ chunks: 0, facts: 0 }), remove: async () => (calls.push("mem"), { chunks: 0, facts: 0 }) },
    update: async () => {},
    deleteRow: async () => void calls.push("row"),
    isRemoved: async () => true,
    beginRemoval: async () => ({ inFlight: true, alreadyRemoving: true }),
  };
  const r = await lib.runRemoval(
    { id, ownerEmail: "o@x.com", name: "Test-b.pdf", kind: "document", blobPath: "p", docDate: null, category: "General",
      participants: [], speakerMap: {}, chunks: 3, facts: 1, status: "removing" } as never,
    deps as never,
  );
  expect(r).toEqual({ removed: false, remaining: [], pending: true, alreadyRemoving: true });
  expect(calls).toEqual([]);
});

test("LEASE5 Upload Replace never re-removes a row that is already being removed", () => {
  const i = fnSrc.indexOf("if (dup && data.replace) {");
  const b = fnSrc.slice(i, fnSrc.indexOf("const ext = extOf", i));
  const guard = b.indexOf('if (dup.status === "removing") return { error: "already_being_removed" };');
  expect(guard).toBeGreaterThan(-1);
  expect(guard).toBeLessThan(b.indexOf("removeLibraryItem("));
});

// ── Loop-3 VC3a: the lease is renewed on a timer for the whole run, independent of fact output ─────────────
// The REAL runPipeline over the REAL ingestTrinnexSource (fake store pool). A fake clock advances on every AI call;
// the injected `every` scheduler fires renewals from that clock. A second worker's claim() succeeds at any instant
// where clock > leaseUntil (claim takes a 3-minute lease; renewLease sets it to now + 3 minutes).
const mem = await import(`${SRC}/memory.server.ts`);
const LEASE_MS = 180_000;

async function slowNoFactRun(passages: number, extractMs: number) {
  let clock = 0;
  let leaseUntil = LEASE_MS; // the first worker's claim() at t=0
  let secondClaims = 0;
  let renewals = 0;
  let maxGapMs = 0;
  let lastRenewal = 0;
  const timers: Array<{ next: number; ms: number; fn: () => void }> = [];
  const lapseCheck = (t: number) => {
    if (t > leaseUntil) secondClaims++; // a heartbeat claim() at this instant would take the item
  };
  const advance = (dt: number) => {
    const target = clock + dt;
    for (;;) {
      const due = timers.filter((x) => x.next <= target).sort((a, b) => a.next - b.next)[0];
      if (!due) break;
      clock = due.next;
      lapseCheck(clock);
      due.fn();
      due.next += due.ms;
    }
    clock = target;
    lapseCheck(clock);
  };
  let idSeq = 0;
  mem.__setTrinnexDepsForTest({
    getPool: () => ({
      query: async (sql: string) => (/INSERT INTO rag_(chunks|triples)/.test(sql) ? { rows: [{ id: `id-${++idSeq}` }] } : { rows: [] }),
    }),
    configured: () => true,
    embed: async () => {
      advance(1_000);
      return [0.1, 0.2, 0.3];
    },
    extractTriples: async () => {
      advance(extractMs);
      return { triples: [], failureKind: null };
    },
    reportFailure: async () => {},
  });
  const id = crypto.randomUUID();
  const deps = {
    getBytes: async () => new Uint8Array([1]),
    deleteBytes: async () => true,
    extract: async () => ({
      segments: Array.from({ length: passages }, (_, i) => ({ text: `Test-paragraph ${i} `.repeat(200), page: String(i + 1) })),
      cues: [],
    }),
    memory: { configured: () => true, ingest: mem.ingestTrinnexSource, remove: async () => ({ chunks: 0, facts: 0 }) },
    update: async () => {},
    deleteRow: async () => {},
    isRemoved: async () => false,
    renewLease: async () => {
      renewals++;
      maxGapMs = Math.max(maxGapMs, clock - lastRenewal);
      lastRenewal = clock;
      leaseUntil = clock + LEASE_MS;
    },
    every: (ms: number, fn: () => void) => {
      const t = { next: clock + ms, ms, fn };
      timers.push(t);
      return () => void timers.splice(timers.indexOf(t), 1);
    },
  };
  const status = await lib.runPipeline(
    { id, ownerEmail: "o@x.com", name: "Test-long.pdf", kind: "document", blobPath: "p", docDate: null, category: "General",
      participants: [], speakerMap: {}, chunks: 0, facts: 0, status: "uploaded" } as never,
    deps as never,
  );
  maxGapMs = Math.max(maxGapMs, clock - lastRenewal);
  return { status, secondClaims, renewals, maxGapMs, elapsedMs: clock, timersLeft: timers.length };
}

test("LEASE6 a run of 40 slow passages with 0 facts never lets a second claim succeed", async () => {
  const r = await slowNoFactRun(40, 15_000);
  console.log(`LEASE6 passages=40 extract=15s facts=0 elapsed=${r.elapsedMs / 1000}s renewals=${r.renewals} maxGapSec=${r.maxGapMs / 1000} secondClaims=${r.secondClaims}`);
  expect(r.status).toBe("searchable");
  expect(r.elapsedMs).toBeGreaterThan(3 * LEASE_MS); // the run really outlives the lease several times over
  expect(r.secondClaims).toBe(0);
  expect(r.maxGapMs).toBeLessThanOrEqual(lib.LEASE_RENEW_MS);
  expect(r.timersLeft).toBe(0); // the renewal timer is stopped when the run ends (finally)
});
