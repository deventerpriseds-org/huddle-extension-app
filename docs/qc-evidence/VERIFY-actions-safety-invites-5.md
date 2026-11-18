# VERIFY actions-safety-invites -- loop 5

WHAT:          Independent verification, loop 5, of PR #278 (`claude_actions-held-names`) at head 80a76e3f.
WHY:           Loop 4 returned FIX FIRST on F4-F3-9 (AC F3-9 said "one rule for both sources", but the code
               backstop is Teams-only, and its test went down a default path no production caller uses).
               Fixed in 8eaae741; origin/main merged in 80a76e3f.
SUPERSEDES:    docs/qc-evidence/VERIFY-actions-safety-invites-4.md (its one finding is re-derived here).
SUPERSEDED-BY: nothing -- current.
EVIDENCE:      this file. Synthetic data only, model stubbed by the suites, no billed calls, no workflow dispatches.

Checked out DETACHED at 80a76e3f in an isolated worktree.

## F4-F3-9 -- full re-derivation

### The fix (8eaae741): 2 files, +5/-3
- `docs/qc-evidence/AC-actions-safety-and-invites.md` row F3-9 is AMENDED (dated 2026-11-18): the code backstop is
  Teams-only for email, and MOMENTARY_RULE in the instructions still applies. **AC text matches code:** at
  `pipeline.ts:228`, `latestMessages = u.email ? [] : u.teams!.messages.map(...)`, and
  `momentaryDropApplies` (`action-classify.ts:483`) has `if (!msgs.length) return false`.
  Email is never dropped by code.
- The `scripts/actions-view.test.ts` F3-9 test now passes `latestMessages: []` and expects `["open", null]`.
  Output: `PASS F3-9 (amended) email gets no code backstop: what runClassify passes ([]) never drops an email pleasantry`.

### Does the test exercise the real pipeline input?
- `admitActionVerdict(` has exactly ONE production caller: `pipeline.ts:229`. It always passes the array built on
  line 228, `[]` for email. The test passes that same value, so the input is right. It does not, however, DERIVE
  that value from the pipeline.
- Mutation (scripts/mutate.sh). Anchor `const latestMessages: string[] = u.email ? [] :` was replaced with
  `u.email ? (undefined as unknown as string[]) :`, which puts the email backstop back into the real pipeline.
  - vs `bun scripts/report-saves-verdicts.test.ts`, marker `F3E-3`: **FIRED (control EQUIVALENT), exit 0.** The
    runClassify-driven email tests guard the shipped path.
  - vs `bun scripts/actions-view.test.ts`, marker `F3-9`: **INERT** (suite still 0 failures). The F3-9 unit test
    alone does not notice the pipeline regressing, because it copies the pipeline's input instead of going through
    it. The guard for the end-to-end link is F3E-1/2/3, which DO go through runClassify.
- Verdict: **PASS.** The AC and code agree, the test uses the input the pipeline really sends, and the pipeline path
  is mutation-proved by F3E-3. Note: the F3-9 test on its own is a unit check, not the pipeline guard.

### Owner-visible note (not a code defect)
The amendment NARROWS a safety backstop. A pleasantry-only email that the model wrongly flags now shows as an open
item instead of being dropped. That fails safe (it shows an item, never hides one). Loop 4 said the AC change needs
the owner's sign-off. This loop found no record of that sign-off in the AC row (it cites the verifier loops, not
the owner). Under the repo's own rule, the parent should surface it.

### Nit (Tier 3)
In the `pipeline.ts:220-223` comment, the backstop is still described as given every message "email and Teams".
Lines 224-226 of the same comment correct that to Teams-only. The first half is stale.

## Merge 80a76e3f (origin/main, PR #279)
- `git merge-tree --write-tree 8eaae741 22e7be74` gives `fa10e064...`, identical to `HEAD^{tree}`. **Clean, no
  conflict, and no hand edits in the merge.**
- Diff vs first parent: `scripts/calendar-ignore.test.mjs` (+16) and
  `src/features/huddle/lib/email/graph-email.server.ts` (+10/-1). The latter only filters the return value of
  `getGraphCalendarEvents` and adds `IGNORED_CALENDAR_TITLES` / `isIgnoredCalendarTitle`. No file under
  `lib/actions/` or `lib/correspondence/` calls `getGraphCalendarEvents` (callers: schedule-brief,
  calendar/tools). **Nothing on the Actions paths changed.**
- `node --test scripts/calendar-ignore.test.mjs`: 1 pass, 0 fail.

## Reduced-depth re-check (F1, F2, F4, F5, X, R1-8, F3 Teams/email rows, F3E, F3V)

| suite | expected | observed |
|---|---|---|
| `bun scripts/actions-view.test.ts` | 221/0 | **221 passed, 0 failed** |
| `bun scripts/actions-accuracy.test.ts` | 96/0 | **96 passed, 0 failed** |
| `bun scripts/report-saves-verdicts.test.ts` | 39/0 | **39 passed, 0 failed** |
| `bun scripts/actions-view-server.test.ts` | 36/0 | **36 passed, 0 failed** |
| `node --test scripts/calendar-ignore.test.mjs` | pass | **1 pass, 0 fail** |
| `npx tsc --noEmit` | 0 | **exit 0** |
| `npm run build` | 0 | **exit 0** (nitro build output generated) |

Loop-4 probe re-run: **NOT REACHED.** The probe was never committed (loop 4 says "untracked, not committed") and is
not on disk in this container. For the email rows, the pipeline mutation above (F3E-3 FIRED) stands in: it is the
stronger check. The Teams rows are covered by the F3V-1..5 / F3 rows in the suites, all green.

## Verdict
SHIP
