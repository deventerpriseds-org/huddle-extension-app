// WHAT:       Proves journey's four real categories get VISUALLY SEPARATED hues matching the spec,
//             and that a topic and a category of the same name resolve to the SAME hue.
// WHY:        The bare hash put LIFE at 108 and EDUCATION at 128 -- 20 degrees apart, two
//             near-identical greens -- for the pair the spec screenshot makes the most distinct
//             (Life blue, Education amber). The same hash was case-sensitive while journey stores
//             categories upper-snake, so the file's claim that a topic and a category of the same
//             name "agree in colour for free" measured FALSE 5/5.
//             (docs/VERIFY-journey-widgets-2.md, N-5 MODERATE and N-6 LOW-MODERATE.)
// SUPERSEDES: nothing
// SUPERSEDED-BY: nothing -- current
// EVIDENCE:   docs/LANE-E-loop2-fixes.md; docs/widgets/spec-priorities-widget.jpg
//
// Run:  bun scripts/widget-colors.test.ts   (npm run test:widget-colors)
//
// Separation is COMPUTED here (shortest arc on the 360-degree wheel), never eyeballed from the
// numbers -- which is exactly the check the original hash would have failed.

import {
  CATEGORY_HUES,
  categoryChromaScale,
  categoryHue,
} from "../src/features/huddle/lib/tasks/widget-colors";

let pass = 0,
  fail = 0;
function check(label: string, cond: boolean, detail: string) {
  console.log(`  ${cond ? "PASS" : "FAIL"} ${label} — ${detail}`);
  cond ? pass++ : fail++;
}

