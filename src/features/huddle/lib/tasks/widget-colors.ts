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
  LIFE: 250, // blue
  EDUCATION: 70, // amber
  CAREER: 340, // magenta/rose
  VENTURES: 160, // teal
});

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
