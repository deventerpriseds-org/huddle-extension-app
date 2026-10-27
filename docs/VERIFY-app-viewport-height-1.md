# VERIFY — app-viewport-height, loop 1

<!--
WHAT:       Independent verification of commit 725e8ff (`--app-h` from window.visualViewport, shell
            sized `height: var(--app-h, 100dvh)`) against the DEPLOYED SWA in a real Chromium.
WHY:        The owner reported the bottom nav dock not staying at the bottom on his phone (Samsung
            Internet, Android) — scrollable up, floating above a blank strip with the keyboard below.
            The fix shipped with 9 LOGIC assertions against fake objects and nothing rendered.
SUPERSEDES: nothing
SUPERSEDED-BY: nothing -- current
EVIDENCE:   verify-uat.yml runs 34783668711 and 34784103480; checks module
            .claude/skills/test-agent-serverfn/scripts/viewport-height-checks.mjs
-->

**Verifier:** independent subagent, no shared context with the implementing session.
**Under test:** `src/features/huddle/hooks/useAppViewportHeight.ts` + `HuddleApp.tsx` shell, commit
725e8ff, live on `https://icy-flower-0f415200f.7.azurestaticapps.net`.
**Vehicle:** the repo's existing `verify-uat.yml` + app-agnostic `run-uat.mjs`, with a new
app-specific checks module. No new harness was invented.
**Viewport:** 390 x 844 — the owner's phone pair.

## READ THIS BEFORE THE TABLE — what a green row here does and does not mean

| | |
|---|---|
| Playwright drives | **Chromium** |
| The owner's browser is | **Samsung Internet on Android** — Chromium-*based*, not Chromium, and its visual-viewport/keyboard behaviour is precisely where it diverges |
| The "keyboard" here is | **a programmatic viewport resize**, not a soft keyboard |

Concretely, and this is the finding that matters most in this whole document: the CDP call that
would have reproduced the *real* defect shape — visual viewport shrinks while the layout viewport
stays tall — **did nothing in this Chromium**. What did work shrinks *both* viewports at once. So
what is proven below is that **the hook subscribes to visual-viewport changes and republishes a
correct `--app-h`, and the shell follows it**. What is *not* reproduced is the layout-taller-than-
visual state the owner actually photographed.

**MECHANISM ONLY. The owner opening the app on his own device is the verdict.**

## Claims

| # | Claim | Verdict | Evidence |
|---|---|---|---|
| C1 | `--app-h` published, equals `round(vv.height - vv.offsetTop)` | **CONFIRMED** | run 34783668711 |
| C2 | Shell's rendered height equals `--app-h` | **CONFIRMED** | run 34783668711 |
| C3 | `--app-h` shrinks with a simulated visual-viewport shrink | **CONFIRMED, with a stated limit** | runs 34783668711, 34783820045 |
| C4 | Bottom nav stays in the bottom of the visible region after the shrink | **CONFIRMED** | run 34783820045 |
| C5 | Degrade path with `visualViewport` unavailable | **C5a CONFIRMED / C5b NOT PROVEN (harness limit)** | run 34783668711 |
| C6 | No console errors, no failed requests | **CONFIRMED** | run 34783668711 |

---

### C1 — `--app-h` is a real pixel value equal to the visible height — **CONFIRMED**

Evaluated in the page at 390x844:

```
getComputedStyle(document.documentElement).getPropertyValue('--app-h')  ->  "844px"
Math.round(Math.max(0, visualViewport.height - visualViewport.offsetTop))
   = round(844 - 0)                                                     ->  844
```

Equal. For context in the same evaluation: `document.documentElement.clientHeight` = 844,
`window.innerHeight` = 844 — with no keyboard the layout and visual viewports agree, which is exactly
why this defect is invisible on a desktop.

Screenshot: `01-c1-loaded-390x844.png`.

### C2 — the shell's rendered height is that value — **CONFIRMED**

