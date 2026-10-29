# Fix pass, routing: D12 (other lanes' asks that name a course or a professor were taken as coursework)

<!--
WHAT:          Fix log for D12 of docs/VERIFY-nexus-write-tool-3.md: the owner's decision (2026-10-29) to do
               BOTH (A) an additive LLM-router hint that Elle and Iris are the preferred owners of adding/updating
               his Nexus coursework assignments, and (B) keep the deterministic prime rule but extend its VETO
               DATA so it stops taking other agents' asks. Per change: the data, the measured before/after on the
               verifier's own D12 probes, the tests, and the mutate.sh verdicts.
WHY:           The verifier measured 13 deterministic lane steals (VERIFY-nexus-write-tool-3.md C4/C9, D12):
               email / dinner / budget / car rental / lodging / calendar / reminder / running asks that name one of
               his REAL courses (or "my professor" on the cold-cache path) plus "due/paper/exam" were handed to
               Elle/Iris with a follow-up DM, and the group leader moved off Finn/Cam/Charleston/Ezra.
SUPERSEDES:    nothing. RESPONDS TO docs/VERIFY-nexus-write-tool-3.md D12 (and F2-45 NOT MET). Builds on
               docs/FIX-nexus-write-loop3.md (D6: vetoes first; course list = data), which is unchanged in design.
