// WHAT:       Fails the build when any source file mixes a CHROMATIC colour against an OPAQUE
//             ACHROMATIC one in a polar space — the construct that silently rotates hue.
// WHY:        It happened TWICE in one file and neither was caught by 67 green assertions:
//               --warning 9%  + --surface  ->  hue 55 becomes 4.95   (the band rendered PINK)
//               --success 72% + --surface  ->  hue 155 becomes 111.6 (the ▶ rendered YELLOW-GREEN)
//             The owner found the first on his phone. Two instances of one shape is a CLASS, and the
//             org rule is to graduate a class into a deterministic check rather than a third comment.
// SUPERSEDES: nothing
// SUPERSEDED-BY: nothing -- current
// EVIDENCE:   .claude/accuracy-log.md 2026-09-13; docs/LANE-F-widget-ux-fixes.md
//
// Run:  bun scripts/no-achromatic-color-mix.test.ts   (npm run test:color-mix)
//
// WHY THE RULE IS "OPAQUE achromatic", not "achromatic":
//   `color-mix(in oklch, X 22%, transparent)` is SAFE. Interpolation is premultiplied by alpha, so a
//   fully transparent colour contributes alpha only and cannot move the hue. Four such mixes exist in
//   this repo and all four are fine. The hazard is exclusively an OPAQUE neutral — `--surface`,
//   `white`, `black`, `oklch(1 0 0)` — because its hue channel is written as 0 and a polar space
//   interpolates toward that 0.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

let pass = 0,
  fail = 0;
function check(label: string, cond: boolean, detail: string) {
  console.log(`  ${cond ? "PASS" : "FAIL"} ${label} — ${detail}`);
  cond ? pass++ : fail++;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(tsx?|css)$/.test(e)) out.push(p);
  }
  return out;
}

/** Opaque neutrals whose hue channel is literally 0, so mixing toward them rotates the other hue. */
const OPAQUE_NEUTRAL =
  /(var\(--surface(-2)?\)|var\(--background\)|var\(--card\)|\bwhite\b|\bblack\b|oklch\(\s*[\d.]+\s+0\s+0\s*\))/;

/** Blank out comments, preserving offsets so reported line numbers stay true.
 *  WITHOUT THIS THE GUARD FIRES ON ITS OWN DOCUMENTATION: the fixes for both defects quote the old
 *  construct in a comment to explain what was wrong, and the first version of this scanner reported
 *  all three of those comments as offenders. A check that flags the explanation of its own fix is
 *  noise, and a noisy check gets deleted — which is how a repo ends up with no check at all. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + " ".repeat(m.length - p1.length));
}

/** Is this argument list a REAL hazard? Only when a CHROMATIC colour is mixed with an OPAQUE
 *  neutral. `white 20%, transparent` is not: white has no hue to lose and transparent contributes
 *  none. So both halves must be checked, not just "a neutral appears somewhere in the args". */
function isHazard(args: string): boolean {
  if (!/in\s+(oklch|lch|hsl|hwb)/i.test(args)) return false; // only polar spaces interpolate hue
  const parts = args.split(",").map((x) => x.trim());
  const colours = parts.slice(1).map((x) => x.replace(/\s+\d+(\.\d+)?%/, "").trim());
  if (colours.length < 2) return false;
  const neutral = colours.filter((c) => OPAQUE_NEUTRAL.test(c));
  if (neutral.length === 0) return false;
  // The OTHER colour must be chromatic — a var() that is not itself a neutral, or an explicit
  // colour with non-zero chroma. If every colour is neutral/transparent there is no hue at risk.
  return colours.some((c) => !OPAQUE_NEUTRAL.test(c) && !/^transparent$/i.test(c) && /var\(|oklch|lch|hsl|hwb|#|rgb/i.test(c));
}

const files = walk("src");
const offenders: string[] = [];

for (const f of files) {
  const src = stripComments(readFileSync(f, "utf8"));
  const re = /color-mix\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    if (!isHazard(m[1])) continue;
    const line = src.slice(0, m.index).split("\n").length;
    offenders.push(`${f}:${line} — ${m[0].slice(0, 96)}`);
  }
}

check(
  "no source file mixes a chromatic colour against an OPAQUE neutral in a polar space",
  offenders.length === 0,
  offenders.length
    ? `\n      ${offenders.join("\n      ")}\n      Each of these rotates the hue toward 0. Use an explicit token at the intended hue instead.`
    : `${files.length} files scanned, 0 offenders`,
);

// The check must be able to SEE a violation — a scanner that matches nothing is not a guard.
// This is a self-test of the detector, not of the source tree.
const detects = (src: string) => {
  const mm = /color-mix\(([^()]*(?:\([^()]*\)[^()]*)*)\)/.exec(stripComments(src));
  return Boolean(mm && isHazard(mm[1]));
};
const CASES: [string, boolean, string][] = [
  ["the exact construct that shipped the PINK band", true,
   "background: color-mix(in oklch, var(--warning) 9%, var(--surface));"],
  ["the exact construct that shipped the YELLOW-GREEN start button", true,
   "background: color-mix(in oklch, var(--success) 72%, var(--surface));"],
  ["a transparent mix — premultiplied alpha cannot move a hue", false,
   "background: color-mix(in oklch, var(--destructive) 22%, transparent);"],
  ["white into transparent — no hue exists to rotate", false,
   'background: color-mix(in oklch, white 20%, transparent);'],
  ["a COMMENT quoting the old construct — the guard must not flag its own documentation", false,
   "/* was color-mix(in oklch, var(--warning) 9%, var(--surface)) and shipped pink */"],
  ["sRGB mixing — not a polar space, no hue interpolation", false,
   "background: color-mix(in srgb, var(--warning) 9%, var(--surface));"],
];
for (const [label, want, src] of CASES) {
  check(`detector: ${label}`, detects(src) === want, `expected ${want ? "FIRE" : "quiet"} — ${src.slice(0, 80)}`);
}

console.log(`\n==================== ${pass} passed, ${fail} failed ====================`);
process.exit(fail === 0 ? 0 : 1);
