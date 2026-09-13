# D-5 — Priorities vs the spec, region by region

<!--
WHAT:       The divergence list between journey's PRIORITIES widget (the owner's spec screenshot) and
            what Huddle renders, produced by opening the JPEG and reading the component source in the
            same session.
WHY:        The owner's first complaint was "the priorities is not a direct port of the view in
            journey" and it was the one item nobody answered. The fix pass deliberately skipped it
            rather than reconstruct a list from the brief -- correctly, since a list assembled from
            comments about the spec is a proxy, not the spec. This closes it from the primary source.
SUPERSEDES: nothing
SUPERSEDED-BY: nothing -- current
EVIDENCE:   docs/widgets/spec-priorities-widget.jpg (re-opened 2026-09-13) and
            src/features/huddle/components/JourneyWidgets.tsx at 1a2a89c.
-->

**Method.** The JPEG was opened and the component read in the same session — no recall, no
reconstruction from comments. **Limit, stated up front: this compares STRUCTURE, not appearance.**
Source cannot tell you what something looks like. Anything below marked *appearance* is settled only
by the owner looking at it, or by the 390px browser run once the widget actually loads data.

## Region by region

| # | Region | Spec draws | Huddle renders | Verdict |
|---|---|---|---|---|
| 1 | Header | "Priorities" bold left, gear right | same, `title \|\| "Priorities"` + `Settings` icon | **MATCH** |
| 2 | Compose pill | "Add a priority…", then **mic · purple send · mic** — TWO mics | one mic + send | **ADAPTED** — deliberate, documented in-file: the two mics are the same affordance (system voice input beside the app's own) and duplicate chrome is what a narrow column cannot spare |
| 3 | Band background | cream / pale yellow | `--band-cream`, hue 92 | **MATCH as of `9a3629b`** — was pink before |
| 4 | Band row order | title · category chip · Today button | identical order | **MATCH** |
| 5 | Today ON | filled green, "✓ Today" — icon **and** the word | `--success` bg, `Check` icon, then the literal `Today` | **MATCH** |
| 6 | Today OFF | pale grey, "▲ Today" | `--muted` bg, filled `Triangle`, then `Today` | **MATCH** |
| 7 | Band clipping | band is clipped mid-row at the top — it SCROLLS, it is not a fixed five | `ScrollBand` | **MATCH** |
| 8 | Topic spine | coloured vertical bar, top-level rows only | `w-[3px]` bar at `depth === 0` only | **MATCH** |
| 9 | Spine colours | Career green · Ventures purple · Education orange · Life blue · Family grey | seeded hues 149 / 303 / 70 / 250 + chroma 0 for Family | **MATCH as of `ec46286`** — were magenta/teal, effectively swapped |
| 10 | Counts | right-aligned; **blank**, never "0", where absent (Family, Grooming Management, Vendor Communication, Team Collaboration Tools) | `{node.count ? … : null}` | **MATCH** |
| 11 | Child indent | one step per level | `depth * 0.875rem + 0.75rem` | **MATCH** |
| 12 | Disclosure glyph | **solid triangles** ▼ expanded / ► collapsed | lucide `ChevronDown` / `ChevronRight` — thin stroked chevrons ⌄ › | **DIVERGES** |

## The one real structural divergence

**#12 — the disclosure marks are chevrons, not triangles.** The spec uses the same filled-triangle
family as the ▲ on the Today button, so within the spec the two marks visibly rhyme; in Huddle the
Today button uses a filled `Triangle` while the tree uses stroked chevrons, so they do not. It is
small, and it is exactly the class of thing that adds up to "not a direct port".

`Triangle` is already imported in this file, and a rotated filled triangle is the same mark — so this
is a low-risk change, not a redesign.

## What this document does NOT settle

Everything about **appearance**: type scale, row height, chip and button weight, the cream's exact
lightness, spacing rhythm, how the band reads against the tree. Twelve structural MATCHes do not add
up to "looks like the spec", and saying otherwise would repeat the mistake that shipped four visual
defects under 67 green assertions.

Two things would settle it, in order:
1. The owner opening it at phone width — every defect so far came from exactly that.
2. The 390px browser run (`verify-uat.yml` + `widget-ui-checks.mjs`), **once the widget loads data** —
   in the 2026-09-13 run against production the view sat on "Loading your priorities…", so the band
   and layout checks measured nothing. Whether that is the UAT identity having no tasks or a real
   load failure on the live build is **not established**.