SUPERSEDED-BY: nothing -- current.
EVIDENCE:      branch fix/routing-prime (worktree) from origin/claude_nexus-write-tool-fixed + origin/main merged,
               pushed to claude_nexus-write-tool-fixed (PR #114). scripts/nexus-write-routing.test.ts;
               `bash scripts/run-nexus-fix-suites.sh`; probes mut-verify-114-3/probe-routing*.ts run on this tree and
               on a `git archive origin/main` export; mutation anchors/replacements in mut-routing-prime/.
               Offline only: fetch mocked, no live Nexus/Huddle/OpenAI, no DB or board writes.
-->

Written as the work goes. Status words: **fixed** = the verifier's input is now a passing test and the guard is
mutation-proved; **not fixed** = with the reason.

## Baseline

Merged `origin/main` (9afd68e) into `origin/claude_nexus-write-tool-fixed`: no conflicts, every suite green before
any change. `git archive origin/main src scripts` (9afd68e) was extracted to the scratchpad with this tree's
node_modules. The verifier's probes run on that export reproduce its recorded `probe-routing.main.out` and
`probe-routing-weak.main.out` byte for byte, so this baseline is the verifier's baseline.

Before pushing, origin/main had moved to ee8f7b6 (#126, UAT bypass token checked server-side: deploy-swa.yml,
package.json script line, src/lib/entra-auth.ts + uat-bypass*, its test and doc; no routing, agents or capability
file). Merged it too, clean; the suites, tsc and its own `scripts/uat-check-server-side.test.ts` (32 passed, 0
failed) are green on the merge, so the 9afd68e routing baseline still holds.

## (B) D12: veto DATA extended (agents.ts only; no code change, no agent name)

**Status: fixed** for every D12 ask the verifier listed, plus 15 extra asks (at least one per veto group).

The `nexus-assignments` capability (agents.ts) keeps its loop-3 design: vetoes are checked first and they win;
strong context is the owner's real course list; weak context is professor/instructor/"my assignment"/deliverable +
deadline cue. Only its `vetoes` / `vetoPatterns` DATA grew, one group per lane the owner named:

| Group | Words (whole word, plural `s` tolerated) | Patterns (phrase-level, used where a bare word would also veto coursework) |
|---|---|---|
| email / message | email, e-mail, emailed, emailing, message(d), messaging, inbox | `write (a note/letter/message) to …` but never `write to (my) Nexus`; `text my/the/him/her/them` |
| calendar | none. A bare "calendar" is NOT vetoed: "the course calendar in my syllabus" is coursework | `on/to/in/into/onto/from/off my calendar`; `calendar invite/event/hold/block`; `block (off/out) (two/\d+) hours/minutes/time/…`; `focus/study/deep work/prep time/block/session`; `schedule (some/two/\d+) time/hours/session/block` |
| reminder | remind, reminder | none |
| dining | restaurant, dinner, lunch, breakfast, brunch, eat, eating, reservation, book a table, reserve a table | none |
| car / driving | rent a car, rental car, car rental, rent-a-car, uber, lyft, taxi | `drive/driving to/from/me/us/down/up/over/back/home`. Never after google/my/the/a/shared/team/one ("my Google Drive"), and never `drive to Nexus` |
| lodging | airbnb, lodging, hotels (hotel was already there), motel, hostel, accommodation(s) | `place/somewhere/where to stay`; `stay(ing) at/near/in/with/overnight`. Never "stay on top of" |
| money | budget, budgeting, afford, deposit, payment, pay, paying, tuition, buy, buying, purchase, purchasing, price, spend, spending, refund | `cost(s)`. Never cost-benefit / cost accounting / cost analysis / cost of capital / cost structure / cost leadership / cost center |
| running / training | runs, running, jog, jogging, marathon, 5k, 10k, training plan, training schedule (gym/workout/fitness were already there) | `go/went/going for a run`; `\d+ k/km/mi/mile(s) run`; `run(ning) plan/schedule`. A bare "run" is NOT vetoed ("run the model for my paper") |
| travel | travel, traveling, travelling, airport, itinerary, fly, flying (flight/airline/trip/hotel were already there) | none |

Vetoes are evaluated before any context, strong or weak, so the same data covers the warm course-list path AND
the weak-only / cold-cache path. There is no separate cold path to forget.

### Before / after on every D12 ask (`bun mut-routing-prime/probe-d12.ts <tree>`; outputs `mut-routing-prime/probe-d12.{main,before,pr}.out`)

"before" = this branch at b682ab6 (loop 3 + main merged, no D12 change). "after" = this branch. Group = the
deterministic group leader (`routeMessage`, all agents present). "-> X + DM" = `primeLaneDecision` from the
addressed agent returned X: the 1:1 directive defers AND huddle.functions.ts:6835 sends the deterministic
follow-up DM. Lane = `laneOwnerFor` from the addressed agent. Every "after" row was measured on BOTH caches with
identical results. It equals origin/main on group leader and 1:1 lane for all 34 asks x 2 caches (68/68), and the
number of agents that would make a prime hand-off is 0 in all 68.

| Veto group | Ask (1:1 with) | origin/main: group / 1:1 lane | before (warm) | before (cold) | after (warm AND cold) |
|---|---|---|---|---|---|
| email | "email my professor that my MGT-782 paper will be a day late" (cam) | cam / none | iris / -> iris + DM | iris / -> iris + DM | cam / no hand-off, lane none |
| email | "draft an email to my MGT-782 group about the proposal deadline" (cam) | elle / none | elle / -> elle + DM | elle / no hand-off | elle / no hand-off, lane none |
| email | "email my professor that my paper will be a day late" (cam) | cam / none | iris / -> iris + DM | iris / -> iris + DM | cam / no hand-off, lane none |
| email | "draft an email to my instructor asking for an extension on the essay deadline" (cam) | elle / elle | elle / -> elle + DM | elle / -> elle + DM | elle / no hand-off, lane elle |
| email | "message my MGT-782 professor that the essay will be late" (cam) | elle / elle | elle / -> elle + DM | elle / -> elle + DM | elle / no hand-off, lane elle |
| email-pattern | "write to my professor that my MGT-782 paper will be late" (cam) | elle / none | elle / -> elle + DM | elle / -> elle + DM | elle / no hand-off, lane none |
| email-pattern | "text my instructor that I need more time on the essay deadline" (cam) | elle / elle | elle / -> elle + DM | elle / -> elle + DM | elle / no hand-off, lane elle |
| calendar | "block two hours on my calendar Thursday for the MGT-782 paper" (eli) | iris / none | iris / -> iris + DM | iris / no hand-off | iris / no hand-off, lane none |
| calendar | "schedule focus time before my MGT-782 essay deadline" (eli) | elle / elle | elle / -> elle + DM | elle / -> elle + DM | elle / no hand-off, lane elle |
| calendar | "block two hours on my calendar Thursday for my research paper deadline" (eli) | elle / none | elle / -> elle + DM | elle / -> elle + DM | elle / no hand-off, lane none |
| calendar | "put study time on my calendar before the MGT-702 exam" (eli) | iris / none | iris / -> iris + DM | iris / no hand-off | iris / no hand-off, lane none |
| reminder | "remind me tomorrow at 9 that the MGT-782 paper is due" (eli) | iris / none | iris / -> iris + DM | iris / no hand-off | iris / no hand-off, lane none |
| reminder | "remind me tomorrow at 9 that my essay deadline is Friday" (eli) | elle / elle | elle / -> elle + DM | elle / -> elle + DM | elle / no hand-off, lane elle |
| reminder | "set a reminder for the MGT-702 final paper deadline" (eli) | elle / none | elle / -> elle + DM | elle / -> elle + DM | elle / no hand-off, lane none |
| dining | "book a table for my MGT-782 study group after the exam Friday" (charleston) | iris / none | iris / -> iris + DM | iris / no hand-off | iris / no hand-off, lane none |
| dining | "pick a restaurant for dinner after my MGT-782 exam" (charleston) | charleston / none | iris / -> iris + DM | charleston / no hand-off | charleston / no hand-off, lane none |
| dining | "pick a restaurant for dinner with my professor after the exam" (charleston) | charleston / none | elle / -> elle + DM | elle / -> elle + DM | charleston / no hand-off, lane none |
| dining | "where should I eat lunch before my EMBA694 exam" (charleston) | elle / none | elle / -> elle + DM | elle / no hand-off | elle / no hand-off, lane none |
| car | "rent a car for the MGT-701 residency weekend, it's due back Sunday" (troy) | ezra / none | iris / -> iris + DM | ezra / no hand-off | ezra / no hand-off, lane none |
| car | "get me a rental car for the MGT-782 residency, the deadline to book is Friday" (troy) | elle / none | elle / -> elle + DM | elle / no hand-off | elle / no hand-off, lane none |
| car-pattern | "drive me to campus for my MGT-782 exam Friday" (troy) | iris / none | iris / -> iris + DM | iris / no hand-off | iris / no hand-off, lane none |
| lodging | "I need an Airbnb in Toronto for the EMBA694 residency, the deadline to book is Friday" (troy) | elle / elle | elle / -> elle + DM | elle / no hand-off | elle / no hand-off, lane elle |
| lodging | "find me lodging near campus for the MGT-782 residency, deadline to book is Friday" (troy) | elle / none | elle / -> elle + DM | elle / no hand-off | elle / no hand-off, lane none |
| lodging-pattern | "find a place to stay for the MGT-701 residency, the deadline is Friday" (troy) | elle / none | elle / -> elle + DM | elle / no hand-off | elle / no hand-off, lane none |
| money | "the EMBA694 textbook payment is due Friday, can I afford it" (finn) | elle / none | elle / -> elle + DM | elle / no hand-off | elle / no hand-off, lane none |
| money | "budget for the MGT-701 residency costs, the deposit is due Monday" (finn) | finn / none | iris / -> iris + DM | finn / no hand-off | finn / no hand-off, lane none |
| money | "pay my EMBA694 tuition before the deadline" (finn) | elle / elle | elle / -> elle + DM | elle / no hand-off | elle / no hand-off, lane elle |
| money | "buy the MGT-782 textbook before the exam" (finn) | iris / none | iris / -> iris + DM | iris / no hand-off | iris / no hand-off, lane none |
| money-pattern | "what will the MGT-701 residency cost, the paper is due the same week" (finn) | tess / none | iris / -> iris + DM | tess / no hand-off | tess / no hand-off, lane none |
| fitness | "plan my runs around the MGT-782 exam week" (flex) | iris / none | iris / -> iris + DM | iris / no hand-off | iris / no hand-off, lane none |
| fitness | "build a training plan around my MGT-782 exam" (flex) | flex / none | iris / -> iris + DM | flex / no hand-off | flex / no hand-off, lane none |
| fitness-pattern | "I want to go for a run before my MGT-782 exam" (flex) | flex / none | iris / -> iris + DM | flex / no hand-off | flex / no hand-off, lane none |
| travel | "book my travel to the MGT-701 residency, the deadline is Friday" (troy) | troy / none | elle / -> elle + DM | troy / no hand-off | troy / no hand-off, lane none |
| travel | "book a flight for the EMBA694 residency before the deadline" (troy) | elle / none | elle / no hand-off | elle / no hand-off | elle / no hand-off, lane none |

The verifier's own probes on this tree (saved as `mut-routing-prime/verifier-probe-routing*.pr.out`): every D12 row
is now byte-identical to origin/main. The only rows still different from origin/main are coursework: "my MGT-782
paper is due Friday" (Finn -> Iris, prime), "add the MGT-701 research proposal due Dec 1 to Nexus" (Troy -> Iris,
the verifier's control), "my professor wants the case study by Friday, can you add it" (Finn -> Elle), and "what's
my assignment for the DBA residency, can you check" (group Iris instead of Tess; it is a question about his
assignment, query intent, so no 1:1 follow-up fires). The two over-veto rows ("… real options …", "… for the
client …") are unchanged (= origin/main, the accepted loop-3 residual).

**About the "lane" column.** Where origin/main's own keyword `laneOwnerFor` names Elle (for example "draft an email
to my instructor asking for an extension…" sent to Cam), this tree now returns exactly that origin/main value
again. In a 1:1 that value is only the FALLBACK used when the LLM owner resolver has no key or fails
(huddle.functions.ts, unchanged from origin/main). With a key, the resolver decides, now with the (A) hint below.
That keyword fallback is origin/main behaviour; this change neither introduced nor altered it.

## Coursework: still prime with Elle/Iris

The 21 loop-3 coursework asks: `bun mut-loop3/probe-routing.ts <this tree> cw` output is identical to the
verifier's recorded `fixer-cw.pr.out` (21/21: group Elle/Iris, Elle and Iris keep, Finn hands to Elle/Iris). The 24
loop-2 D6 asks (`… d6`) are identical to `fixer-d6.pr.out`. All loop-2/3 coursework tests are green with no
assertion changed (L3-D6e/f/g 21 asks, router-winners F2-42, L2-D5*). New asks that sit right next to the new
vetoes:

| Coursework ask | cache | origin/main group | before: group / Elle,Iris / Finn's 1:1 | after: group / Elle,Iris / Finn's 1:1 |
|---|---|---|---|---|
| "add the MGT-701 research proposal due Dec 1 to Nexus" | warm | iris | iris / keep/keep / iris | iris / keep/keep / iris |
| "my MGT-782 paper is due Friday" | warm | iris | iris / keep/keep / iris | iris / keep/keep / iris |
| "my professor wants the case study by Friday, can you add it" | warm | elle | elle / keep/keep / elle | elle / keep/keep / elle |
| "add the MGT-782 cost-benefit analysis paper due Friday to Nexus" | warm | troy | iris / keep/keep / iris | iris / keep/keep / iris |
| "upload the MGT-702 syllabus from my Google Drive to Nexus" | warm | iris | iris / keep/keep / iris | iris / keep/keep / iris |
| "the course calendar in my MGT-782 syllabus has the paper due Dec 9, add it" | warm | elle | elle / keep/keep / elle | elle / keep/keep / elle |
| "update the due date on my MGT-782 essay to Friday" | warm | elle | elle / keep/keep / elle | elle / keep/keep / elle |
| "add my EMBA694 case brief due Nov 20" | warm | elle | elle / keep/keep / elle | elle / keep/keep / elle |
| "stay on top of my MGT-782 assignments, add the essay due Friday" | warm | elle | elle / keep/keep / elle | elle / keep/keep / elle |
| "add the MGT-701 research proposal due Dec 1 to Nexus" | cold | iris | iris / keep/keep / iris | iris / keep/keep / iris |
| "my MGT-782 paper is due Friday" | cold | iris | iris / null/null / none | iris / null/null / none |
| "my professor wants the case study by Friday, can you add it" | cold | elle | elle / keep/keep / elle | elle / keep/keep / elle |
| "add the MGT-782 cost-benefit analysis paper due Friday to Nexus" | cold | troy | iris / keep/keep / iris | iris / keep/keep / iris |
| "upload the MGT-702 syllabus from my Google Drive to Nexus" | cold | iris | iris / keep/keep / iris | iris / keep/keep / iris |
| "the course calendar in my MGT-782 syllabus has the paper due Dec 9, add it" | cold | elle | elle / keep/keep / elle | elle / keep/keep / elle |
| "update the due date on my MGT-782 essay to Friday" | cold | elle | elle / keep/keep / elle | elle / keep/keep / elle |
| "add my EMBA694 case brief due Nov 20" | cold | elle | elle / null/null / none | elle / null/null / none |
| "stay on top of my MGT-782 assignments, add the essay due Friday" | cold | elle | elle / null/null / elle | elle / null/null / elle |

Also in the test suite: "add the MGT-782 deadlines from the syllabus on my Google Drive to my assignments" and
"import the MGT-702 syllabus from Drive to Nexus" (each protected by only one of the drive pattern's two
exclusions), and "add the MGT-782 regression analysis paper due Friday, I still need to run the model" (a bare
"run" is not vetoed). Cold rows with `null/null` are by design: without the course list a bare course code is no
context (loop 3, unchanged).

## (A) LLM-router hint: additive, built from data

- **agents.ts:** new optional field `AgentCapability.routerHint` (prose for a model, never matched against text),
  set on `nexus-assignments`. It says the holders "are the preferred owners whenever the owner asks to ADD or
  UPDATE his Nexus coursework assignments (…)" and "Other lanes keep asks that merely MENTION a course, a professor
  or a deadline: emailing or messaging a professor (email lane), booking travel, lodging or a rental car for a
  residency (travel lane), budgeting tuition, a deposit or a textbook purchase (finance lane), scheduling study
  time or a reminder (calendar lane), dinner after an exam (dining lane), training around exam week (fitness
  lane)." It names lanes, not agents.
- **capabilities.ts:** `primeOwnershipDirectory(members?)` returns `PRIME OWNERS (who leads which shared job —
  advisory; ADDRESSED BY NAME and DELEGATION still win):` followed by one line per shared capability that has a
  holder present: `- <label> → Elle Rowan (@elle-rowan), Iris Chase (@iris-chase): <routerHint>`. The names come
  from the roster; no agent id or name is written in capabilities.ts (test R-A2d). It returns an empty string when
  no holder is in the huddle.
- **routing.ts:** the directory is APPENDED to the group router's system prompt on both the base and the strict
  variant (`system = (strict ? strictSystem : baseSystem) + "\n" + directory`), and to the 1:1 owner resolver
  (`resolveOwnerLLM`) prompt. That resolver's roster lines now also carry the `[prime for: …]` marker the group
  roster already had. Nothing was removed or reworded: tests assert the existing PRIME RESPONDERS, ADDRESSED BY
  NAME and keep-by-default text is still present (R-A3, R-A3s, R-A4c, R-A4d). The agents' own prompts (snapshot
  JSON, `p()` personas) are not touched.