/** Shortest arc between two hues on the wheel: 350 and 10 are 20 apart, not 340. */
function hueGap(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

// journey's real category set — _shared/tool-definitions.ts
const JOURNEY_CATEGORIES = ["LIFE", "CAREER", "VENTURES", "EDUCATION"];

// ── 1. Every known category is SEEDED, not hashed ───────────────────────────────────────────────
for (const c of JOURNEY_CATEGORIES) {
  check(
    `${c} has an explicit seeded hue`,
    typeof CATEGORY_HUES[c] === "number" && categoryHue(c) === CATEGORY_HUES[c],
    `${c} -> ${categoryHue(c)}`,
  );
}

// ── 2. The pair the DEFECT collided is now far apart ────────────────────────────────────────────
// The defect measured 108 vs 128 = 20 degrees. Anything under ~60 reads as "the same colour" at chip
// size and lightness, so that is the floor this asserts.
// THE FLOOR IS DERIVED FROM THE SPEC, NOT INVENTED (corrected 2026-09-13, loop 3).
// It was 60°, chosen as a plausible-sounding aesthetic threshold. The spec's OWN four colours have a
// closest pair of ~53° (Life 250 blue / Ventures 303 purple), so that floor REJECTED the very design
// this file exists to reproduce — the guard would have blocked the fix for the swapped Career and
// Ventures hues. A test that fails the ground truth is not strict, it is wrong, and it is worse than
// no test because it is believed.
// 45° sits below the spec's own minimum and still catches the failure this suite was written for:
// the original hash put Life and Education 20° apart.
const MIN_GAP = 45;
const lifeEdu = hueGap(categoryHue("LIFE"), categoryHue("EDUCATION"));
check(
  "LIFE and EDUCATION are no longer near-identical (the N-5 collision)",
  lifeEdu >= MIN_GAP,
  `gap = ${lifeEdu}° (was 20° at hue 108 vs 128); LIFE=${categoryHue("LIFE")} EDUCATION=${categoryHue("EDUCATION")}`,
);

// ── 3. ALL FOUR are mutually separated, not just the one pair ───────────────────────────────────
let worst = 360;
let worstPair = "";
for (let i = 0; i < JOURNEY_CATEGORIES.length; i++) {
  for (let j = i + 1; j < JOURNEY_CATEGORIES.length; j++) {
    const g = hueGap(categoryHue(JOURNEY_CATEGORIES[i]), categoryHue(JOURNEY_CATEGORIES[j]));
    if (g < worst) {
      worst = g;
      worstPair = `${JOURNEY_CATEGORIES[i]}/${JOURNEY_CATEGORIES[j]}`;
    }
  }
}
check(
  "every pair of journey's four categories is visually distinct",
  worst >= MIN_GAP,
  `closest pair ${worstPair} = ${worst}° (floor ${MIN_GAP}°)`,
);

// ── 4. ALL FOUR of the spec's colours, by hue band ──────────────────────────────────────────────
// This section used to say the spec "names exactly two". It does not — it draws a coloured spine for
// every top-level topic, and docs/AC-journey-widgets.md:51-52 had already recorded all five: green
// (Career), purple (Ventures), orange (Education), blue (Life), grey (Family). Believing the "two"
// story is what let Career and Ventures be INVENTED, and invented near enough to each other's real
// hues to read as swapped. Guarding only the two colours that happened to be documented is what let
// the other two drift; so all four are asserted here.
// (FAMILY is not asserted: the spec draws it grey, which is a chroma of 0, not a hue — see the note
// in widget-colors.ts.)
const inBand = (h: number, lo: number, hi: number) => h >= lo && h <= hi;
check(
  "CAREER lands in the GREEN band, as the spec draws it",
  inBand(categoryHue("CAREER"), 120, 175),
  `CAREER -> ${categoryHue("CAREER")} (green band 120-175)`,
);
check(
  "VENTURES lands in the PURPLE band, as the spec draws it",
  inBand(categoryHue("VENTURES"), 280, 320),
  `VENTURES -> ${categoryHue("VENTURES")} (purple band 280-320)`,
);
check(
  "LIFE lands in the BLUE band, as the spec draws it",
  inBand(categoryHue("LIFE"), 220, 280),
  `LIFE -> ${categoryHue("LIFE")} (blue band 220-280)`,
);
check(
  "EDUCATION lands in the AMBER band, as the spec draws it",
  inBand(categoryHue("EDUCATION"), 40, 110),
  `EDUCATION -> ${categoryHue("EDUCATION")} (amber band 40-110)`,
);

// ── 5. N-6: a topic and a category of the same name really do agree now ─────────────────────────
// Topic names arrive title-cased; categories are upper-snake. All five the verifier measured as
// DISAGREEING must now agree.
for (const [topic, category] of [
  ["Life", "LIFE"],
  ["Education", "EDUCATION"],
  ["Career", "CAREER"],
  ["Ventures", "VENTURES"],
  ["Family", "FAMILY"],
] as const) {
  check(
    `topic "${topic}" and category "${category}" agree in colour`,
    categoryHue(topic) === categoryHue(category),
    `${categoryHue(topic)} vs ${categoryHue(category)}`,
  );
}
check(
  'a spaced topic name matches its upper-snake category ("Prof Education" ~ "PROF_EDUCATION")',
  categoryHue("Prof Education") === categoryHue("PROF_EDUCATION"),
  `${categoryHue("Prof Education")} vs ${categoryHue("PROF_EDUCATION")}`,
);

// ── 6. The fallback still covers anything journey does not ship ─────────────────────────────────
const unknown = categoryHue("SOME_USER_ADDED_CATEGORY");
check(
  "an unknown category still gets a hue from the hash (no per-category code required)",
  Number.isInteger(unknown) && unknown >= 0 && unknown < 360,
  `SOME_USER_ADDED_CATEGORY -> ${unknown}`,
);
check(
  "the fallback is deterministic (same name, same hue, every call)",
  categoryHue("SOME_USER_ADDED_CATEGORY") === unknown && categoryHue("Zebra") === categoryHue("Zebra"),
  `stable across calls -> ${unknown}`,
);

// ── 7. FAMILY is GREY, and grey is a CHROMA of zero, not a hue ──────────────────────────────────
// Leaving Family to the hash was not neutral: it lands on 300°, three degrees from Ventures' 303°,
// so the two rendered as the same purple in the one tree that shows them together. A hue cannot
// express grey, so the chroma scale is what fixes it — and this asserts the COLLISION is harmless
// rather than pretending the hues differ.

check(
  "FAMILY renders GREY (chroma scaled to 0), as the spec draws it",
  categoryChromaScale("FAMILY") === 0,
  `categoryChromaScale("FAMILY") -> ${categoryChromaScale("FAMILY")}`,
);
check(
  "the grey rule is case-insensitive, like every other lookup here",
  categoryChromaScale("Family") === 0 && categoryChromaScale("family") === 0,
  `"Family" -> ${categoryChromaScale("Family")}, "family" -> ${categoryChromaScale("family")}`,
);
for (const c of JOURNEY_CATEGORIES) {
  check(
    `${c} keeps its full chroma (only Family is grey)`,
    categoryChromaScale(c) === 1,
    `categoryChromaScale("${c}") -> ${categoryChromaScale(c)}`,
  );
}
check(
  "FAMILY's hue collision with VENTURES is made harmless by the chroma scale",
  categoryChromaScale("FAMILY") * 1 === 0 && categoryChromaScale("VENTURES") === 1,
  `FAMILY hue ${categoryHue("FAMILY")} vs VENTURES hue ${categoryHue("VENTURES")} — differentiated by chroma, not hue`,
);

console.log(`\n==================== ${pass} passed, ${fail} failed ====================`);
process.exit(fail === 0 ? 0 : 1);
