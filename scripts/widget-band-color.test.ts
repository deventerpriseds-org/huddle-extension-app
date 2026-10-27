// WHAT:       Proves the cream band behind the flagged rows in BOTH journey widgets resolves to a
//             YELLOW hue in every theme (light, dark, meeting stage), and that it is not derived by
//             mixing against a neutral whose hue channel is written as zero.
// WHY:        The band shipped PINK and the owner saw it on his phone. BAND_STYLE was
//             `color-mix(in oklch, var(--warning) 9%, var(--surface))`. `--warning` is hue 55, but
//             `--surface` is `oklch(1 0 0)` -- white with an EXPLICIT hue of ZERO -- so oklch
//             interpolated 55 -> 0 and the 9% mix landed at hue ~4.95 / chroma ~0.0144: pale pink.
//             The spec band is cream at hue 92 (docs/widgets/prototype/Priorities.dc.html:155).
//             A colour silently drifting is exactly what an eyeball check does not catch, so the
//             hue is COMPUTED here and asserted against a band, never described.
// SUPERSEDES: nothing
// SUPERSEDED-BY: nothing -- current
// EVIDENCE:   docs/LANE-F-widget-ux-fixes.md (D-1), with the mutation-proof run recorded there.
//
// Run:  bun scripts/widget-band-color.test.ts   (npm run test:widget-band-color)

import { readFileSync } from "node:fs";

let pass = 0,
  fail = 0;
function check(label: string, cond: boolean, detail: string) {
  console.log(`  ${cond ? "PASS" : "FAIL"} ${label} — ${detail}`);
  cond ? pass++ : fail++;
}

const STYLES = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
const WIDGETS = readFileSync(
  new URL("../src/features/huddle/components/JourneyWidgets.tsx", import.meta.url),
  "utf8",
);

/** Shortest arc on the 360-degree wheel — 350 and 10 are 20 apart, not 340. */
function hueGap(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/** `oklch(0.975 0.032 92)` -> {l,c,h}. Returns null for anything that is not a bare oklch literal,
 *  which is itself the point: a `color-mix(...)` or a `var(...)` indirection cannot be reasoned
 *  about statically, and the band must not be either. */
function parseOklch(v: string): { l: number; c: number; h: number } | null {
  const m = v
    .trim()
    .match(/^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*(?:\/\s*[\d.]+\s*)?\)$/);
  if (!m) return null;
  return { l: Number(m[1]), c: Number(m[2]), h: Number(m[3]) };
}

/** What CSS color-mix in oklch actually does to two literals, so the defect below is reproduced by
 *  arithmetic rather than asserted from memory. Straight (non-premultiplied) — both inputs here are
 *  fully opaque, which is the case that bit us. */
function mixOklch(
  a: { l: number; c: number; h: number },
  pct: number,
  b: { l: number; c: number; h: number },
): { l: number; c: number; h: number } {
  const w = pct / 100;
  // Hue interpolates on the SHORTER arc by default. 55 -> 0 is already the short way round.
  let dh = b.h - a.h;
  if (dh > 180) dh -= 360;
  if (dh < -180) dh += 360;
  return {
    l: a.l * w + b.l * (1 - w),
    c: a.c * w + b.c * (1 - w),
    h: (a.h + dh * (1 - w) + 360) % 360,
  };
}

/** Pull a custom property's value out of one CSS rule block. */
function tokenIn(selector: string, prop: string): string | null {
  const block = STYLES.split(selector)[1];
  if (!block) return null;
  const body = block.slice(0, block.indexOf("}"));
  const m = body.match(new RegExp(`${prop}\\s*:\\s*([^;]+);`));
  return m ? m[1].trim() : null;
}

// The spec's band, read off the committed prototype rather than chosen here.
const SPEC_HUE = 92;
// Cream/pale-yellow occupies roughly 60-120 on the oklch wheel. The failure this exists to catch
// landed at ~5 (pink) and `--warning` itself is 55 (orange), so both sit outside.
const YELLOW_MIN = 70;
const YELLOW_MAX = 115;