- **Not measurable offline:** what a real model does with the hint. The tests prove the hint reaches both prompts
  (a fake `fetch` records the request body) and that the router's own answer is still the one used.

## Tests: `scripts/nexus-write-routing.test.ts` (new, added to `scripts/run-nexus-fix-suites.sh`)

| Block | Checks |
|---|---|
| R-PRIME | the holders of `nexus-assignments` are elle-rowan and iris-chase (data) |
| R12-<group> warm/cold | 34 D12 asks x 2 caches x 5 checks: no prime capability; group leader = origin/main (measured literal); prime hand-off from ANY of the roster's agents = 0; `laneOwnerFor` from the addressed agent = origin/main; 1:1 routing answers with the addressed agent |
| R-CW-* warm/cold | 12 coursework asks warm, 8 of them also cold: group led by Elle/Iris; Elle and Iris keep; Finn hands to Elle/Iris |
| R-A1..R-A4e | directory content (holders, label, hint); the hint's phrases; empty without a holder; an Iris-only huddle names only Iris; no names in capabilities.ts; group router base + strict (fake fetch): directory present, existing rules present, roster marker present, router's answer used; no holder -> no block; 1:1 resolver: directory, markers, keep-default and system prompt present, answer used |

## Mutations (mutate.sh; anchors/replacements are FILES in `mut-routing-prime/`, generated from the exact source text and checked to occur once by `make-anchors.py`; runner `bash mut-routing-prime/run-mutations.sh`; test cmd `bun scripts/nexus-write-routing.test.ts`; full output `mut-routing-prime/mutations.out`)

