# LANE F — the four UX defects the owner found on his phone

<!--
WHAT:       The fix record for four UX defects the owner reported by looking at the LIVE app on his
            phone: a pink band that should be cream, two stacked nav bars, phone nav at the top
            instead of the bottom, and full-page views rendered as small cards.
WHY:        The previous round shipped this UI with no design pass. Each defect below is
            ground-truthed in source BEFORE it is changed, and the colour defect gets a computed
            guard because a colour drifting silently is precisely what an eyeball check misses.
SUPERSEDES: nothing. Corrects work recorded in docs/LANE-C-widget-ui.md (the widget UI lane).
SUPERSEDED-BY: nothing -- current
EVIDENCE:   Command output is pasted verbatim below, including the mutation proof for the new guard.
-->

**Branch:** `claude/widget-ux-fixes`, cut from `origin/main` at `225c654`. Nothing here is pushed to
`main`; this is going through review.

**Nothing in this document is confirmed until the owner sees it on his phone.** Every claim below is
either source I read or command output I ran. The mechanism is verified locally; the defects were
reported from a live phone and only the owner looking at that phone again closes them.

The owner's words, which are the requirement:

> "the priorities is not a direct port of the view in journey also the colors are using a strange
> pink instead of pale yellow for both widgets. why are they in cards instead of using the entire
> panel , strange ux decision? you also placed what looks to be a cross app bar that is the side are
> in bigger screens at the top rather than the bottom, no matter how much it broke modern UI
> conventions."

---

## D-1 — THE PINK BAND (both widgets) — FIXED

### Ground truth, read before changing anything

`JourneyWidgets.tsx:505` defined the band as a derivation:

```js
const BAND_STYLE: React.CSSProperties = {
  backgroundColor: "color-mix(in oklch, var(--warning) 9%, var(--surface))",
};
```

Both inputs, read from `src/styles.css`:

| token | value | note |
|---|---|---|
| `--warning` | `oklch(0.72 0.16 55)` | orange, hue 55 |
| `--surface` | `oklch(1 0 0)` | white **with an explicit hue channel of ZERO** — not a hueless white |

That explicit `0` is the whole mechanism. `color-mix` in oklch interpolates the hue channel like any
other, so a 9% mix walks the hue from 55 toward 0 and lands just short of it. Computed rather than
eyeballed (`scripts/widget-band-color.test.ts` section 3, output pasted below):

```
computed oklch(0.9748 0.0144 4.95) — this is what shipped
```

**Hue 4.95, chroma 0.0144. That is a pale pink.** The owner is right, and the arithmetic says so
without needing a screen. The spec's band is cream at **hue 92** — the committed prototype already
carries the correct literal at `docs/widgets/prototype/Priorities.dc.html:155`:

```html
<div style="background: oklch(0.975 0.032 92);">
```

### The other two `color-mix` calls in that file — checked, as asked

| line | expression | affected? |
|---|---|---|
| 318 | `color-mix(in oklch, var(--success) 72%, var(--surface))` | **YES, same trap.** `--success` is hue 155; mixing 72/28 against hue 0 drags the result to hue **111.6** and chroma 0.1008. It is a 43° hue shift from the intended green toward yellow-green. It is far less visible than the band because at 72% the colour still reads as green, so it was not what the owner saw — but it is the identical mechanism and it is not delivering the token's hue. **Left unchanged in this pass** (see "Not reached" at the bottom): it is the `DoneButton` fill, the owner did not report it, and changing a control colour is a separate design call I would rather show him than make silently. Recorded here so it is not lost. |
| 479 | `color-mix(in oklch, var(--destructive) 22%, transparent)` | **NO.** Mixing with `transparent` is the one safe case. CSS Color 5 premultiplies by alpha before interpolating, and `transparent` is `rgb(0 0 0 / 0)` — alpha 0, so its colour channels contribute nothing to the premultiplied result. Un-premultiplying returns `--destructive` at exactly its own hue with alpha 0.22. No hue contamination. This is the dictation-level ring shadow and it is correct as written. |

### The fix

The band is now **one explicit token**, `--band-cream`, defined per theme in `src/styles.css` where
the rest of the palette lives — not derived, so it cannot drift again:

| theme | value | reasoning |
|---|---|---|
| `:root` (light) | `oklch(0.975 0.032 92)` | the prototype's literal, unchanged |
| `.dark` | `oklch(0.255 0.030 92)` | same hue 92. Lit for dark: `--surface` is L 0.20 and `--surface-2` is L 0.23, so L 0.255 lifts off the surface by about the same amount `--surface-2` does. A bright cream here would glare. |
| `.meeting-stage` | `oklch(0.25 0.030 92)` | the room is always dark regardless of app theme and overrides `--surface` itself, so it needs its own copy or it would inherit the near-white light value. |