console.log("\n── 1. The band token is an explicit oklch literal in EVERY theme ──────────────────");

const THEMES: { selector: string; label: string; maxL: number; minL: number }[] = [
  { selector: ":root {", label: "light", minL: 0.9, maxL: 1 },
  { selector: ".dark {", label: "dark", minL: 0.15, maxL: 0.4 },
  { selector: ".meeting-stage {", label: "meeting stage", minL: 0.15, maxL: 0.4 },
];

for (const t of THEMES) {
  const raw = tokenIn(t.selector, "--band-cream");
  check(`${t.label}: --band-cream is defined`, raw !== null, raw ?? "MISSING");
  if (!raw) continue;

  const col = parseOklch(raw);
  check(
    `${t.label}: --band-cream is a bare oklch literal (not a color-mix or var indirection)`,
    col !== null,
    raw,
  );
  if (!col) continue;

  check(
    `${t.label}: band hue is YELLOW, not pink — ${YELLOW_MIN} <= h <= ${YELLOW_MAX}`,
    col.h >= YELLOW_MIN && col.h <= YELLOW_MAX,
    `h = ${col.h} (spec ${SPEC_HUE}, off by ${hueGap(col.h, SPEC_HUE).toFixed(1)}°)`,
  );
  check(
    `${t.label}: band carries enough chroma to read as a tint at all`,
    col.c >= 0.02,
    `c = ${col.c}`,
  );
  check(
    `${t.label}: band lightness suits the theme it is painted on`,
    col.l >= t.minL && col.l <= t.maxL,
    `l = ${col.l} (expected ${t.minL}–${t.maxL})`,
  );
}

console.log("\n── 2. BAND_STYLE reads the token and derives nothing ─────────────────────────────");

const bandStyle = WIDGETS.match(/const BAND_STYLE[\s\S]{0,200}?};/)?.[0] ?? "";
check(
  "BAND_STYLE reads var(--band-cream)",
  /backgroundColor:\s*["']var\(--band-cream\)["']/.test(bandStyle),
  bandStyle.replace(/\s+/g, " ").slice(0, 120) || "BAND_STYLE not found",
);
check(
  "BAND_STYLE does NOT color-mix (the hue-collapse trap that shipped pink)",
  !/color-mix/.test(bandStyle),
  bandStyle.includes("color-mix") ? "still mixing" : "no color-mix in BAND_STYLE",
);

console.log("\n── 3. The original defect, reproduced by arithmetic ──────────────────────────────");

// Both read from styles.css so this stays true if the palette moves.
const warning = parseOklch(tokenIn(":root {", "--warning") ?? "");
const surface = parseOklch(tokenIn(":root {", "--surface") ?? "");
check(
  "--warning and --surface are both readable literals",
  warning !== null && surface !== null,
  `warning=${JSON.stringify(warning)} surface=${JSON.stringify(surface)}`,
);
if (warning && surface) {
  const old = mixOklch(warning, 9, surface);
  check(
    "the OLD 9% warning/surface mix really did land in the PINK/RED band (h < 20)",
    old.h < 20,
    `computed oklch(${old.l.toFixed(4)} ${old.c.toFixed(4)} ${old.h.toFixed(2)}) — this is what shipped`,
  );
  check(
    "...and it is far from the spec's cream, which is why it was visible as wrong",
    hueGap(old.h, SPEC_HUE) > 60,
    `${hueGap(old.h, SPEC_HUE).toFixed(1)}° from hue ${SPEC_HUE}`,
  );
  // --surface having an EXPLICIT zero hue is the mechanism. If someone ever rewrites it as a hueless
  // white the trap changes shape, and this line says so out loud rather than leaving it implied.
  check(
    "the mechanism is --surface's explicit zero hue channel",
    surface.h === 0,
    `--surface = oklch(${surface.l} ${surface.c} ${surface.h})`,
  );
}

console.log(`\n==================== ${pass} passed, ${fail} failed ====================`);
process.exit(fail === 0 ? 0 : 1);