| # | Guard | Mutation | Must fail | mutate.sh verbatim |
|---|---|---|---|---|
| v-email | email words | line deleted | R12-email warm | `FIRED: 'R12-email warm' failed with the defect reinstated. The guard is real.` |
| v-email-pattern | write to / text my | pattern deleted | R12-email-pattern warm | `FIRED: 'R12-email-pattern warm' failed with the defect reinstated. The guard is real.` |
| v-calendar | own-calendar / time-block pattern | pattern -> `(?!)` | R12-calendar warm | `FIRED: 'R12-calendar warm' failed with the defect reinstated. The guard is real.` |
| v-reminder | remind, reminder | line deleted | R12-reminder warm | `FIRED: 'R12-reminder warm' failed with the defect reinstated. The guard is real.` |
| v-dining | dining words | first line deleted | R12-dining warm | `FIRED: 'R12-dining warm' failed with the defect reinstated. The guard is real.` |
| v-car | car-rental words | line deleted | R12-car warm | `FIRED: 'R12-car warm' failed with the defect reinstated. The guard is real.` |
| v-car-pattern | drive to / drive me pattern | pattern -> `(?!)` | R12-car-pattern warm | `FIRED: 'R12-car-pattern warm' failed with the defect reinstated. The guard is real.` |
| v-lodging | lodging words | line deleted | R12-lodging warm | `FIRED: 'R12-lodging warm' failed with the defect reinstated. The guard is real.` |
| v-lodging-pattern | place to stay / stay near | pattern deleted | R12-lodging-pattern warm | `FIRED: 'R12-lodging-pattern warm' failed with the defect reinstated. The guard is real.` |
| v-money | money words | first line deleted | R12-money warm | `FIRED: 'R12-money warm' failed with the defect reinstated. The guard is real.` |
| v-money-pattern | cost(s) | pattern deleted | R12-money-pattern warm | `FIRED: 'R12-money-pattern warm' failed with the defect reinstated. The guard is real.` |
| v-fitness | running/training words | line deleted | R12-fitness warm | `FIRED: 'R12-fitness warm' failed with the defect reinstated. The guard is real.` |
| v-fitness-pattern | go for a run / 5 mile run | pattern deleted | R12-fitness-pattern warm | `FIRED: 'R12-fitness-pattern warm' failed with the defect reinstated. The guard is real.` |
| v-travel | travel words | line deleted | R12-travel warm | `FIRED: 'R12-travel warm' failed with the defect reinstated. The guard is real.` |
| g-drive | "Google/my Drive" lookbehind | removed | R-CW-gdrive warm | `FIRED: 'R-CW-gdrive warm' failed with the defect reinstated. The guard is real.` |
| g-drive-nexus | "drive to Nexus" exclusion | removed | R-CW-drive-nexus warm | `FIRED: 'R-CW-drive-nexus warm' failed with the defect reinstated. The guard is real.` |
| g-cost | cost-benefit / accounting / … exclusion | removed | R-CW-cost warm | `FIRED: 'R-CW-cost warm' failed with the defect reinstated. The guard is real.` |
| g-run | a bare "run" is not vetoed | "run" added to the words | R-CW-run warm | `FIRED: 'R-CW-run warm' failed with the defect reinstated. The guard is real.` |
| g-stay | "stay on top of" is not vetoed | `on` added to the stay pattern | R-CW-stay warm | `FIRED: 'R-CW-stay warm' failed with the defect reinstated. The guard is real.` |
| h-data | routerHint prose (agents.ts) | first sentence emptied | R-A2 … "preferred owners" | `FIRED: 'R-A2 the hint data says "preferred owners"' failed with the defect reinstated. The guard is real.` |
| h-dir | the directory carries the hint (capabilities.ts) | hint omitted | R-A1-hint | `FIRED: 'R-A1-hint' failed with the defect reinstated. The guard is real.` |
| h-group | the group router appends the directory | append removed | R-A3 base … | `FIRED: 'R-A3 base router system prompt carries' failed with the defect reinstated. The guard is real.` |
| h-strict | …on the strict prompt too | append bound to the base prompt only | R-A3s strict … | `FIRED: 'R-A3s strict router system prompt carries' failed with the defect reinstated. The guard is real.` |
| h-resolver | the 1:1 resolver carries the directory | line deleted | R-A4 … | `FIRED: 'R-A4 1:1 owner resolver prompt carries' failed with the defect reinstated. The guard is real.` |

