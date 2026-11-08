// WHAT:       Guard: the Huddle server opens exactly ONE Postgres pool (lib/db/shared-pool.server.ts), small enough
//             to fit the shared database server.
// WHY:        17 per-module pools (up to ~48 connections per instance) exhausted a 50-connection server shared with
//             other apps: "remaining connection slots are reserved for roles with the SUPERUSER attribute"
//             (owner, 2026-11-08). A new store that adds its own `new Pool(` would quietly bring it back.
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   run with `npm run test:shared-pool`; .claude/actions.md ACT:db-connection-exhaustion.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

let fail = 0;
const check = (n: string, ok: boolean, d = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${n}${!ok && d ? ` — ${d}` : ""}`);
  if (!ok) fail++;
};
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(f) ? [p] : [];
  });
const files = walk("src");
const SHARED = "src/features/huddle/lib/db/shared-pool.server.ts";
const withPool = files.filter((f) => /new\s+(?:pg\.)?Pool\s*\(/.test(readFileSync(f, "utf8")));
check(
  "P1 exactly one `new Pool(` in src, and it is the shared pool",
  withPool.length === 1 && withPool[0] === SHARED,
  withPool.join(", "),
);
const valueImports = files.filter(
  (f) =>
    f !== SHARED &&
    /import\s*\{[^}]*(?<!type\s)\bPool\b[^}]*\}\s*from\s*"pg"/.test(
      readFileSync(f, "utf8").replace(/import type \{[^}]*\}/g, ""),
    ),
);
check(
  "P2 no other file imports Pool as a value (type-only imports are fine)",
  valueImports.length === 0,
  valueImports.join(", "),
);
const shared = readFileSync(SHARED, "utf8");
const max = Number(/export const SHARED_POOL_MAX = (\d+);/.exec(shared)?.[1]);
check(
  "P3 the shared pool is small (<= 10 per instance)",
  Number.isFinite(max) && max > 0 && max <= 10,
  String(max),
);
check("P4 the shared pool uses SHARED_POOL_MAX", /max: SHARED_POOL_MAX,/.test(shared));
const users = files.filter(
  (f) => readFileSync(f, "utf8").includes("getSharedPool()") && f !== SHARED,
);
check(
  "P5 the 17 former pool owners all use getSharedPool()",
  users.length >= 17,
  String(users.length),
);
console.log(fail ? `${fail} failed` : "all passed");
process.exit(fail ? 1 : 0);
