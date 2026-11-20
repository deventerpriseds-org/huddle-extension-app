// WHAT:          oneToOneHasToolTurn (tasks/turns.server.ts): the 1:1-history lookup behind the narrowed voice guard.
// WHY:           The voice writer reuses the text path's marker (the search_trinnex toolUses breadcrumb that lands in a
//                turn's result and progress columns). This pins the query to that 1:1, that owner, and both columns.
//                Fake pool: proves the parameters and the columns read, NOT Postgres's jsonb @> semantics (no DB here).
// SUPERSEDES:    nothing. SUPERSEDED-BY: nothing -- current.
// EVIDENCE:      docs/qc-evidence/BUILD-trinnex-integration.md "Voice guard narrowed (2026-11-20)".
//                Run: bun test scripts/trinnex-voice-history.test.ts
import { test, expect, mock } from "bun:test";

const SRC = `${import.meta.dir}/../src/features/huddle`;
process.env.AZURE_PG_URL ||= "postgres://fake";
const seen: Array<{ sql: string; params: unknown[] }> = [];
mock.module(require.resolve(`${SRC}/lib/db/shared-pool.server.ts`), () => ({
  getSharedPool: () => ({
    query: async (sql: string, params: unknown[] = []) => {
      if (!/SELECT EXISTS/.test(sql)) return { rows: [] };
      seen.push({ sql, params });
      return { rows: [{ hit: params[0] === "dm-iris-chase" }] };
    },
  }),
}));
mock.module(require.resolve(`${SRC}/lib/identity/identity.server.ts`), () => ({
  resolveScopeByEmail: async (e: string) => (e === "known@example.com" ? { userId: "u-1", emails: [e] } : { userId: null, emails: [e] }),
}));
const { oneToOneHasToolTurn } = await import(`${SRC}/lib/tasks/turns.server.ts`);

test("VOICE6 the lookup is scoped to the 1:1 and the owner, and reads the search_trinnex breadcrumb from result AND progress", async () => {
  expect(await oneToOneHasToolTurn("known@example.com", "dm-iris-chase", "search_trinnex")).toBe(true);
  expect(await oneToOneHasToolTurn("unknown@example.com", "dm-eli-vaughn", "search_trinnex")).toBe(false);
  const [a, b] = seen;
  expect(a.params).toEqual(["dm-iris-chase", JSON.stringify([{ tool: "search_trinnex" }]), "u-1", ["known@example.com"]]);
  expect(b.params).toEqual(["dm-eli-vaughn", JSON.stringify([{ tool: "search_trinnex" }]), "unknown@example.com"]);
  for (const q of [a, b]) {
    expect(q.sql).toContain("huddle_id = $1");
    expect(q.sql).toContain("result->'toolUses' @> $2::jsonb");
    expect(q.sql).toContain("progress->'toolUses' @> $2::jsonb");
  }
  expect(a.sql).toContain("user_id = $3");
  expect(b.sql).toContain("lower(user_email) = lower($3)");
});