First run: g-drive targeted R-CW-drive ("upload … from my Google Drive to Nexus") and returned
`INERT: 'R-CW-drive warm' still PASSED with its defect reinstated.` That was correct: the same ask is ALSO protected
by the "drive to Nexus" exclusion, so removing the lookbehind alone cannot move it. I added R-CW-gdrive ("… on my
Google Drive to my assignments", protected only by the lookbehind) and R-CW-drive-nexus ("… from Drive to Nexus",
protected only by the exclusion), re-targeted g-drive, and added g-drive-nexus. Both FIRED. **Final run: 24 run,
24 FIRED, 0 INERT, 0 NOT-APPLIED.** Every run printed `restored: … matches HEAD` and `tree clean: …`.

Loop 3's routing mutations re-run on this tree (`bash mut-loop3/run-mutations.sh r1 … r7`): r1 L3-D6o, r2 L3-D6f,
r3 L3-D6a, r4 L3-D6q, r5 L3-D6l, r6 L3-D6u, r7 L3-D6k each printed `FIRED: '<id>' failed with the defect
reinstated. The guard is real.` The verifier's p7 (`bash mut-verify-114-3/run-mutations.sh p7`) printed
`FIRED: 'L3-D6' failed with the defect reinstated. The guard is real.`

## Results

