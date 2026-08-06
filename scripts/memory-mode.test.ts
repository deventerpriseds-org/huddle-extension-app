// Offline test for the memoryMode config (Settings → Memory). Covers the schema field, default, and
// enum guard. Run: bun scripts/memory-mode.test.ts
import { BackendsConfigSchema, defaultBackendsConfig, MEMORY_MODES } from "../src/features/huddle/lib/agent-backends";

let pass = 0,
  fail = 0;
function check(name: string, cond: boolean, detail = "") {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : `  ${detail}`}`);
  cond ? pass++ : fail++;
}

console.log("memoryMode config\n");

// The three modes exist, reconstruction is first (the default).
check("MEMORY_MODES = reconstruction/responses-chain/conversation", JSON.stringify([...MEMORY_MODES]) === JSON.stringify(["reconstruction", "responses-chain", "conversation"]));

// defaultBackendsConfig: memoryMode default + version bumped to 4.
const d = defaultBackendsConfig();
check("default memoryMode = reconstruction", d.memoryMode === "reconstruction", d.memoryMode);
check("default version = 4", d.version === 4, String(d.version));

// Schema applies the default when memoryMode is absent (a pre-v4 stored config).
const parsedNoField = BackendsConfigSchema.parse({
  version: 3,
  router: d.router,
  agents: d.agents,
  ceremonyEngine: "current",
});
check("schema defaults absent memoryMode → reconstruction", parsedNoField.memoryMode === "reconstruction", parsedNoField.memoryMode);

// Schema PRESERVES an explicit prior choice (a user who picked responses-chain).
const parsedChosen = BackendsConfigSchema.parse({ ...d, memoryMode: "responses-chain" });
check("schema preserves explicit memoryMode", parsedChosen.memoryMode === "responses-chain", parsedChosen.memoryMode);

// Schema REJECTS an unknown value (can't silently accept a 4th mode).
const bad = BackendsConfigSchema.safeParse({ ...d, memoryMode: "telepathy" });
check("schema rejects unknown memoryMode", bad.success === false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
