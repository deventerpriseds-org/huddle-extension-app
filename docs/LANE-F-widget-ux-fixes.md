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

## D-2 — TWO STACKED NAV BARS — FIXED

### Ground truth

Two switchers, both unguarded at 390px:

| where | entries | guard |
|---|---|---|
| `HuddleView.tsx:190` — the **incumbent**, beside the Meeting button | `["huddle","board","artifacts"]` | none. It rendered at every width. |
| `HuddleApp.tsx:66` + `:412` — `NAV_LABELS`, added later | five, icon-over-label | `md:app-hidden` — phone only |

So on a phone both were on screen, stacked, which is what the screenshot shows. The second bar was
not gratuitous: the incumbent lives inside `HuddleView`, which only mounts when `view === "huddle"`,
so it **unmounts the moment you leave the huddle view** and stranded users on Board/Files with no way
back. That behaviour has to survive the fix.

### The fix — extend the incumbent, per `CLAUDE.md`'s "extend, don't duplicate"

New `src/features/huddle/components/ViewSwitcher.tsx` carries the **incumbent's exact anatomy**
(`rounded-lg border border-hairline bg-surface p-0.5`; pills `rounded-md px-3 py-1 text-xs
font-medium`; active `bg-muted text-foreground`) and **one** entry list, now five entries. `NAV_LABELS`
is deleted. The dead `view`/`setView` props that were threaded into `HuddleHeader` purely to feed the
old inline map are removed too — `ViewSwitcher` reads the store directly, the same way `Rail` does.

The always-mounted property is kept by rendering the bottom variant from `HuddleApp` (outside any
view) rather than from inside `HuddleView`.

**Exactly one switcher is on screen at any width**, because the two render sites are complementary at
the same breakpoint:

```
$ grep -rn "ViewSwitcher variant" src/
src/features/huddle/components/HuddleView.tsx:185:  <ViewSwitcher variant="inline" className="app-hidden md:inline-flex" />
src/features/huddle/components/HuddleApp.tsx:392:   <ViewSwitcher variant="bottom" className="md:app-hidden" />
```

`md` is the breakpoint the desktop `Rail` and `Sidebar` already use (`md:flex`), so the header pills
appear exactly where the rail does. **The Rail is untouched** — it already listed all five views
(`Rail.tsx:20-25`), which is why the five icons match its icons for the same view.

---

## D-3 — PHONE NAV BELONGS AT THE BOTTOM — FIXED

The surviving switcher rendered **above** `{VIEWS[view]}`. It now renders **after** it, below `md`.

Two properties the brief called out, and how each is met structurally rather than by tuning:

- **It must not cover the composer or the last message.** The bar is a **normal flex child** of the
  same column, not `fixed`/`absolute`. The column gives it its own height and the view above simply
  gets shorter. There is nothing to "reserve" because there is no overlap to compensate for — an
  overlay plus matching bottom padding is the fragile version of this and is not what shipped.
- **Safe-area inset.** `paddingBottom: calc(0.25rem + env(safe-area-inset-bottom))`, so it clears the
  phone browser's bottom toolbar and the home indicator. `env()` resolves to `0` where there is no
  inset, so it costs nothing on desktop.

Five entries at 390px are **icon-over-label in five equal columns**, not text pills — five text pills
do not fit, and the design prototype names this exact constraint and this exact answer
(`docs/widgets/prototype/canvas.json`, annotation `phone-note`). Each column is `min-h-11` (44px), the
minimum touch target. This is an **adaptation, stated**: the inline desktop variant is text-only
because that is what the incumbent was.

---

## D-4 — CARDS INSTEAD OF THE PANEL — FIXED

### Ground truth

Both widgets opened with the same unconditional shell (`JourneyWidgets.tsx:660` and `:766`):

```jsx
<div className="overflow-hidden rounded-xl border border-hairline bg-surface shadow-soft">
```

That is correct for a card floating in the chat transcript and wrong in the other two places it was
used:

- **As a full-page view.** `WidgetPage` wrapped its child in `px-3 py-4 sm:px-6` and then
  `mx-auto max-w-3xl`. Panel padding, then a width cap, then the widget's own border — so a full-page
  view drew a **small bordered card marooned in a large empty panel**. The owner's words exactly.
- **In the dock.** `DockedJourneyWidgets` is itself `rounded-xl border border-hairline`, and it
  contained two more bordered, shadowed cards. **A box in a box.**

### The fix

One helper, three contexts, so a fourth caller cannot invent a fourth look:

| `chrome` | used by | shell |
|---|---|---|
| `card` (default) | the chat stream | unchanged — it genuinely is a card |
| `page` | `PrioritiesView` / `ScheduleView` | `flex min-h-0 min-w-0 flex-1 flex-col bg-surface` — no border, no radius, no shadow. The **panel** is the container; the widget fills it and its own sections scroll. |
| `bare` | the dock | no chrome; the dock shell already provides it. The two widgets become sections of the dock, separated by `divide-y divide-hairline`. |

`WidgetPage` loses its padding and `max-w-3xl` wrapper: the view's own header bar is the page chrome
and the widget fills the rest edge to edge.

### One guard had to be loosened — said out loud, not quietly

`widget-live-refresh.test.ts` asserted the `live` prop with a regex that pinned it as the **final**
attribute:

```
/<PrioritiesWidget data=\{data\} full=\{full\} live \/>/
```