`bash scripts/run-nexus-fix-suites.sh` on the final commit:

| Suite | Result |
|---|---|
| scripts/nexus-write-redteam.test.ts | ALL PASS: 39 passed, 0 failed |
| scripts/router-redteam.test.ts | 12 passed, 0 failed |
| scripts/nexus-write-tool.test.ts | ALL PASS: 115 passed, 0 failed |
| scripts/router-winners.test.ts | 39 passed, 0 failed |
| scripts/nexus-read-tools.test.ts | ALL PASS: 190 passed, 0 failed |
| scripts/cross-app-turn-gate.test.ts | 92 passed, 0 failed |
| scripts/voice-toolset-hidden.test.ts | 36 passed, 0 failed |
| scripts/nexus-write-fix.test.ts | ALL PASS: 51 passed, 0 failed |
| scripts/nexus-write-loop2.test.ts | ALL PASS: 185 passed, 0 failed |
| scripts/nexus-write-loop3.test.ts | ALL PASS: 315 passed, 0 failed |
| scripts/nexus-write-voice-gate.test.ts | ALL PASS: 43 passed, 0 failed |
| scripts/nexus-write-routing.test.ts | ALL PASS: 432 passed, 0 failed |

`npx tsc --noEmit -p .`: clean (exit 0). `bun scripts/barge-route.test.ts` (a routing consumer, not in the runner):
10 passed, 0 failed.