**How the shell was identified** (structurally, not via a test hook I added): starting from
`nav[aria-label="Primary"]`, walk up ancestors to the first whose *inline* `style` attribute matches
`/height:\s*var\(--app-h/`. That resolved to:

```
<div class="flex w-full overflow-hidden bg-background text-foreground">
```

which is the element 725e8ff changed (it previously carried `h-dvh` in that class list). Measured:

```
getComputedStyle(shell).height        ->  844px
shell.getBoundingClientRect().height  ->  844
--app-h                               ->  844px
```

Screenshot: `02-c2-shell.png`.

### C3 — simulated shrink — **CONFIRMED that `--app-h` tracks it; the real keyboard shape was NOT reproducible**

Two CDP APIs were tried in order, and the result of each is reported rather than only the one that
worked, because *which* one worked is the honest limit of this claim.

| API tried | `visualViewport.height` | `documentElement.clientHeight` (layout) | outcome |
|---|---|---|---|
| `Emulation.setVisibleSize` (visual-only — would reproduce the real keyboard shape) | 844 → **844** | 844 → 844 | **silent no-op.** No error thrown, nothing changed. Deprecated in the protocol; this Chromium ignores it. |
| `Emulation.setDeviceMetricsOverride` | 844 → **500** | 844 → **500** | fired a `visualViewport` resize — but shrank the **layout viewport too** |

Under the working one, measured:

```
--app-h                        844px -> 500px
expected round(500 - 0)              = 500px      MATCH
getComputedStyle(shell).height       = 500px      shell followed
documentElement.clientHeight         = 500px      layout ALSO shrank
```

**So:** the hook is genuinely subscribed, recomputes on resize, and the shell re-sizes with it —
that is real and it is the mechanism the fix depends on. But because `setDeviceMetricsOverride`
moves both viewports together, this run **never entered the state the owner is actually in** (layout
844, visual 500). Per the brief's instruction, the exact API attempted for that state and its exact
result are named above rather than glossed.

Screenshot: `03-c3-after-shrink.png`. Identical numbers in both runs.

### C4 — the nav does not fall below the fold after the shrink — **CONFIRMED**

Measured in run 34783820045 **with the shrink verified still in effect at probe time** (the guard
added after run 1's false pass):

```
visible height (round(vv.height - offsetTop))  =  500px
nav[aria-label="Primary"] rect:  top 447.0   bottom 500.0   height 53.0
gap between nav bottom and the visible edge   =  0.0px      (tolerance 20px)
document.scrollingElement.scrollTop           =  0
```

The nav's bottom edge is flush with the bottom of the visible region, and the document has not
scrolled — which is the specific thing that went wrong on the owner's phone (there, the browser
panned the window and the bar rode up off the bottom). Confirmed visually in
`04-c4-nav-after-shrink.png`: the five-item dock (Huddle / Board / Priorities / Schedule / Files)
sits flush at the bottom of the 390x500 frame with the message composer directly above it, no blank
strip beneath.

### C5 — degrade path

**C5a — runtime fallback — CONFIRMED.** With `--app-h` removed from `<html>` at runtime, forcing the
CSS to resolve `var(--app-h, 100dvh)` to its fallback:

```
getComputedStyle(shell).height  ->  844px   (rect 844)
documentElement.clientHeight    ->  844px
nav[aria-label="Primary"] present -> true
```

The shell keeps a sane, non-zero height equal to the layout viewport — i.e. `100dvh` resolving,
exactly the pre-fix behaviour. Screenshot: `05-c5a-fallback-runtime.png`.

**C5b — `visualViewport` undefined before load — NOT PROVEN (harness limit, not a product verdict).**
`page.context().addInitScript` redefined `window.visualViewport` to `undefined`, then the page was
reloaded. `window.visualViewport` was confirmed absent after the reload, so the init script took.
But the app came back **unauthenticated** — the `verify-uat.yml` UAT bypass token is single-use and
was spent on the first load, so the reload rendered the sign-in screen:

