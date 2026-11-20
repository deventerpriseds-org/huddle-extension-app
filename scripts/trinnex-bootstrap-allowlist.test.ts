// WHAT:          Tests for scripts/trinnex-extensions-allowlist.sh and its use in bootstrap-trinnex-db.yml: the shared
//                server's azure.extensions list is only ever APPENDED to, and an empty/unreadable list aborts.
// WHY:           Verifier loop 1, claim 6 LOW: `|| echo ""` turned a failed read into `parameter set VECTOR`, which
//                would replace the allow-list for every database on eds-postgresql.
// SUPERSEDES:    nothing. SUPERSEDED-BY: nothing -- current.
// EVIDENCE:      docs/qc-evidence/BUILD-trinnex-integration.md "Verifier loop-1 fix round". Run: bun test scripts/trinnex-bootstrap-allowlist.test.ts
import { test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const SCRIPT = `${import.meta.dir}/trinnex-extensions-allowlist.sh`;
const run = (current: string | null) => {
  const r = spawnSync("bash", current === null ? [SCRIPT] : [SCRIPT, current], { encoding: "utf8" });
  return { code: r.status, out: r.stdout.trim() };
};

test("ALLOW1 an empty or missing current list ABORTS (exit 2, nothing to write)", () => {
  for (const c of [null, "", "   ", "\n"]) {
    const r = run(c);
    expect(r.code).toBe(2);
    expect(r.out).toBe("");
  }
});

test("ALLOW2 vector already present in any case -> UNCHANGED", () => {
  for (const c of ["VECTOR", "vector", "PG_TRGM,VECTOR", "uuid-ossp, Vector ,PG_TRGM"]) expect(run(c)).toEqual({ code: 0, out: "UNCHANGED" });
});

test("ALLOW3 vector absent -> the existing list is kept in full and VECTOR appended", () => {
  expect(run("PG_TRGM,UUID-OSSP")).toEqual({ code: 0, out: "PG_TRGM,UUID-OSSP,VECTOR" });
  expect(run("PG_TRGM")).toEqual({ code: 0, out: "PG_TRGM,VECTOR" });
  expect(run("PG_TRGM,")).toEqual({ code: 0, out: "PG_TRGM,VECTOR" });
  // "vectors" or "pgvector_x" is not vector
  expect(run("VECTORS")).toEqual({ code: 0, out: "VECTORS,VECTOR" });
});

test("ALLOW4 the workflow aborts on a failed read and only writes the script's output", () => {
  const y = readFileSync(`${import.meta.dir}/../.github/workflows/bootstrap-trinnex-db.yml`, "utf8");
  expect(y).not.toMatch(/azure\.extensions[^\n]*\|\|\s*echo\s*""/); // the old fallback that turned a failed read into ""
  expect(y).toMatch(/if ! CURRENT=\$\(az postgres flexible-server parameter show[^\n]*azure\.extensions[^\n]*\); then\s*\n[^\n]*\n\s*exit 1/);
  expect(y).toMatch(/if ! NEW=\$\(bash scripts\/trinnex-extensions-allowlist\.sh "\$CURRENT"\); then\s*\n[^\n]*\n\s*exit 1/);
  // exactly one write, and it writes $NEW only
  const sets = y.match(/parameter set[^\n]*azure\.extensions[^\n]*/g) ?? [];
  expect(sets.length).toBe(1);
  expect(sets[0]).toContain('--value "$NEW"');
});
