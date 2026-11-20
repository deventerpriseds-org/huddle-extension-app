// WHAT:          VOICE-NONE: the voice path cannot reach Trinnex. No voice file (any src file whose path names "voice")
//                imports lib/trinnex/ or names search_trinnex, and the voice-memory writer is byte-identical to main.
// WHY:           Verifier loop 3 (VERIFY-trinnex-workspace-3.md, claim V) confirmed voice is never seeded from the 1:1
//                conversation and cannot call search_trinnex, so the voice guard protected nothing while changing
//                behaviour (Iris/Eli voice replies stopped reaching memory after any Trinnex use). The guard was removed
//                2026-11-20; this test pins the premise that made it unnecessary.
// SUPERSEDES:    scripts/trinnex-voice-guard.test.ts and scripts/trinnex-voice-history.test.ts (deleted with the guard).
// SUPERSEDED-BY: nothing -- current.
// EVIDENCE:      docs/qc-evidence/BUILD-trinnex-integration.md "Final fixes before merge (2026-11-20)".
//                Run: bun test scripts/trinnex-voice-none.test.ts
import { test, expect } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, relative } from "node:path";

const ROOT = `${import.meta.dir}/..`;
const SRC = join(ROOT, "src");
const VOICE_MEMORY = "src/features/huddle/lib/voice/voice-memory.functions.ts";

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|js|mjs)$/.test(name)) out.push(p);
  }
  return out;
}

const VOICE_FILES = walk(SRC).filter((p) => /voice/i.test(relative(SRC, p)));

test("VOICE-NONE voice files exist (the file filter is not empty)", () => {
  expect(VOICE_FILES.length).toBeGreaterThanOrEqual(10);
  expect(VOICE_FILES.map((p) => relative(ROOT, p))).toContain(VOICE_MEMORY);
  expect(VOICE_FILES.map((p) => relative(ROOT, p))).toContain("src/features/huddle/lib/voice/realtime-tools.server.ts");
});

test("VOICE-NONE no voice file imports lib/trinnex/ or names search_trinnex", () => {
  const offenders: string[] = [];
  for (const p of VOICE_FILES) {
    const s = readFileSync(p, "utf8");
    if (/trinnex\//i.test(s) || /search_trinnex/i.test(s) || /SEARCH_TRINNEX/.test(s)) offenders.push(relative(ROOT, p));
  }
  expect(offenders).toEqual([]);
});

test("VOICE-NONE voice-memory writer is byte-identical to main", () => {
  let main: string | null = null;
  for (const ref of ["origin/main", "main"]) {
    try {
      main = execFileSync("git", ["show", `${ref}:${VOICE_MEMORY}`], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      break;
    } catch {
      /* try the next ref */
    }
  }
  expect(main).not.toBeNull(); // no main ref at all is a failure, never a skip
  expect(readFileSync(join(ROOT, VOICE_MEMORY), "utf8")).toBe(main as string);
});
