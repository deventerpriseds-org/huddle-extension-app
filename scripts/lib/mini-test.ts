// WHAT:       A 20-line sequential test runner for plain `bun scripts/<x>.test.ts` files: prints one PASS/FAIL line
//             per test and a `# tests N  # pass N  # fail N` summary, exits 1 on any failure.
// WHY:        `bun test` cannot resolve parse5 in a checkout with no node_modules (measured 2026-11-26), while
//             `bun <file>` auto-installs it; existing suites (onedrive-feed.test.ts) inline their own `t()` instead.
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   scripts/calendar-ignore-parity.test.ts, scripts/calendar-ignore-rules.test.ts.
const tests: Array<{ name: string; fn: () => unknown | Promise<unknown> }> = [];

export function test(name: string, fn: () => unknown | Promise<unknown>): void {
  tests.push({ name, fn });
}

export async function runTests(): Promise<void> {
  let pass = 0;
  let fail = 0;
  for (const t of tests) {
    try {
      await t.fn();
      pass++;
      console.log(`PASS ${t.name}`);
    } catch (err) {
      fail++;
      console.log(`FAIL ${t.name}\n  ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  console.log(`# tests ${tests.length}  # pass ${pass}  # fail ${fail}`);
  if (fail) process.exit(1);
}
