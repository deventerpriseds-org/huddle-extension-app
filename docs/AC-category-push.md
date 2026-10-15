<!--
WHAT:          adversarial acceptance criteria for "push a task / push a category into This Week"
               (priorities widget), written BEFORE implementation by an independent AC subagent.
WHY:           Tier-1-adjacent: the feature writes journey's star (is_priority/priority_rank), which is
               the ONLY input journey's nightly-schedule-builder uses to put work on the calendar, and
               it changes what Monday's groom is allowed to un-star.
SUPERSEDES:    nothing
SUPERSEDED-BY: nothing -- current
EVIDENCE:      sources read are listed in "Sources read" below (written incrementally).
-->

# Acceptance Criteria — Push task / push category into This Week

Status: IN PROGRESS (written incrementally by the AC subagent)

## Live baseline (supplied by coordinator, measured 2026-10-15)

Source: Huddle mirror `tasks.journey_tasks`, owner dev@enterpriseds.io, non-DONE tasks, via
`azure-pg-query.yml` run 38787342521 (NOT re-measured by this subagent — cited as given).

| bucket | count | meaning for this feature |
|---|---|---|
| is_priority=false | 70 | all rank NULL |
| is_priority=true, rank 1..20 | 26 | **26 > PRIORITY_LANE_MAX=20 with ranks only 1..20 means ranks are DUPLICATED** — consistent with category-scoped grooms (`groom_backlog {category}` ranks 1..N inside one category's slice), so "rank" is NOT a global order today |
| is_priority=true, rank > 20 | 7 | leftovers from the pre-cap 80-rank groom; the capped groom has NOT cleared them (it only unsets ids inside its own `slice` — see groom.ts:168-175, 304-310) |
| is_priority=true, rank NULL | 0 | no phone stars exist right now |
| rank 0 | 0 | journey-web 0..N-1 lane rewrite not in use |
| `tasks.week_order` rows | 0 | owner has never reordered; groom's `userPinned` is currently EMPTY |

Consequence for the bootstrap ACs: on the first groom after deploy there is NO record of which of the
33 current stars the groom created; all 33 have a non-null rank, which is the only fingerprint the
current data offers (phone stars are rank-NULL). See OQ-5 and AC-G*.

