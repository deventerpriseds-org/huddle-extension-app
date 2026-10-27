// WHAT:       Guards the two defects the independent verifier REFUTED in loop 3 of the multi-format
//             artifact work: the worker-site `!content` guard (R1) and the unsanitised `folder`
//             traversal on the OneDrive mirror path (R2).
// WHY:        Both were live on main and deployed. R2 is outward-facing — it writes to a real
//             person's OneDrive — and reproduced the identical escape that `safeArtifactName` had
//             already closed for the `{name}` half, because `encodeURIComponent` does not encode ".".
//             R1 made CREATE_ARTIFACT_TOOL lie to worker agents: its `required` is ["name"] and its
//             `document` description says "Supply the structure instead of `content`", while the
//             worker handler returned "name and content are required".
// SUPERSEDES: nothing.
// SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   docs/VERIFY-artifact-formats-3.md, verdicts R1 and R2, each with a concrete failing
//             input reproduced below as a test case.
//
// Run: bun scripts/artifact-traversal-guard.test.ts   (npm run test:artifact-traversal)

import { readFileSync } from "node:fs";
import { safeArtifactFolder, safeArtifactName } from "../src/features/huddle/lib/artifacts/artifacts.server";

let pass = 0;
let fail = 0;

function check(label: string, ok: boolean, detail: string) {
  if (ok) {
    pass++;
    console.log(`  ok   ${label}`);
  } else {
    fail++;
    console.log(`FAIL ${label}\n       ${detail}`);
  }
}

// `encodePath` copied VERBATIM from onedrive.server.ts — the point of the test is that this exact
// encoder does not save us, so reproducing it rather than importing keeps the test honest if the
// module's import graph changes.
const encodePath = (p: string) => p.split("/").map(encodeURIComponent).join("/");

// The drivePath template, also verbatim from onedrive.server.ts, with the sanitisers applied as the
// fixed code applies them.
const drivePath = (lane: string, name: string) =>
  `Huddle Artifacts/${safeArtifactFolder(lane)}/${safeArtifactName(name)}`;

console.log("R2 — folder/lane traversal cannot escape Huddle Artifacts");

// The verifier's own four cases, verbatim from VERIFY-artifact-formats-3.md R2.
const R2_CASES: Array<[string, string]> = [
  ["Research", "../../etc/passwd"],
  ["../../../Documents", "report.docx"],
  ["..", "a.md"],
  ["Research/../../..", "a.md"],
];

for (const [lane, name] of R2_CASES) {
  const p = drivePath(lane, name);
  const encoded = encodePath(p);
  // The real invariant: no `..` segment survives, in the raw path OR after the encoder Graph sees.
  const segments = p.split("/");
  const ok = !segments.includes("..") && !encoded.includes("..") && p.startsWith("Huddle Artifacts/");
  check(`lane=${JSON.stringify(lane)} name=${JSON.stringify(name)} stays contained`, ok, `got ${p}`);
}

// A legitimate lane must survive untouched — a guard that mangles real input gets switched off.
for (const lane of ["Research", "Ventures", "Finance", "Personal"]) {
  check(`legitimate lane ${lane} is unchanged`, safeArtifactFolder(lane) === lane, `got ${safeArtifactFolder(lane)}`);
}

// Empty/degenerate lanes must land somewhere addressable rather than producing "Huddle Artifacts//x".
for (const [lane, want] of [["", "Personal"], [".", "Personal"], ["..", "Personal"], ["   ", "Personal"]] as const) {
  check(`degenerate lane ${JSON.stringify(lane)} -> ${want}`, safeArtifactFolder(lane) === want, `got ${safeArtifactFolder(lane)}`);
}

// Backslashes are a path separator on the Windows side of OneDrive; they must not smuggle a segment.
check(
  "backslash traversal is neutralised",
  !drivePath("..\\..\\Documents", "a.md").includes(".."),
  `got ${drivePath("..\\..\\Documents", "a.md")}`,
);

console.log("\nR1 — every create_artifact dispatch guard accepts a structured document with no content");

// STRUCTURAL, not behavioural, and deliberately so. The three guards live inside `runHuddleTurn` and
// the worker sub-turn — neither is exported and neither is reachable without standing up a whole turn
// (pg pool, OpenAI client, caller identity), so a runtime test cannot express "all three dispatch
// sites agree". An earlier draft of this file RESTATED the guard expression and asserted against the
// restatement, which proves nothing: mutating the real source left it green. This reads the source.
const SRC = readFileSync(
  new URL("../src/features/huddle/lib/huddle.functions.ts", import.meta.url),
  "utf8",
);

// Comments are stripped first so a guard quoted in prose cannot satisfy the count.
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

const relaxed = (CODE.match(/if \(!name \|\| \(!content && !a\.document\)\)/g) ?? []).length;
const legacy = (CODE.match(/if \(!name \|\| !content\)/g) ?? []).length;

// OpenAI, Lovable, worker. The voice site has its own schema with required:["name","content"] and no
// `document` property, so its stricter guard matches what its model can emit and is NOT counted here.
check(
  `all 3 dispatch guards accept a document-only call (found ${relaxed})`,
  relaxed === 3,
  `expected 3 relaxed guards in huddle.functions.ts, found ${relaxed}`,
);
check(
  `no dispatch site still requires content (found ${legacy})`,
  legacy === 0,
  `found ${legacy} guard(s) still spelled "if (!name || !content)" — the worker site was exactly this`,
);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
