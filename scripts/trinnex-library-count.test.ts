// WHAT:  offline test for the Library's Fireflies "waiting for triage" count (firefliesWaiting).
// WHY:   UAT 2026-11-20 (verify-uat run 44705323308, 1000x680): the Library said "0 waiting for triage" while the
//        Meetings module listed 29. The count matched only the signed-in address; the Fireflies rows live under a
//        different linked address. Meetings filters on the caller's whole owner set, so the Library must too.
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.  EVIDENCE: docs/qc-evidence/BUILD-trinnex-uat-fixes.md
// Run: bun test scripts/trinnex-library-count.test.ts
import { describe, expect, test } from "bun:test";
import { firefliesWaiting } from "../src/features/huddle/lib/trinnex/library.server";

type Row = { owner_email: string; triaged_at: string | null };

/** A fake pool that evaluates the two queries firefliesWaiting sends against an in-memory table. */
function fakePool(rows: Row[], opts: { tableExists?: boolean; hasTriaged?: boolean } = {}) {
  const { tableExists = true, hasTriaged = true } = opts;
  const sent: { sql: string; params: unknown[] }[] = [];
  return {
    sent,
    async query(sql: string, params: unknown[] = []) {
      sent.push({ sql, params });
      if (sql.includes("information_schema.columns")) {
        if (!tableExists) return { rowCount: 0, rows: [] };
        const cols = ["meeting_id", "owner_email", ...(hasTriaged ? ["triaged_at"] : [])];
        return { rowCount: cols.length, rows: cols.map((column_name) => ({ column_name })) };
      }
      const set = params[0] as string[];
      const n = rows.filter(
        (r) => set.includes(r.owner_email.toLowerCase()) && (!sql.includes("triaged_at IS NULL") || r.triaged_at === null),
      ).length;
      return { rowCount: 1, rows: [{ n }] };
    },
  };
}

const ROWS: Row[] = [
  { owner_email: "Work.Address@Example.com", triaged_at: null },
  { owner_email: "work.address@example.com", triaged_at: null },
  { owner_email: "work.address@example.com", triaged_at: "2026-11-20T00:00:00Z" },
  { owner_email: "someone.else@example.com", triaged_at: null },
];

describe("firefliesWaiting counts across the caller's whole owner set", () => {
  test("C1 rows stored under a second linked address are counted (the UAT 0-vs-29 defect)", async () => {
    const pool = fakePool(ROWS);
    expect(await firefliesWaiting(["signed.in@example.com", "work.address@example.com"], pool as never)).toBe(2);
  });

  test("C2 the match is case-insensitive on both sides", async () => {
    expect(await firefliesWaiting(["WORK.ADDRESS@EXAMPLE.COM"], fakePool(ROWS) as never)).toBe(2);
  });

  test("C3 another owner's meetings are never counted", async () => {
    expect(await firefliesWaiting(["signed.in@example.com"], fakePool(ROWS) as never)).toBe(0);
  });

  test("C4 without a triaged_at column every recorded meeting counts", async () => {
    expect(await firefliesWaiting(["work.address@example.com"], fakePool(ROWS, { hasTriaged: false }) as never)).toBe(3);
  });

  test("C5 table absent -> null (Fireflies never set up)", async () => {
    expect(await firefliesWaiting(["work.address@example.com"], fakePool(ROWS, { tableExists: false }) as never)).toBeNull();
  });

  test("C6 an empty owner set sends no count query and returns 0", async () => {
    const pool = fakePool(ROWS);
    expect(await firefliesWaiting(["", "  "], pool as never)).toBe(0);
    expect(pool.sent.length).toBe(0);
  });

  test("C7 the count query filters with ANY over the owner array, lower-cased and de-duplicated", async () => {
    const pool = fakePool(ROWS);
    await firefliesWaiting(["A@x.com", "a@X.com", "b@x.com"], pool as never);
    const q = pool.sent.find((s) => s.sql.includes("count(*)"));
    expect(q?.sql).toContain("= ANY($1::text[])");
    expect(q?.params[0]).toEqual(["a@x.com", "b@x.com"]);
  });
});
