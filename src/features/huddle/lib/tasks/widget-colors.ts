/* WHAT:       The single source of the hue used to colour a journey category chip and the matching
 *             topic-tree rail in the priorities widget.
 * WHY:        `categoryHue` used to be a bare hash living inside JourneyWidgets.tsx. Measured by the
 *             loop-2 verifier: it put LIFE at 108 and EDUCATION at 128 -- two of journey's four real
 *             categories rendering as near-identical greens, 20 degrees apart, when the spec
 *             screenshot (docs/widgets/spec-priorities-widget.jpg) makes those two the most
 *             distinct pair on screen (Life blue, Education amber). It also made the file's own
 *             claim that a topic and a category of the same name "agree in colour for free" false
 *             5/5, because the hash was case-sensitive and journey stores categories upper-snake.
 *             (docs/VERIFY-journey-widgets-2.md, N-5 and N-6.)
 * SUPERSEDES: the inline `categoryHue` in JourneyWidgets.tsx (deleted on this commit; the component
 *             imports this instead -- one hue function, not two)
 * SUPERSEDED-BY: nothing -- current
 * EVIDENCE:   docs/LANE-E-loop2-fixes.md; scripts/widget-colors.test.ts (npm run test:widget-colors)
 *
 * Pure and DOM-free on purpose, so the separation between the chosen hues is PROVEN by executing it
 * rather than by eyeballing the numbers.
 */

/** journey's real category set — `journey-voice/supabase/functions/_shared/tool-definitions.ts`.
 *  Seeded explicitly because the spec colour-codes them and a hash cannot be asked for a particular
 *  colour; the hash below still covers anything the user adds, which is why this is a seed table and
 *  not an exhaustive one. Keys are upper-snake, the shape journey stores.
 *
 *  Hues are OKLCH degrees, chosen for MAXIMUM mutual separation (min pairwise distance 90 degrees —
 *  asserted, not assumed, by the test) with the two the spec names pinned:
 *    LIFE      = blue   (spec)
 *    EDUCATION = amber  (spec)
 *    CAREER / VENTURES  = the two remaining quadrants, as far from those two and each other as the
 *                         wheel allows. */
export const CATEGORY_HUES: Readonly<Record<string, number>> = Object.freeze({
  LIFE: 250, // blue      — spec
  EDUCATION: 70, // amber — spec
  CAREER: 149, // green   — spec
  VENTURES: 303, // purple — spec
});

// CAREER AND VENTURES WERE INVENTED, AND WERE EFFECTIVELY SWAPPED (fixed 2026-09-13, loop 3).
// They were picked as "the two remaining quadrants, as far apart as the wheel allows" on the
// premise that the spec named only Life and Education. That premise was wrong: the spec draws a
// coloured spine for EVERY top-level topic, and docs/AC-journey-widgets.md had already recorded all
// five — "green (Career), purple (Ventures), orange (Education), blue (Life), grey (Family)".
// Measured off the spec JPEG's own pixels: Career 149° green, Ventures 303° purple. The invented
// values (340 magenta, 160 teal) sat 151° and 143° away — near enough to each other's true hues to
// read as the two categories swapped.
// The lesson is the same one this repo keeps relearning: an aesthetic rule invented to fill a gap
// beats reading the source ONLY until someone reads the source.
//
// FAMILY is not in the map because the spec draws it GREY, and grey is not a hue at all — it is a
// CHROMA of zero. Leaving it to the hash was not neutral: it landed on 300°, three degrees from
// Ventures' 303°, so the two rendered as the same purple in the one tree that shows them together.
// Inventing a hue for it would have repeated the exact mistake corrected above, so the chroma
// channel below exists instead.

/** Deterministic fallback for any category journey does not ship — the original hash, unchanged
 *  except that it now runs on the NORMALIZED name (see `categoryHue`). */
function hashHue(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
  return h;
}

/** Normalizing to upper-snake is what makes the topic rail and the category chip agree: journey
 *  stores categories as `LIFE` / `PROF_EDUCATION` while topic names arrive title-cased ("Life"), and
 *  the old case-sensitive hash therefore gave them different colours in the one widget that shows
 *  both at once. */
function normalize(name: string): string {
  return name
    .trim()
    .replace(/[\s-]+/g, "_")
    .toUpperCase();
}

/** The hue (OKLCH degrees, 0-359) for a category or topic name. Seeded for journey's four known
 *  categories so they match the spec and stay visually far apart; hashed for everything else so a
 *  user-added category still gets a stable colour with zero per-category code. */
export function categoryHue(name: string): number {
  const key = normalize(name);
  return CATEGORY_HUES[key] ?? hashHue(key);
}

/** Categories the spec draws as GREY rather than as a colour. */
const GREY_CATEGORIES: ReadonlySet<string> = new Set(["FAMILY"]);

/**
 * Multiplier for the CHROMA a caller would otherwise use: `1` for a normal coloured category, `0`
 * for one the spec draws grey.
 *
 * Callers keep owning their own chroma (a chip is muted, a rail is saturated), so this scales rather
 * than replaces it — `oklch(0.62 ${0.16 * categoryChromaScale(n)} ${categoryHue(n)})`. At 0 the hue
 * becomes irrelevant and the result is a true neutral at that lightness, which is what "grey" means
 * in oklch and what no hue value can express.
 */
export function categoryChromaScale(name: string): number {
  return GREY_CATEGORIES.has(normalize(name)) ? 0 : 1;
}