Adding `chrome` after `live` made that fail while `live` was still being passed — a true statement
reported as a defect. Per this repo's rule that a firing trap is signal, I did not delete it: the
assertion's **intent** is that `live` reaches the widget, and the replacement asserts exactly that
(lookaheads for `data`/`full`, then `live` as a bare prop anywhere in the element). **Mutation-proved
that it still catches the real defect:**

```
$ printf -- '  return <PrioritiesWidget data={data} full={full} live chrome={chrome} />;' > /tmp/anchor-d4.txt
$ printf -- '  return <PrioritiesWidget data={data} full={full} chrome={chrome} />;'      > /tmp/repl-d4.txt
$ grep -c ... src/features/huddle/components/JourneyWidgets.tsx
1
$ mutate.sh src/features/huddle/components/JourneyWidgets.tsx /tmp/anchor-d4.txt /tmp/repl-d4.txt "npm run test:widget-live" "FAIL"

FIRED: 'FAIL' failed with the defect reinstated. The guard is real.
restored: src/features/huddle/components/JourneyWidgets.tsx matches HEAD
tree clean: 'FAIL' passes again on the restored tree (build output regenerated)
```

**FIRED.** Remove `live` and the loosened guard still fails. It was over-specified, not load-bearing
on attribute order.

---

## D-5 — PRIORITIES IS NOT A FAITHFUL PORT — **NOT REACHED**

**I did not do this one, and I am not going to summarise it from the code alone.**

The brief's first instruction for D-5 is to compare `docs/widgets/spec-priorities-widget.jpg` region
by region against what the component renders, and list **every** divergence before fixing any of it.
I never opened the JPEG. Anything I wrote about "what the spec shows" would be reconstructed from the
prose in the brief and from comments already in the file — the same
answering-from-a-proxy-instead-of-the-primary-source failure this repo's rules exist to stop. A
divergence list assembled that way would look authoritative and be unverified.

What I can say, strictly from source I did read, is that the elements the brief names as known are
all **present in some form** in `PrioritiesWidget` — header with a gear (`:663`), an "Add a priority…"
compose pill (`:675`), the banded flagged rows with a `CategoryChip` and a `TodayButton` per row
(`PriorityRow`, `:549`), and the topic tree with coloured spines, disclosure triangles and
right-aligned counts (`TopicRow`, `:569`). **Whether they match the spec in layout, order,
proportion, typography or grouping is exactly the question I did not answer**, and "the elements
exist" is not the same claim as "it is a faithful port". The owner says it is not a faithful port; he
has seen both and I have not, so his report stands unchallenged.

**Next session:** open the JPEG first, write the divergence table, then fix. Do not start from this
file's element list.

---

## Also found, NOT fixed — the same hue-collapse bug, one more place

`JourneyWidgets.tsx:318` — `color-mix(in oklch, var(--success) 72%, var(--surface))` on the
`DoneButton` fill. Identical mechanism to D-1: hue 155 dragged to **111.6** against `--surface`'s
explicit zero hue. Far less visible than the band (at 72% it still reads as green), which is why it
is not what the owner saw. Left alone deliberately: he did not report it, and restyling a control is
a design call I would rather show him than make silently. Recorded here so it is not lost a second
time.

---

## Verification run on the final commit

```
$ npx tsc --noEmit                 -> exit 0
$ npm run test:widget-park         -> 10 passed, 0 failed
$ npm run test:widget-colors       -> 25 passed, 0 failed
$ npm run test:widget-live         -> 12 passed, 0 failed
$ npm run test:router              -> 20 passed, 0 failed
$ npm run test:widget-band-color   -> 21 passed, 0 failed   (new)
```

`eslint` introduces **no new errors**. Both touched files report the identical pre-existing
prettier-error count as their `HEAD` versions, measured by linting the `HEAD` copy of each file
side by side: `HuddleApp.tsx` 13 before and after, `JourneyWidgets.tsx` 36 before and after. The
pre-existing formatting noise is left alone rather than swept up, so the diff stays reviewable.

## A container rewind happened mid-task, and what it cost

Partway through D-2/D-3 the container was restored: the checkout was reset to `main` (which had
meanwhile moved to `004341b`, another session's accuracy-log commit) and the D-1 work vanished from
the working tree — `package.json` had lost its new script, which is how it surfaced, as a test suite
that had passed minutes earlier reporting "Missing script".

**Nothing was lost, because D-1 had been committed AND pushed.** `origin/claude/widget-ux-fixes` still
had both commits; `git rev-list --left-right --count` showed `2 1` (behind 2, ahead 1) rather than a
clean "behind", so a bare `reset --hard` was the wrong instrument. The uncommitted D-2/D-3 files were
copied out to the scratchpad first, the branch was checked back out, and they were restored on top.
This is the per-fix commit-and-push discipline paying for itself inside a single task.

## What is confirmed and what is not

**Confirmed by running it:** the band's hue arithmetic, the guard firing under mutation, the
typecheck, the five suites, the lint delta, and that exactly two complementary `ViewSwitcher` render
sites exist.

**NOT confirmed:** any of it on a phone. Every one of these four defects was found by the owner
looking at the live app on his own device, and three of the four are things only a rendered screen
can settle — whether the cream reads as cream to his eye, whether the bottom bar actually clears his
browser's toolbar, whether a full-bleed view looks right at 390px. There is no Playwright run behind
this document. **Status: implemented, mechanism verified locally, NOT yet confirmed live.**
