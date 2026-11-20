# BUILD -- Trinnex workspace UAT fixes (2026-11-20)

WHAT:       fixes for the three defects the first live UAT of the Trinnex workspace found.
WHY:        verify-uat 44705323308 (1000x680, 9/10) and 44705328676 (390x844, 3/5) against main b930d488.
SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
EVIDENCE:   the two runs above; azure-pg-query shape counts (29 untriaged meetings, 1 owner address, all 29 titles date-time only).

## Observed -> fix
| # | Observed | Cause (read from code) | Fix | Test |
|---|---|---|---|---|
| 1 | Library: "0 waiting for triage"; Meetings: "29 to triage" | `firefliesWaiting(email)` matched the single signed-in address; Meetings filters `owner_email = ANY(callerOwners)` (meetings.server.ts scope) | `firefliesWaiting(owners[], pool)` uses the same linked-address set, lower-cased and de-duplicated; library.functions resolves it via `callerOwners` | `scripts/trinnex-library-count.test.ts` C1-C7, 7/7 |
| 2 | Meetings detail one word per line at 1000px with sidebar + context panel open | two-column split keyed on the SCREEN breakpoint `md:` (768px) while the page itself was ~400px wide | split keyed on the PAGE width with a Tailwind container query (`@container` + `@2xl:` = 42rem); below it the page behaves like the phone (list, then detail with Back) | build emits `@container (width>=42rem)` and `\@2xl\:flex-row/block/app-hidden/w-[320px]/border-r`; live UAT re-run |
| 3 | Phone UAT: Modules/Apps clicks timed out; Iris composer not found | desktop rail buttons exist but are hidden on phone; phone bar buttons have text, no aria-label, so `.first()` chose a hidden copy. Composer check ran while the Library view was showing | `clickVisible()` clicks the first VISIBLE match; items picked inside the popover/sheet dialog; Iris check switches to the Huddle view first and reports Iris reachability separately; rows carry `data-testid="meeting-row"` | live UAT re-run at both sizes |

## Commands
- `bun test scripts/trinnex-library-count.test.ts` -> 7 pass 0 fail.
- `bun test scripts/trinnex-*.test.ts scripts/verify-trinnex-*.test.ts` -> 218 pass, 1 fail (GUARD3). The same command on clean
  main b930d488 -> 211 pass, 1 fail (GUARD3); `bun test scripts/trinnex-redteam-fixes.test.ts` alone -> 19/19. Pre-existing
  cross-file interference, not this change.
- `npx tsc --noEmit -p .` -> 0 errors.  `npx vite build` -> rc 0.

## Mutation proof (scripts/mutate.sh)
- Defect reinstated: count only the FIRST address (`[set.slice(0, 1)]`, the old signed-in-only behaviour).
- Test: `C1 rows stored under a second linked address are counted (the UAT 0-vs-29 defect)`.
- Result: `FIRED (control EQUIVALENT)`, exit 0; the file was restored to HEAD.
- Note: a first attempt used `[set.slice(-1)]`. C1 stayed green because the last address is the one holding the meetings;
  only C7 caught it. That mutation was a poor choice, not a gap in the guard.

## Live UAT after deploy 44707603382 (main a28adce4)
| Run | Size | Product checks | Notes |
|---|---|---|---|
| 44707889765 | 1000x680 | 8/8 (Meetings opens, detail + "Who is speaking", no h-scroll; Library opens, Add material, Your library, no h-scroll) + no console errors + no 4xx/5xx | Library card reads "29 waiting for triage". The detail takes the full page with a "< Meetings" back link because the page is under 42rem with both panels open. Script error: "no visible Huddle view button" (rail label is "Huddles") |
| 44707895133 | 390x844 | 8/8 + composer visible + no console errors + no 4xx/5xx | Modules/Apps sheets now open. Iris not reachable without "Open navigation" -> script fixed on claude_trinnex-uat-script |

## Final live UAT (main e5e21ce5, app deploy 44707603382)
- 44708491612 at 1000x680: 12/12. 44708497787 at 390x844: 12/12. Iris check: "opened" on both; screenshots show the
  `@iris-chase` one-to-one composer. Read-only: no message, save, upload or removal was made.