> "Huddle Chat, huddle, and run a team of AI agents SIGN IN Continue with Microsoft Secured by
> Microsoft Entra External ID. Auth trace: boo…"

No shell and no nav to measure, so the assertion is unproven by this route. The partial evidence
that *does* hold: the bundle **booted with `visualViewport` undefined without throwing**, and C5a
proves the CSS fallback itself resolves. Screenshot: `06-c5b-degrade-no-visualviewport.png`.

### C6 — console and network — **CONFIRMED**

Measured from the start of C1 to before the C5b reload (so a 401 from the spent single-use token
cannot be miscounted against the hook):

```
console errors:              0
failed / 4xx / 5xx requests: 0
```

The runner's own two independent listeners, which also cover the very first page load, likewise
reported `"No console/page errors during the run": pass` and
`"No failed/4xx/5xx requests during the run": pass`, with `failedRequests: []` in `results.json`.

---

## A defect found in the verification itself, not in the product

Run 34783668711's C4 was a **false pass**, and it is recorded here rather than quietly re-run.

```mermaid
flowchart TD
  A["C3 shrinks visual viewport to 500px via CDP"] --> B["C3 probes: --app-h 500px. Correct."]
  B --> C["C3 calls page.screenshot()"]
  C --> D["Playwright's screenshot CLEARS the CDP<br/>device-metrics override -> back to 844px"]
  D --> E["C4 probes: sees 844px"]
  E --> F["C4 reports 'gap below nav = 0.0px' as a PASS<br/>for a state that no longer existed"]
```

The check's name claimed "after shrink" while the number came from the un-shrunk page. It would have
read as strong evidence for exactly the claim most worth being sure about. Fixed in commit 3f85fb0:
the shrink is re-asserted through Playwright's own `page.setViewportSize` (which survives a
screenshot), and C4 now refuses to grade at all — reporting **NOT MEASURED** — unless the shrink is
still in effect at probe time. Run 34783820045 then measured C4 in the genuinely shrunk state
(visible height 500px, not 844px), and it passed on the real numbers.

Worth naming as a pattern rather than a one-off: this is the same shape as the `hueOf`/loading-state
guard in `widget-ui-checks.mjs` — **a check that cannot tell "measured and correct" from "measured
nothing" will report the confident answer**, and the confident answer is the dangerous one. C4 now
distinguishes them.

## Runs

| Run | What it was | Outcome |
|---|---|---|
| [34783668711](https://github.com/deventerpriseds-org/huddle-extension-app/actions/runs/34783668711) | first pass | C1, C2, C3, C5a, C6 confirmed; **C4 false pass** (state reverted); C5b not proven |
| [34783820045](https://github.com/deventerpriseds-org/huddle-extension-app/actions/runs/34783820045) | after the C4 guard (commit 3f85fb0) | C1, C2, C3, **C4**, C5a, C6 confirmed; C5b not proven, same harness limit |

Both runs report `conclusion: failure` — that is `run-uat.mjs` exiting non-zero because C5b is
recorded as a non-pass. The workflow conclusion is *not* the verdict; the per-claim table is.

## What would close the gaps

1. **C5b** needs a UAT token that survives one reload, or a second token minted for the reload — a
   harness change, not a product change. C5a already proves the CSS fallback resolves.
2. **The real keyboard shape** (layout viewport tall, visual viewport short) is not reachable from
   Chromium via CDP here — `Emulation.setVisibleSize` is an inert no-op. A real device, or
   BrowserStack on Samsung Internet, is the only route. Which is the same thing as the line below.

## Verdict

**CONFIRMED 5 (C1, C2, C3, C4, C6) · REFUTED 0 · NOT PROVEN 1 (C5b; C5a confirms the same fallback by another route) — MECHANISM ONLY: this is Chromium with a programmatic viewport resize, not Samsung Internet with a soft keyboard, and the owner opening the app on his own phone is the actual verdict.**

