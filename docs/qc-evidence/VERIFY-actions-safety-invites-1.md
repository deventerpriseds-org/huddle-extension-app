# VERIFY: Actions safety check, invites, momentary chat, owner names, held items (loop 1)

<!--
WHAT:          Independent verification of PR #278 (branch claude_actions-held-names, head 07471f89) against
               docs/qc-evidence/AC-actions-safety-and-invites.md (X, F1..F5) and the claims in the BUILD / REDTEAM / FIX notes.
WHY:           Tier 1 change (admission guard + owner identity): an independent verifier is required after the PR.
SUPERSEDES:    nothing.  SUPERSEDED-BY: nothing -- current.
EVIDENCE:      suites and probes run in an isolated worktree at 07471f89, detached; synthetic data only; no model calls,
               no workflow dispatches. Probe scripts are in the verifier's scratchpad (not committed); their output is
               quoted here.
-->

Started 2026-11-18 02:21 UTC. Budget 40 min. Rows are appended as each claim lands.

## Claim 8. Suites, tsc, build (re-run by the verifier at 07471f89)

| Command | Observed |
|---|---|
| `bun scripts/actions-view.test.ts` | exit 0, `221 passed, 0 failed` |
| `bun scripts/actions-accuracy.test.ts` | exit 0, `91 passed, 0 failed` |
| `bun scripts/report-saves-verdicts.test.ts` | exit 0, `36 passed, 0 failed` |
| `bun scripts/actions-view-server.test.ts` | exit 0, `36 passed, 0 failed` (real local PostgreSQL started; not a SKIP) |
| `npx tsc --noEmit` | exit 0 |
| `npm run build` | exit 0 (`[nitro] You can preview this build`) |

Claim 8: **PASS**.

## Probe method

One offline probe script (synthetic data, imports the real modules at 07471f89, no model calls) run with `bun`:
87 checks, **85 PASS / 2 FAIL** (the 2 FAILs are the F3 finding below). One real-PostgreSQL probe: a scratch copy of
`scripts/actions-view-server.test.ts` with 6 extra checks appended after F5-S3, run against the same throwaway local
PG the suite starts; deleted after the run (the committed suite is untouched).

## Claim 1. F1 quote check -- PASS

Haystack H is the AC's (curly apostrophe, U+2026). Every row observed through `quoteIsVerbatim` / `admitActionVerdict`:

| Row | Observed |
|---|---|
| S1-1..S1-6, S1-13, S1-18, S1-21 (ZW in quote and in message), soft hyphen, S1-22 (curly double quotes) | ADMIT, as the table says |
| S1-7 (out of order), S1-8 (paraphrase), S1-9 (invented), S1-10/11 (trivial / repeats), S1-12 (mid-word), S1-14 `[...]` mid-sentence (tightened row), S1-15 (8 fragments), S1-16 (two Teams pieces), S1-17 (body + forward), S1-19 (owner text), S1-20 (café/cafés), S1-23 (`…`, `... ...`) | REJECT |
| F1-5 repeat with two occurrences / one occurrence | ADMIT / REJECT |
| a fragment after a gap that starts mid-sentence (`... week. your first notes by Monday.`) | REJECT |
| whole sentences skipped with `[...]` (`Hi Sam. [...] Please send ...`) | ADMIT |
| RT-1 `Please do ... send the contract` vs `Please do not send` ; `Please do. Send the contract.` vs `Please do. Do not send` | REJECT, REJECT |
| RT-2 NFD combining mark as boundary | REJECT |
| RT-3 NFC quote vs NFD message; reverse (NFD quote vs NFC message) | ADMIT, ADMIT |
| `admitActionVerdict` in-order fragments / out of order | `open` / `not_checked` + `quote_not_found` |
| F1-12 timing, 6 fragments on a 16k haystack | 0.173 ms per call (< 5 ms) |

Mutation m1 (verifier-run): the needStart / needEnd sentence-boundary checks in `fragmentsInOrder` replaced by
`false` -> `RT-1b GUARD` **FIRED (control EQUIVALENT), exit 0**.

## Claim 2. F2 invites -- PASS

- `COMMON` and `TEAMS_INSTRUCTIONS` both contain `MEETING_ASK_RULE`; `STEP2_INSTRUCTIONS` contains `STEP2_ATTENDING_RULE`
  and no longer contains "attending or preparing for something".
- `admitActionVerdict`: `meeting_invite` + kind `reply` -> `none`, `dropReason: meeting_invite_reply`;
  `meeting_invite` + `both` -> `open`, kind `action`, and `actionSectionFor` of it is not `needs_reply`;
  `meeting_invite` + `action` stays `action`; `person_request` + `both` stays `both` (unchanged elsewhere).