`--color-band-cream` is registered in the `@theme inline` block alongside every other colour token,
matching the file's existing convention.

### The guard, and its mutation proof

`scripts/widget-band-color.test.ts` (`npm run test:widget-band-color`). It does not string-match a
colour; it **parses the token out of `styles.css`, computes, and asserts a hue band** — and it
re-derives the original defect from the live `--warning` and `--surface` values so the arithmetic
stays true if the palette moves.

```
── 1. The band token is an explicit oklch literal in EVERY theme ──────────────────
  PASS light: --band-cream is defined — oklch(0.975 0.032 92)
  PASS light: --band-cream is a bare oklch literal (not a color-mix or var indirection) — oklch(0.975 0.032 92)
  PASS light: band hue is YELLOW, not pink — 70 <= h <= 115 — h = 92 (spec 92, off by 0.0°)
  PASS light: band carries enough chroma to read as a tint at all — c = 0.032
  PASS light: band lightness suits the theme it is painted on — l = 0.975 (expected 0.9–1)
  PASS dark: --band-cream is defined — oklch(0.255 0.030 92)
  PASS dark: --band-cream is a bare oklch literal (not a color-mix or var indirection) — oklch(0.255 0.030 92)
  PASS dark: band hue is YELLOW, not pink — 70 <= h <= 115 — h = 92 (spec 92, off by 0.0°)
  PASS dark: band carries enough chroma to read as a tint at all — c = 0.03
  PASS dark: band lightness suits the theme it is painted on — l = 0.255 (expected 0.15–0.4)
  PASS meeting stage: --band-cream is defined — oklch(0.25 0.030 92)
  PASS meeting stage: --band-cream is a bare oklch literal (not a color-mix or var indirection) — oklch(0.25 0.030 92)
  PASS meeting stage: band hue is YELLOW, not pink — 70 <= h <= 115 — h = 92 (spec 92, off by 0.0°)
  PASS meeting stage: band carries enough chroma to read as a tint at all — c = 0.03
  PASS meeting stage: band lightness suits the theme it is painted on — l = 0.25 (expected 0.15–0.4)

── 2. BAND_STYLE reads the token and derives nothing ─────────────────────────────
  PASS BAND_STYLE reads var(--band-cream) — const BAND_STYLE: React.CSSProperties = { backgroundColor: "var(--band-cream)", };
  PASS BAND_STYLE does NOT color-mix (the hue-collapse trap that shipped pink) — no color-mix in BAND_STYLE

── 3. The original defect, reproduced by arithmetic ──────────────────────────────
  PASS --warning and --surface are both readable literals — warning={"l":0.72,"c":0.16,"h":55} surface={"l":1,"c":0,"h":0}
  PASS the OLD 9% warning/surface mix really did land in the PINK/RED band (h < 20) — computed oklch(0.9748 0.0144 4.95) — this is what shipped
  PASS ...and it is far from the spec's cream, which is why it was visible as wrong — 87.1° from hue 92
  PASS the mechanism is --surface's explicit zero hue channel — --surface = oklch(1 0 0)

==================== 21 passed, 0 failed ====================
```

**Mutation proof** — the defect reinstated verbatim (the exact `color-mix` that shipped), anchors
supplied from FILES, not shell arguments:

```
$ printf -- '  --band-cream: oklch(0.975 0.032 92);' > /tmp/anchor-d1.txt
$ printf -- '  --band-cream: color-mix(in oklch, var(--warning) 9%%, var(--surface));' > /tmp/repl-d1.txt
$ mutate.sh src/styles.css /tmp/anchor-d1.txt /tmp/repl-d1.txt "npm run test:widget-band-color" "FAIL"

FIRED: 'FAIL' failed with the defect reinstated. The guard is real.
restored: src/styles.css matches HEAD
tree clean: 'FAIL' passes again on the restored tree (build output regenerated)
```

**FIRED.** The exact colour that shipped, put back into the token, makes the suite fail; the anchor
matched once and the file was restored to `HEAD`. This is not `NOT-APPLIED` (the anchor matched, as
the pre-check `grep -c` showed: 1 occurrence) and not `INERT` (the suite genuinely failed).

---

## Status of the remaining defects

<!-- STATUS -->
