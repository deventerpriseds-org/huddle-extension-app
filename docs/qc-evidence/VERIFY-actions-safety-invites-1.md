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