- `HIDEABLE_CATEGORIES` deep-equals the four existing categories (F2-10). Live-model behaviour (F2-7) not run (billed).

## Claim 7. R1-8 rewritten -- PASS

Suite line `R1-8 (F4) once an id is known, a sender with the owner's exact FULL name is the owner (his 2nd account);
a first-name namesake stays OTHER` passes. Probe: `ownNames ["Sam Okafor","Sam"]`, sender `Sam Rivera` -> OTHER; sender
`Sam` with `ownNames ["Sam"]` -> OTHER.

## Claim 3. F3 momentary backstop and its Teams wiring -- FAIL (the wiring works as written; "so it fails open" is false)

Admit-level, all observed: RT-7 (`Thanks!` inside `Thanks! Can you send me the signed contract by Friday?`) is not
dropped; a whole momentary message (`See you this afternoon!`) -> `none`; F3-6 prefix (`Running late, can you start
the review ...`) -> `open`; `I'll send you the deck tomorrow` -> `open`; S3-4 emoji, S3-9 `Running 5 minutes late` ->
momentary; S3-12 -> not momentary.

The Teams `latestMessages` wiring in `runClassify` (pipeline.ts), tested by the verifier through `runClassify` with an
injected model (one synthetic 1:1 chat each):

| # | Chat (OTHER messages, oldest first) | Model output | Observed verdict |
|---|---|---|---|
| W1 | Pat: `Can you send me the signed contract by Friday?` ; Pat: `See you this afternoon!` | to-do "Send the signed contract", quote `See you this afternoon!` | `none` / `momentary`, 0 proposals |
| W2 | Pat: `Can you send me the signed contract by Friday?` ; Pat: `Thanks!` | to-do "Send the signed contract", quote `Thanks!` | **`none` / `momentary`** |
| W3 | Pat: `Can you send me the signed contract by Friday?` ; Lee: `Thanks!` | same | **`none` / `momentary`** |
| W4 | Pat: `See you this afternoon!` ; Pat: `Can you send me the signed contract by Friday?` | quote `See you this afternoon!` | not `none` |

Mutation m5 (verifier-run): drop `latestMessages` from the `admitActionVerdict` call in `runClassify` -> W1
**FIRED (control EQUIVALENT), exit 0**. So the wiring is live and is what produces W1..W3.

**Finding F3-FAILS-CLOSED.** W2 / W3: the model names a real ask (to-do "Send the signed contract") but quotes the
trailing pleasantry. Before this change that verdict was HELD (quote under 8 chars) and visible; W1's quote was
admitted and listed. Now all three are `none`: the real ask is hidden outright, not even in the held group. The
condition "the sender's whole latest message is momentary" is checked per sender, so an earlier unanswered ask in the
same chat (same sender, W2; another sender, W3) does not stop the drop. This is the RT-7 failure (the backstop hides
a real ask) moved from one message to two. It contradicts the contract's F3 safe default ("its errors fail toward
showing an item, never hiding one") and claim 3's "so it fails open". No suite test covers it (RT-7c covers the
reverse order, W4).

## Claim 4. F4 "Names that are you" -- PASS

- `resolveActionsSettings({}, seed)` -> the seed; `{ ownNames: [] }` stored -> `[]` (kept); `ownerFullNames` with only
  `Sam` + login `sokafor@` -> `[]`. Bounds: 10 max, each <= 80, blanks dropped, case/space duplicates dropped.
- Saving `ownNames` through `resolveActionsSettings({...stored, ownNames})` keeps `hideCategories: ["timekeeping"]` and
  `knownHideCategories` (full list). The panel's `onBlur` sends `{ ...settings, ownNames }` (ActionsView.tsx), so the
  other fields travel with it.
- `ownerTeamsIdsAcross`: id-A known from 2 chats AND id-B named `Samuel Okafor` -> both ids; `[]` -> id-B not added.
  Spelling table S4-1..S4-16 all as the AC says (exact, case/space, `Last, First`, trim -> OWNER; one word, namesake,
  `-Diaz`, middle initial, `(External)`, no comma, accent-different, two commas, `isApp`, empty -> OTHER). NFD display
  name vs NFC list entry -> OWNER; trailing U+200B -> OWNER.
- All four callers pass `s.ownNames` into `assembleLedgerPlan` (actions.server.ts lines 173 heartbeat, 305 report pass,
  407 page read, 642 held action); `assembleLedgerPlan` has no other caller in `src/`. Suite `F4-9 GUARD (X-6)` and
  `F4-R GUARD` pass.
