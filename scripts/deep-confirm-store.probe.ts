// WHAT:       Exercises the REAL chat.deep_confirm store — the exported functions, not a paraphrase
//             of their SQL — against a throwaway local Postgres, including the migration applied on
//             top of a POPULATED old-schema database.
// WHY:        The verdict memory is half TypeScript and half SQL. `scripts/verdict-memory.test.ts`
//             proves the window logic offline; only this proves that the row is RETIRED rather than
//             DELETED, that `resolved_at IS NULL` stops a memory masquerading as an outstanding ask,
//             that cancel still wipes both, and that the no-pending INSERT fallback works. A fresh
//             database would have proved none of it: `CREATE TABLE IF NOT EXISTS` is skipped on the
//             database that actually matters, so the new columns can only arrive via the idempotent
//             ALTERs — which is exactly what this checks.
// SUPERSEDES: nothing
// SUPERSEDED-BY: nothing -- current
// EVIDENCE:   .claude/BUILD-assignee-and-greenlight.md (FIX 2, "Executed against a real Postgres").
//
// NOT part of `npm test` — it needs a database, so it SKIPS cleanly when one is not configured.
// Set DEEP_CONFIRM_TEST_PG_URL to run it. To stand one up in this container (the store's pool hard-
// codes `ssl`, so the local cluster must have SSL ON or every call silently returns null):
//
//   rm -rf /tmp/eds-pgd /tmp/eds-pgsock && mkdir -p /tmp/eds-pgd /tmp/eds-pgsock
//   chown -R postgres /tmp/eds-pgd /tmp/eds-pgsock
//   su postgres -c "/usr/lib/postgresql/16/bin/initdb -D /tmp/eds-pgd -U postgres -A trust"
//   openssl req -new -x509 -days 2 -nodes -text -subj "/CN=localhost" \
//     -out /tmp/eds-pgd/server.crt -keyout /tmp/eds-pgd/server.key
//   chmod 600 /tmp/eds-pgd/server.key && chown postgres /tmp/eds-pgd/server.key /tmp/eds-pgd/server.crt
//   su postgres -c "/usr/lib/postgresql/16/bin/pg_ctl -D /tmp/eds-pgd \
//     -o '-p 55432 -k /tmp/eds-pgsock -c listen_addresses=127.0.0.1 -c ssl=on' -l /tmp/eds-pg.log start"
//   psql postgresql://postgres@127.0.0.1:55432/postgres -c 'create database dc'
//   DEEP_CONFIRM_TEST_PG_URL=postgresql://postgres@127.0.0.1:55432/dc bun scripts/deep-confirm-store.probe.ts
//
// The store bootstraps its own schema on first use, so no migration step is needed to run it green;
// to reproduce the MIGRATION case, apply `git show HEAD~1:...deep-confirm.server.ts`'s BOOTSTRAP and
// seed a row FIRST, then run this.

const URL_ = process.env.DEEP_CONFIRM_TEST_PG_URL;
if (!URL_) {
  console.log("SKIP — DEEP_CONFIRM_TEST_PG_URL is not set (see the header for a local cluster).");
  process.exit(0);
}
process.env.AZURE_PG_URL = URL_;

const {
  getPendingDeepConfirm,
  setPendingDeepConfirm,
  clearPendingDeepConfirm,
  recordDeepConfirmVerdict,
  getRecentDeepVerdict,
} = await import("../src/features/huddle/lib/tasks/deep-confirm.server");
const { VERDICT_MEMORY_MS } = await import("../src/features/huddle/lib/tasks/verdict-memory");

// A unique email per run, so repeated runs never collide on the (user_email, huddle_id) key.
const E = `probe-${Date.now().toString(36)}@example.invalid`;
const H = "dm-iris-chase";
const H2 = "dm-finn-reid";
let fails = 0;
const check = (n: string, a: unknown, e: unknown) => {
  const ok = JSON.stringify(a) === JSON.stringify(e);
  if (!ok) fails++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${n}${ok ? "" : `  (got ${JSON.stringify(a)}, want ${JSON.stringify(e)})`}`);
};

console.log("A pending ask reads back as pending");
await setPendingDeepConfirm(E, H, "iris-chase", "pricing model for the new tier");
check("the ask is outstanding", (await getPendingDeepConfirm(E, H))?.askText, "pricing model for the new tier");
check("no verdict remembered yet", await getRecentDeepVerdict(E, H), null);

console.log("\nAnswering 'produce' RECORDS instead of deleting (the whole fix)");
await recordDeepConfirmVerdict(E, H, "iris-chase", "pricing model for the new tier", "produce");
check("the pending ask is retired — no longer an outstanding question", await getPendingDeepConfirm(E, H), null);
check("...but the ANSWER is remembered", await getRecentDeepVerdict(E, H), "produce");

console.log("\nThe memory EXPIRES on the same window the offline test pins");
check("stale one ms past the window", await getRecentDeepVerdict(E, H, Date.now() + VERDICT_MEMORY_MS + 1), null);

console.log("\nA NEW ask makes the row pending again");
await setPendingDeepConfirm(E, H, "iris-chase", "second deep question");
check("pending again", (await getPendingDeepConfirm(E, H))?.askText, "second deep question");

console.log("\n'quick' is remembered too");
await recordDeepConfirmVerdict(E, H, "iris-chase", "second deep question", "quick");
check("retired", await getPendingDeepConfirm(E, H), null);
check("remembers quick", await getRecentDeepVerdict(E, H), "quick");

console.log("\nCANCEL WIPES BOTH — a park must not silence a later genuine ask");
await clearPendingDeepConfirm(E, H);
check("no pending", await getPendingDeepConfirm(E, H), null);
check("no remembered verdict either", await getRecentDeepVerdict(E, H), null);

console.log("\nThe no-row INSERT fallback (the green-lit produce path, which never had a pending)");
check("nothing there to begin with", await getRecentDeepVerdict(E, H2), null);
await recordDeepConfirmVerdict(E, H2, "finn-reid", "green-lit ask", "produce");
check("a verdict was still recorded", await getRecentDeepVerdict(E, H2), "produce");
check("and it did NOT create a phantom pending ask", await getPendingDeepConfirm(E, H2), null);

console.log("\nPer-huddle isolation — one huddle's verdict never answers for another");
check("an untouched huddle has no memory", await getRecentDeepVerdict(E, "dm-sam-trent"), null);

await clearPendingDeepConfirm(E, H2);
console.log(`\n${fails === 0 ? "ALL PASS" : `${fails} FAILURE(S)`}`);
process.exit(fails === 0 ? 0 : 1);
