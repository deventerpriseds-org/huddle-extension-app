# BUILD (part A): quote fragments (F1), invites with an ask (F2), chat logistics (F3), cross-cutting X

<!--
WHAT:          Build log for part A of docs/qc-evidence/AC-actions-safety-and-invites.md: sections X, F1, F2, F3.
               F4 and F5 are built in parallel by builder B and are NOT touched here.
WHY:           Owner-approved Tier 1 change (AC header). This file records what was built, which X items part A owns,
               the mutation-proof table, and anything NOT DONE.
SUPERSEDES:    nothing.
SUPERSEDED-BY: nothing -- current.
EVIDENCE:      scripts/actions-view.test.ts, scripts/actions-accuracy.test.ts, scripts/report-saves-verdicts.test.ts;
               mutation runs via mutate.sh (table below).
-->

THIS REPO IS PUBLIC: every fixture added for this work is synthetic.

Base: `claude_actions-safety-invites` @ abd50703. Baseline suites before any edit (measured):
actions-view 144/0, actions-accuracy 60/0, report-saves-verdicts 31/0.

## X items implemented by part A

| X | What part A did | Where |
|---|---|---|
| X-1 | `CLASSIFIER_INPUT_VERSION = { email: 3, teams: 4 }`, plus one comment bullet naming F1/F2/F3 (and F4 for Teams). Mutation-proved. | action-classify.ts; test `AI-14 / X-1` (actions-view), `R7-7` updated (actions-accuracy) |
| X-2 | An email verdict at version 2 and a Teams verdict at 3 are each judged again through `runReportClassify`/`runClassify` (2 calls, counted) and stored at 3 / 4. Mutation-proved (a "one version of slack" defect in `verdictIsCurrent`). | test `X-2 GUARD` (report-saves-verdicts) |
| X-3 (RK-1) | Kept. The RK-1 mutation was re-run on the new `keepId` line: FIRED (control EQUIVALENT). | `RK-1 GUARD` |
| X-4 (RK-2) | Kept, green. | `RK-2` |
| X-5 | `runClassify`'s `finish` now keeps the prior `proposalId` for the SAME item key whatever the new status (`open`, `none`, `not_checked`). It used to be applied to `open` only. No 2nd proposal. Mutation-proved. | pipeline.ts (one condition); tests `X-5 GUARD`, `X-5b` (report-saves-verdicts) |
| X-6 | Quote-rule half only: there is ONE admission call site (`pipeline.ts` `admitActionVerdict`, used by the heartbeat and `runReportClassify`) and ONE verbatim function (`quoteIsVerbatim`, also used by the legacy `judgeConversation` and `scripts/action-scan-steps.ts`). Checked by grep and test `F1-11`. The owner-name resolver half is F4 (builder B). | -- |
| X-7 | The diff adds no `console.`/logger call (grep of `git diff abd50703 HEAD -- src` = 0). The F2/F3 drops store a fixed code reason (`DROP_REASON_TEXT`), never model text. | -- |
| X-8 | Fixtures added here use only synthetic text ("Sam", "Pat Example", made-up ids, `example` addresses). | test diffs |

**Coordination note for builder B (F5):** after X-5, a stored `not_checked` verdict can now carry a `proposalId`
(the prior proposal of the same item key). `selectActionItems` today lists every `not_checked` candidate in
`unchecked` (row id = that proposal id). The F5 rule "an item with a decided rescue proposal is in none of held /
unchecked / rows" (F5-5/F5-6) belongs in the selection, which B owns; part A did not touch `selectActionItems`.

## What was built

**F1** (`action-classify.ts`): `canonQuote` also removes U+200B..U+200D and U+00AD. `quoteIsVerbatim` first tries the
whole quote exactly as before (after stripping ONE wrapping quote mark, S1-22). Only if that fails does it split the
folded quote at sentence ends and ellipses (`quoteFragments`, never at commas). It then admits when there are 1 to 6
fragments, at least one of them 8 or more characters, all found in order inside ONE haystack piece, each on Unicode
letter/digit boundaries (`fragmentsInOrder`, using indexOf; no RegExp is built from quote text). A single fragment is
allowed so that a quote cut with a trailing "..." is admitted (S1-x1). The fragment path cannot admit anything the
whole-quote path refused under the old rule, except fragment-shaped quotes, so F1-6 holds (every existing suite
stayed green).

**F2**: `MEETING_ASK_RULE` is one exported constant inside the `meeting_invite` definition of COMMON (and so of steps 2
and 3) and of TEAMS_INSTRUCTIONS. In step 2, "attending or preparing for something" is replaced by
`STEP2_ATTENDING_RULE` ("preparing a SPECIFIC thing ... (attending a meeting is not an open item by itself)"). F2-6:
`admitActionVerdict` turns `meeting_invite` + kind `reply` into `none` with `dropReason: "meeting_invite_reply"`. Kind
`action` and `both` keep today's path. This is placed in admission, as the AC's safe default says, not in
`selectActionItems`, so B's selection edits are not touched.

**F3**: `MOMENTARY_RULE` is one constant appended to COMMON and TEAMS_INSTRUCTIONS. The step-2 and Teams "promised in his
own messages" wording now reads "promised to deliver or do". The backstop is `MOMENTARY_PHRASES` (26 folded entries)
plus ONE anchored pattern (`running N min(s|utes) late`), applied in `isMomentaryQuote`. The quote is folded, emoji
are removed, and it is split at punctuation. EVERY part must be an exact entry; a non-empty, emoji-only quote counts.
On a match, the verdict is `none` with `dropReason: "momentary"` and the fixed reason text. It is fail-open: any
extra word means no match.

