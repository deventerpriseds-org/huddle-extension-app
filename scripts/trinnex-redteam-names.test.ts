// WHAT:          RED-TEAM failing tests for the Trinnex name parser (lib/trinnex/names.ts) and speaker mapping
//                (lib/trinnex/meeting-triage-core.ts segmentsFor). Each test is a wrong answer found by the pre-pass.
// WHY:           Tier 1 red-team pre-pass, docs/qc-evidence/REDTEAM-trinnex-workspace.md. The builder turns these green.
// SUPERSEDES:    nothing. SUPERSEDED-BY: nothing -- current.
// EVIDENCE:      docs/qc-evidence/REDTEAM-trinnex-workspace.md rows N1-N6. Run: bun test scripts/trinnex-redteam-names.test.ts
import { test, expect } from "bun:test";

const SRC = `${import.meta.dir}/../src/features/huddle/lib/trinnex`;
const { suggestNames, matchSpeaker } = await import(`${SRC}/names.ts`);
const { segmentsFor } = await import(`${SRC}/meeting-triage-core.ts`);

const ctx = { people: ["Von", "Michael R.", "Priya S.", "Dana K."], owner: "Von" };
const twoMichaels = { people: ["Von", "Michael R.", "Michael T."], owner: "Von" };
const names = (s: string, c = ctx) => suggestNames(s, c).map((x: { name: string }) => x.name);

test("RT-N1 apostrophe names (O'Brien, D'Angelo) are offered after a trigger -- names.ts header promises O'Brien", () => {
  expect(names("Sync with O'Brien")).toEqual(["O'Brien"]);
  expect(names("Meeting with D'Angelo")).toEqual(["D'Angelo"]);
});

test("RT-N2 an exact full name 'Michael T.' resolves to Michael T. only, not both Michaels", () => {
  expect(names("Sync with Michael T.", twoMichaels)).toEqual(["Michael T."]);
  expect(names("Michael T. review", twoMichaels)).toEqual(["Michael T."]);
});

test("RT-N3 speaker 'Dana Smith' is NOT auto-mapped to 'Dana K.' (surname initial conflicts; S-B9 no loose match)", () => {
  const m = matchSpeaker("Dana Smith", ctx);
  expect(m.kind === "person" && m.person === "Dana K.").toBe(false);
});

test("RT-N4 a speaker label that is an Object.prototype key ('constructor', 'toString') stays a literal string label", () => {
  const out = segmentsFor(
    [
      { text: "hello there", speaker: "constructor", start: 1 },
      { text: "general kenobi", speaker: "toString", start: 2 },
    ] as never,
    {},
  );
  for (const o of out) expect(typeof o.speaker).toBe("string");
  expect(out.map((o: { speaker: unknown }) => o.speaker)).toEqual(["constructor", "toString"]);
});

test("RT-N5 common non-person words after 'with' are not offered as new names", () => {
  expect(names("Interview with Candidate")).toEqual([]);
  expect(names("Sync with Christmas")).toEqual([]);
});