- UI: a "Names that are you" textarea in What shows, with `OWN_NAMES_NOTE` (read in source; not rendered in a browser).

Mutation m3 (verifier-run): re-wrap the name loop in `if (!ids.size)` -> `F4-1 GUARD` **FIRED (control EQUIVALENT), exit 0**.

## Claim 5. F5 held group and actions -- PASS (offline + real PG); UI not browser-run

Real local PostgreSQL, through the real `actOnHeldItemFor`, `getActionsPage`, proposal store and `actOnProposal`:

| # | Check | Observed |
|---|---|---|
| F5-S0..S3 | the suite's own held flow (listed in held only; double-click Dismiss -> ONE proposal; D5 gate; bad_shape refused) | PASS |
| V3 | another caller (`intruder@other.example`) acts on the owner's held item key | refused; 0 new proposal refs; stored id unchanged |
| V5 | the held action on an `open` verdict | refused; 0 new proposal refs |
| V1 | written-back proposal row DELETED (count 0 after delete), then Dismiss | `ok: true`; a proposal re-created (same deterministic id) and its id written back; state `dismissed`; verdict still `not_checked` |
| V2 | a second click with the kept proposal existing | 0 new proposal refs; id unchanged |
| V4 | page read after | the item is in none of `held`, `unchecked`, `rows` |

Mutation m6 (verifier-run): `proposalExists` SQL result replaced by `true` (always re-use) -> V1
**FIRED (control EQUIVALENT), exit 0**. So the deleted-id branch has now been exercised against real SQL.

D5 gate: the SQL in `proposalBacksActionsRow` adds exactly `status = 'not_checked' AND notCheckedReason =
'quote_not_found'`; a `bad_shape` verdict pointing at the proposal does not back it (suite F5-S2). Selection: suite F5-1,
F5-2, F5-10, RT-28/29/30 pass; `isHeldCandidate` items `continue` before the not-checked branch, so a held item cannot
also be in "Not checked yet". Held rows follow the source switches and the tab filter (ActionsView.tsx).

## Claim 6. X -- PASS

`CLASSIFIER_INPUT_VERSION` deep-equals `{ email: 3, teams: 4 }`. `runClassify` now applies `keepId` for every new status
(`if (keepId)`). Suite: X-2, X-5 GUARD, X-5b, RT-31, RK-1 GUARD, RK-2, XF-1 GUARD, XF-2 pass. Mutation m4 (verifier-run):
remove the `!LISTED_STATES.has(...) return true` line in `ownerDecided` -> `XF-1 GUARD` **FIRED (control EQUIVALENT),
exit 0**.

## Claim 9. Mutation proofs re-run by the verifier (`mutate.sh`, exit codes read)

| # | Guard | Test | Verdict | Exit |
|---|---|---|---|---|
| m1 | F1 sentence-gap rule | RT-1b GUARD | FIRED (control EQUIVALENT) | 0 |
| m2 | F3 fail-open rule (`momentaryDropApplies` -> `return true`) | RT-7c GUARD | FIRED (control EQUIVALENT) | 0 |
| m3 | F4 match when ids exist | F4-1 GUARD | FIRED (control EQUIVALENT) | 0 |
| m4 | F5 / X decided-proposal skip | XF-1 GUARD | FIRED (control EQUIVALENT) | 0 |
| m5 | F3 Teams wiring (verifier probe) | F3-W1 | FIRED (control EQUIVALENT) | 0 |
| m6 | F5 deleted-id check (verifier real-PG probe) | V1 | FIRED (control EQUIVALENT) | 0 |

Claim 9: **PASS**. Tree clean after every run.

## Not checked

- No browser run: the held group's look (F5-3 / F5-4), the "Names that are you" panel (F4-10) and the toasts were read
  in source only. These are UI claims owed a `verify-uat` run after landing.
- F2-7 (live model eval) and F2 spelling rows S2-*: billed model calls, out of scope.
- X-7 / F5-13 logging: the new `console.` lines read in the diff log only action, source, ok, and an error name.

## Verdict

UI claims (F5-3, F5-4, F4-10) remain NOT YET UAT-VERIFIED (owed a browser run after landing).

FIX FIRST: F3-FAILS-CLOSED (claim 3) -- in a Teams chat, a real ask followed by a pleasantry that is the sender's (or another sender's) whole latest message is hidden outright (`none`) when the model quotes the pleasantry (W2, W3; before this change it was held or listed); add W2 / W3 as regression tests with the fix.