## Residuals (not fixed, and why). All measured with `bun mut-routing-prime/probe-residuals.ts <tree>` (output `probe-residuals.pr.out`), warm cache

- **It is still a word list (owner's choice B).** D12 is closed for the asks measured and for their lanes' common
  vocabulary. An other-lane ask that names a real course plus a deadline word and uses NONE of the veto vocabulary
  is still taken as coursework: "ask my MGT-782 study group if the paper is due Friday" -> group Iris, and Cam in a
  1:1 hands it to Iris; "call my MGT-782 professor about the paper deadline" -> Elle, likewise. (A) is the semantic
  layer for the group LLM router and the 1:1 resolver, but the deterministic prime hand-off runs BEFORE the 1:1
  resolver (huddle.functions.ts:6835), so in a 1:1 the word list decides.
- **Over-veto grows with the list (NON-BLOCKING: such asks fall back to origin/main routing, nothing is
  written or lost).** A coursework ask that names a vetoed topic is no longer prime: "add my MGT-782 case study on
  Airbnb's pricing due Friday" (group still Iris by theme scoring), "the EMBA694 paper on executive pay is due
  Dec 4" (group still Elle), "my MGT-782 travel industry essay is due Friday" (group Troy), and "add the MGT-782
  email marketing case analysis due Friday to Nexus" (group Cam). Same class as loop 3's "real options"/"client"
  residual. Even an explicit "… to Nexus" does not override a veto: vetoes-first is loop 3's owner-specified order
  (pinned by L3-D6t and mutation r1), unchanged here. Letting an explicit Nexus-as-the-app mention beat the
  vetoes would be a code change to `capabilityContextPresent`, so it is left for the owner to decide.
- **Every recorded coursework ask is unaffected:** every loop-1/2/3 coursework assertion is green unchanged, so
  none of them hits a new veto.
- **(A) is advisory and unmeasured offline:** whether a real model follows the hint is a live question.
