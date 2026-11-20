// WHAT:          search_trinnex is offered ONLY in the owner's 1:1 with iris-chase or eli-vaughn (huddle dm-iris-chase /
//                dm-eli-vaughn, scope one-to-one), never in a group or ceremony huddle, on BOTH dispatch paths and in
//                the executor wrapper.
// WHY:           Verifier loop 1, claim 1 LOW (VERIFY-trinnex-workspace-1.md): in a group huddle Iris's Trinnex-derived
//                reply is in the shared transcript every later responder reads. Session default; the owner may overrule.
// SUPERSEDES:    nothing. SUPERSEDED-BY: nothing -- current.
// EVIDENCE:      docs/qc-evidence/BUILD-trinnex-integration.md "Verifier loop-1 fix round". Run: bun test scripts/trinnex-scope-gate.test.ts
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";

const SRC = `${import.meta.dir}/../src/features/huddle/lib`;
const search = await import(`${SRC}/trinnex/search.ts`);
const { AGENTS } = await import(`${SRC}/../data/agents.ts`);

const IRIS = AGENTS.find((a: { id: string }) => a.id === "iris-chase");
const ELI = AGENTS.find((a: { id: string }) => a.id === "eli-vaughn");

test("SCOPE1 offered in the owner's own 1:1 with Iris or Eli", () => {
  expect(search.trinnexOfferedHere(IRIS, { huddleId: "dm-iris-chase", scope: "one-to-one", members: ["iris-chase"] })).toBe(true);
  expect(search.trinnexOfferedHere(ELI, { huddleId: "dm-eli-vaughn", scope: "one-to-one", members: ["eli-vaughn"] })).toBe(true);
});

test("SCOPE2 never in a group, ceremony, another agent's DM, or with scope missing", () => {
  const no: Array<[unknown, Record<string, unknown> | null]> = [
    [IRIS, { huddleId: "all-members", scope: "group" }],
    [IRIS, { huddleId: "daily", scope: "group" }],
    [IRIS, { huddleId: "ceremony-standup", scope: "group" }],
    [IRIS, { huddleId: "dm-iris-chase", scope: "group" }], // a dm id but group scope
    [IRIS, { huddleId: "dm-iris-chase", scope: "one-to-one", ceremony: true }], // ceremony barge
    [IRIS, { huddleId: "dm-eli-vaughn", scope: "one-to-one" }], // Iris answering in Eli's DM
    [ELI, { huddleId: "dm-iris-chase", scope: "one-to-one" }],
    [IRIS, { huddleId: "dm-iris-chase-x", scope: "one-to-one" }],
    [IRIS, { huddleId: "DM-IRIS-CHASE", scope: "one-to-one" }],
    [IRIS, { huddleId: "dm-iris-chase" }],
    [IRIS, { huddleId: null, scope: "one-to-one" }],
    [IRIS, null],
  ];
  for (const [agent, where] of no) expect(search.trinnexOfferedHere(agent, where)).toBe(false);
});

test("SCOPE3 every other agent is refused even in its own 1:1 (the data gate still applies)", () => {
  for (const a of AGENTS as Array<{ id: string; trinnexAccess?: boolean }>) {
    const ok = search.trinnexOfferedHere(a, { huddleId: `dm-${a.id}`, scope: "one-to-one", members: [a.id] });
    expect(ok).toBe(a.id === "iris-chase" || a.id === "eli-vaughn");
  }
});

test("SCOPE4 both dispatch paths and the executor wrapper read the scope gate", () => {
  const src = readFileSync(`${SRC}/huddle.functions.ts`, "utf8");
  // the gate is built from the turn's own huddle id, scope and ceremony flags
  expect(src).toMatch(/const trinnexHere = \([^)]*\): boolean =>\s*trinnexOfferedHere\(agent, \{ huddleId: data\.huddleId, scope: data\.scope, members: data\.members, ceremony: [^}]*\}\);/);
  // OpenAI tool list
  expect(src).toContain('...(trinnexHere(winner) ? (await import("./trinnex/search")).trinnexToolsFor(winner) : []),');
  // Lovable tool map
  expect(src).toContain("trinnexLovableToolsFor(trinnexHere(winner) ? winner : null,");
  // executor wrapper refuses before dispatching
  const w = src.indexOf("const runTrinnexSearch = async");
  const body = src.slice(w, src.indexOf("return out;", w));
  expect(body.indexOf("if (!trinnexHere(winner)) {")).toBeGreaterThan(0);
  expect(body.indexOf("if (!trinnexHere(winner)) {")).toBeLessThan(body.indexOf("dispatchTrinnexTool("));
  // no ungated offer remains
  expect(src).not.toContain("...(await import(\"./trinnex/search\")).trinnexToolsFor(winner),");
  expect(src).not.toContain("trinnexLovableToolsFor(winner,");
});

test("SCOPE5 loop-2 G: a dm-<agent> 1:1 payload naming ANY other member (or none) is refused server-side", () => {
  const base = { huddleId: "dm-iris-chase", scope: "one-to-one" };
  for (const members of [undefined, null, [], ["iris-chase", "finn-reid"], ["finn-reid"], ["iris-chase", "iris-chase"], ["eli-vaughn", "iris-chase"]]) {
    expect(search.trinnexOfferedHere(IRIS, { ...base, members } as never)).toBe(false);
  }
  expect(search.trinnexOfferedHere(IRIS, { ...base, members: ["iris-chase"] })).toBe(true);
});
