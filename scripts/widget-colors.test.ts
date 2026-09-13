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

import { CATEGORY_HUES, categoryHue } from "../src/features/huddle/lib/tasks/widget-colors";

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
const MIN_GAP = 60;
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

// ── 4. The spec's two named colours, by hue band ────────────────────────────────────────────────
// The spec (docs/widgets/spec-priorities-widget.jpg) names exactly two: Life blue, Education amber.
const inBand = (h: number, lo: number, hi: number) => h >= lo && h <= hi;
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

console.log(`\n==================== ${pass} passed, ${fail} failed ====================`);
process.exit(fail === 0 ? 0 : 1);