Judgement call (reversible): the F3 and F2-6 drops run BEFORE the verbatim-quote check. So a momentary "Thanks!" (7
characters, under the floor) becomes `none` rather than being held as "not checked" (S3-8 expects NONE). Consequence:
spelling row S1-11 (`Thanks. Thanks.`) now reads `none` at admission. The quote rule alone still refuses it, as pinned
by F1-5's `quoteIsVerbatim` check.

AC discrepancy recorded, not "fixed": as written, S1-20 (`Café notes are due Friday` against `Cafés notes are due
Friday`) is NOT a contiguous span either, because of the "s", so the whole-quote path refuses it too and the AC's
"whole-quote path: ADMIT" cannot hold. The Unicode-boundary behaviour is pinned by an added row S1-20b, where only the
boundary (`café` inside `cafés`) separates admit from refuse.

## Mutation table (`mutate.sh`, every FIRED controlled; anchors in the scratchpad `sinv-A/`)

| Guard | Defect reinstated | Test named | Exit | Verdict |
|---|---|---|---|---|
| X-1 | version back to `{ email: 2, teams: 3 }` | `AI-14 / X-1` | 0 | FIRED (control EQUIVALENT) |
| X-2 | `verdictIsCurrent` accepts one version back (`>= V - 1`) | `X-2 GUARD` | 0 | FIRED (control EQUIVALENT) |
| X-3 (RK-1 re-run) | `keepId` never applied (`false && keepId`) | `RK-1 GUARD` | 0 | FIRED (control EQUIVALENT) |
| X-5 | `keepId` applied to `open` only (the old rule) | `X-5 GUARD` | 0 | FIRED (control EQUIVALENT) |
| F1-1 | whole-quote only (fragment path returns false) | `F1-1 GUARD` | 0 | FIRED (control EQUIVALENT) |
| F1-2 | order dropped (`from = 0`) | `F1-2 GUARD` | 0 | FIRED (control EQUIVALENT) |
| F1-3 | pieces joined into one string | `F1-3 GUARD` | 0 | FIRED (control EQUIVALENT) |
| F1-5 | overlapping / reused match (`from = at`) | `F1-5 GUARD` | 0 | FIRED (control EQUIVALENT) |
| F2-1 | carve-out deleted from the Teams definition | `F2-1 GUARD` | 0 | FIRED (control EQUIVALENT) |
| F2-2 | step 2 back to "attending or preparing for something" | `F2-2 GUARD` | 0 | FIRED (control EQUIVALENT) |
| F2-6 | meeting_invite + reply check removed | `F2-6 GUARD` | 0 | FIRED (control EQUIVALENT) |
| F3-1 | `MOMENTARY_RULE` removed from Teams | `F3-1 GUARD` | 0 | FIRED (control EQUIVALENT) |
| F3-2 | backstop removed | `F3-2 GUARD` | 0 | FIRED (control EQUIVALENT) |
| F3-3 | substring matcher (`MOMENTARY_PHRASES.some(p => s.includes(p))`) | `F3-3 GUARD` | 0 | FIRED (control EQUIVALENT) |
| F3-6 | exact match turned into "any part matches" (`some`) | `F3-6 GUARD` | 0 | FIRED (control EQUIVALENT) |

The first run of the batch passed `FAIL <name>` as the pattern and returned exit 4 (UNDETERMINED) for every row, because
mutate.sh adds the marker itself. Nothing was banked from that run. It was re-run with the bare test names (table
above).

## Final suite results (measured on the final tree)

- `bun scripts/actions-view.test.ts`: 176 passed, 0 failed
- `bun scripts/actions-accuracy.test.ts`: 60 passed, 0 failed
- `bun scripts/report-saves-verdicts.test.ts`: 34 passed, 0 failed
- `bun scripts/actions-view-server.test.ts` (own local Postgres): 32 passed, 0 failed
- `npx tsc --noEmit`: exit 0
- `npm run build`: exit 0 (nitro build complete; src unchanged since that build)

## NOT DONE (part A scope)

- F2-7 / F2-8 / S2-* live-model behaviour: an opt-in billed eval, excluded by this pass's rules (no model calls). Only the
  instruction text and the code rule are pinned.
- F3-10 (cap counting for a dropped verdict): not separately tested. The backstop runs inside admission after the
  ONE recorded call, and adds no call; X-2's call counting covers the path.
- F1-10: proven at the `canonQuote` level (different fragment quotes fold to different keys). No new case was added to the
  `collapseDuplicateTeamsItems` suite itself.
- The red-team pre-pass and the independent verifier (Tier 1) are the session owner's next steps, not part of this build.

## Log

- e387c4d4 X-1/X-2 version bump + tests.
- 82cd547d F1 fragments rule + tests (F1-1..F1-12, S1-1..S1-23).
- 4b0e2105 F2 + F3 prompt constants, F2-6 and the momentary backstop, tests.
- c5fd3195 X-5 keepId for every status + tests.
- F3-3 test widened (a deliverable ask opening with "Thanks!") so a substring-matcher mutation can fire.
- No git command or hook asked for permission during this build.

