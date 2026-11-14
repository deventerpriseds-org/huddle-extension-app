<!--
WHAT:          Independent verification (loop 6) of claude_task-proposals @ d849f0da: full re-derivation of the
               loop-5 REFUTED items (6.4 / F1-F3 class via parse5 html-visible.ts, claim 16 U1/U4, X3-X6) plus a
               reduced-depth re-check of everything loop 5 confirmed, and the flags-OFF live-change table.
WHY:           Tier 1 (model output stored as proposals; live work-email screen + main-mailbox newTextOnly touched).
SUPERSEDES:    docs/qc-evidence/VERIFY-correspondence-proposals-5.md (origin/claude_verify-correspondence-proposals-5 @ b4e76df7)
SUPERSEDED-BY: nothing -- current
EVIDENCE:      this file; probe scripts scripts/verify3-5-*.ts (earlier loops) and scripts/verify6-*.ts (this loop)
-->

# VERIFY correspondence-proposals, loop 6

Started 2026-11-14 02:16 UTC, budget 2.5 h (ends 04:46 UTC). Isolated worktree, branch
`claude_verify-correspondence-proposals-6` started from the target **d849f0da** (`git diff d849f0da HEAD -- src` is empty;
the only additions are this file, loop 5's report and the loop 3-5 probe scripts copied from b4e76df7).
origin/main at start: 90e84d1c (the target is 6 commits behind main, 83 ahead). No live system touched; synthetic
`.example` data only.

**Restart note (02:17 UTC):** the stub above came from a stopped earlier start; this run continues the same branch
(fetched 1469ff19) and keeps the budget end at 04:46 UTC. `node_modules` is a symlink to the main checkout's tree
(parse5 7.3.0 present there; ignored by git).

## Claim 0: full suite re-run at d849f0da

| suite | implementer | observed |
|---|---|---|
| task-proposals | 204/0 | 204 passed, 0 failed |
| redteam-correspondence | 76/0 | 76/0 |
| inbound-email | 72/0 | 72/0 |
| correspondence-ingest | 149/0 | 149/0 |
| cross-app-turn-gate | 92/0 | 92/0 |
| feed-staleness | 96/0 | 96/0 |
| proposals-preview | 6/0 | 6/0 |
| onedrive-feed-truth | 11/0 | 11/0 |
| html-visible-loop5 | 9/0 | 9/0 |
| onedrive-feed / attention / attention-focus / confirm-ask-context | -- | 61 PASS lines "all passed" / all passed / all passed / 21/21 |
| feed-staleness-sql (local PG 16) | 23/0 | 23/0 |
| task-proposals-sql | 45/0 | 45/0 |
| correspondence-ledger-sql | 50/0 | 50/0 |
| fireflies-queue-sql | -- | all passed |
| fireflies-minutes | -- | 3 FAIL (G3, G5, G8) -- **identical on origin/main 90e84d1c** (run from a `git archive` of main); pre-existing |
| `tsc --noEmit` | -- | exit 0, no output |

Every implementer count reproduces exactly.

---

## RETARGET (02:40 UTC) -- target is now ddc7b55d (= d849f0da + 1 commit)

Coordinator update: verify at **ddc7b55d**. Merged into this branch (e130d663); `git diff ddc7b55d HEAD -- src
scripts/redteam-correspondence.test.ts` is empty. The one commit (owner 2026-11-14, "Iris's current email alerts are
already good"): `newTextOnly` no longer joins a two-line attribution; `isWrappedAttribution` is exported and tested
directly through a `wrapDetected` helper.

### Claim 0 re-run at ddc7b55d

All in-memory suites as above, except **redteam-correspondence 77/0** (was 76). The others are unchanged:
task-proposals 204, inbound-email 72, ingest 149, cross-app 92, feed-staleness 96, preview 6, truth 11,
html-visible-loop5 9, confirm-ask 21/21, onedrive-feed / attention / attention-focus all passed. SQL suites: 23/0, 45/0, 50/0.
`tsc --noEmit` exit 0.

### Claim (a): `newTextOnly` matches main on every wrapped-attribution shape -- CONFIRMED

- Literal sweep (`scripts/verify5-literal-sweep.ts` over the inbound-email, redteam, ingest and task-proposals suites):
  **1502 literals, 13 differ**. All 13 are the owner-approved non-English quoted history: 7 one-line foreign
  attributions (fr/de/es/it/nl/pt/sv) and 6 foreign header blocks. The 6 two-line wrapped rows that differed in loop 5
  now produce **identical output to main**.
- `scripts/verify6-wrapped-probes.ts`: 22 wrapped shapes x (branch vs main). **live == main on 22/22**. The shapes:
  Gmail with email / name-only / 24 h / name split across the wrap; Apple Mail with email / name / iPhone 24 h;
  Outlook-mobile with an offset; Thunderbird numeric; no-year and no-time stamps; X3-X6; three new English sentences;
  lowercase-name; `I`; no date.
- The detector, which no live path calls any more, cuts real stamps and keeps X3-X6. **Residues, non-blocking**:
  - `On May 3 at 9:30 the 2024 board met and Legal` / `wrote:`, `On Sat 4 at 10:15 for the 2025 audit our CFO` /
    `wrote:` and `On Mar 9 the 2025 deadline moved to 17:00 and Finance` / `wrote:` are still detected, because the
    year AND clock are present, `May/Sat/Mar` are month or day names, and a capitalised word comes before `wrote:`.
  - Thunderbird's `On 11/10/25 9:14 AM, Dana Kim` / `wrote:` is not detected, because there is no month or day name.
    This is the keep direction.
- **Observation**: `isWrappedAttribution` has **no caller in `src/`** (grep: its only callers are the definition and
  `scripts/redteam-correspondence.test.ts`). The comment at `inbound-email.ts:150` says it is "kept for the
  correspondence report's own thread logic", and no such caller exists. It is dead code at ddc7b55d: harmless, but
  the comment is inaccurate.

### Claim (b): the rewritten tests are not weakened -- CONFIRMED

Diff read: one assertion was removed, the `en-2line` row in the "still cut" list. Every other change:
- turns a live-screen "cut" expectation into a detector expectation (`wrapDetected`), or
- adds the opposite live-screen expectation, RT-12c `[true, true]` and the new "live screen keeps ... exactly as main"
  test over all 5 `wrappedCuts`.

The live expectation flipped because of the owner's decision. It was not loosened: it is now asserted in the other
direction.

Mutation proofs (`mutate.sh`, anchors/replacements in files, `inbound-email.ts`):

| mutation | named test | verdict | exit |
|---|---|---|---|
| reinstate the live join (`if (i + 1 < lines.length && isWrappedAttribution(l, lines[i + 1])) break;`) | D2 owner 2026-11-14: ...and the live screen keeps | FIRED (control EQUIVALENT) | 0 |
| drop the year AND clock rule (`if (false && !(YEAR...CLOCK...))`) | D2 X1-X6 hard-wrapped English lines | FIRED (control EQUIVALENT) | 0 |
| drop the email shortcut (`if (false && EMAIL.test(joined))`) | D2 real two-line wrapped attributions are still DETECTED | FIRED (control EQUIVALENT) | 0 |

**Finding, non-blocking, test infrastructure:** `scripts/redteam-correspondence.test.ts` never sets a non-zero exit
code. It ends with `console.log(... passed, ... failed)` and has no `process.exit(1)`, unlike inbound-email,
task-proposals, feed-staleness, truth and html-visible-loop5, which all have `if (fail) process.exit(1)`. mutate.sh
reported "the suite exited 0" while an assertion was failing. Any check that reads only the exit code would pass a
red redteam suite. The file was written as a findings probe, where a FAIL line is a finding. It is now used as a
regression suite (the claimed 77/0), so it needs the same exit line.
(Process note: my first three mutate runs used the pattern `FAIL` instead of a test name and reported INERT. They
were invalid, and I re-ran them with the test names above.)
