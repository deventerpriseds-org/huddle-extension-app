# FIX nexus-write-tool, loop 4 — M0 (merge main), D13 (1:1 lane steals), D13-ovr (override needs an assignment object)

<!--
WHAT:          Fixes for the loop-4 verifier's blocking findings on huddle PR #114 (branch claude_nexus-write-tool-fixed):
               M0 merge of origin/main (#124 "One ownership judge"), D13 (deterministic 1:1 coursework hand-off
               steals other lanes' asks origin/main keeps), D13-ovr (explicit Nexus override fired on non-coursework).
WHY:           docs/VERIFY-nexus-write-tool-4.md returned REFUTED: M0 (PR does not merge with 4cb2273, conflicts in
               routing.ts + realtime-tools.server.ts), D13 (18 vocabulary lane steals), D13-ovr (3 override steals).
RESPONDS TO:   docs/VERIFY-nexus-write-tool-4.md (branch claude_verify-nexus-write-tool-4).
SUPERSEDES:    nothing. FOLLOWS docs/FIX-nexus-write-routing.md, docs/FIX-nexus-write-voice-gate.md.
SUPERSEDED-BY: nothing -- current.
EVIDENCE:      this file; tests in scripts/nexus-write-routing.test.ts; mutation anchors in mut-loop4/.
               Offline only: fetch mocked, no live Nexus/Huddle, no DB or board writes.
-->

Written as the work goes (2026-10-29).

## Step 1 — M0: merge origin/main (4cb2273, #124) with a merge commit

Merged with `--no-ff` (no rebase). Two conflicts, as the verifier predicted:

| File | Resolution | Why |
|---|---|---|
| `lib/voice/realtime-tools.server.ts` (`raw` toolset) | **UNION**: main's multi-line list with `...(opts.journey !== false ? [FOCUS_TOOL] : [])` (AC8 journey gate) **plus** the PR's `...nexusWriteTools()` after `...nexusReadTools()` | taking main drops the voice Nexus write tool; taking the PR re-offers FOCUS_TOOL with journey off |
| `lib/routing.ts` (`resolveOwnerLLM` prompt) | main's #124 `framing: "dm" \| "assigned"` logic intact; new **explicit** `opts.primeHint?: boolean` (default off, ignored when `assigned`). Only with it does the prompt get the `PRIME OWNERS` directory and the roster's `[prime for: …]` markers. | #124 made `resolveOwnerLLM` the grooming judge (groom.ts) and the 1:1 task-creation / produce-task judge (huddle.functions.ts); none of those may see the coursework hint |

Call sites on the merged tree: only the live 1:1 chat hand-off (huddle.functions.ts owner follow-up,
`resolveOwnerLLM(data.text, nextId, {...}, { primeHint: true })`) opts in. Grooming (`{ framing: "assigned" }`),
1:1 task creation (`resolveOwnerLLM(title, winner.id, …)`) and the produce task (`resolveOwnerLLM(askText, agentId, …)`)
pass no `primeHint` and get origin/main's prompt (the roster line also drops `primeMarker` without it). The call
was kept as `resolveOwnerLLM(data.text, nextId, {` on one line so main's `ownership-judge.test.ts` shape check
("the 1:1 hand-off asks the same judge") still matches.

Merge-induced test updates (shape only, no behaviour change): `nexus-write-tool.test.ts` F2-31(2)/F2-32 and
`nexus-read-tools.test.ts` "voice pushes them into its toolset" now read the whole multi-line `raw` array literal
and require a BARE (unconditional) spread line; `nexus-write-routing.test.ts` R-A4 calls the resolver with
`{ primeHint: true }`.

On the merged tree before the D13 work: all 12 nexus suites green (routing 825, tool 115, read 190, …); main's
#124 tests `ownership-judge` / `assign-on-create` / `ask-shape` / `board-delete` ALL PASS; `npx tsc --noEmit -p .`
exit 0.

## Step 2 — D13 (structural): the 1:1 deterministic hand-off fires only on the explicit override

Owner rule: the coursework rule keeps deciding the GROUP leader; Elle/Iris keep every coursework ask addressed to
them; a 1:1 with ANY OTHER agent is handed to Elle/Iris deterministically ONLY when the ask matches the explicit
override. Everything else falls through to origin/main's 1:1 path (keyword `laneOwnerFor` directive + the LLM owner
judge). Not another veto word: the verifier showed the word-list approach cannot close this class.

Mechanism (DATA, no agent id in code):

- `agents.ts`: new `AgentCapability.oneToOneHandoff?: "always" | "explicit-override"` (default "always"); the Nexus
  coursework capability sets `"explicit-override"`.
- `capabilities.ts`: `capabilityExplicitOverride(cap, text)` (the capability's `explicitOverride` patterns after
  `ignore`) and `capabilityHandsOffInOneToOne(cap, text)` (reads the flag).
- `routing.ts` `primeLaneDecision`: holder -> "keep" (unchanged); non-holder -> a holder ONLY if
  `capabilityHandsOffInOneToOne`; otherwise `null`. Both consumers read it -- the 1:1 directive (`laneOwnerFor`) and
  the durable follow-up DM (huddle.functions.ts) -- so they still cannot disagree, and on `null` both take
  origin/main's code path. `routeMessage` (group) is untouched.

## Step 3 — D13-ovr: the override needs an ASSIGNMENT OBJECT

`NEXUS_EXPLICIT_WRITE` (agents.ts, data on the capability's `requiresContext.explicitOverride`) now requires one of
`NEXUS_ASSIGNMENT_OBJECTS` -- assignment, paper, essay, proposal, case / case study / case analysis, analysis, memo,
reflection, post, quiz, exam, project, presentation, problem set, deliverable, brief, review, report, due date
(plurals tolerated) -- between the write verb and "to / in / into (my) Nexus", or the destination "Nexus
assignments" itself. The verb list, the clause-start rule and the NEXUS-program exclusions are unchanged. The
routers' `routerHint` now says the written thing must be an assignment.

## Before -> after (verifier rows; 1:1 = `laneOwnerFor` directive + deterministic `primeLaneDecision` hand-off)

Measured with the verifier's own probes (`bun mut-verify-114-4/probe-c9-{routing,steal2}.ts <tree>`) on a
`git archive origin/main` export, the merged tree before step 2 and after step 3: `mut-loop4/probe-c9-*.{main,
merged-before,merged-after}.out`. Warm + cold: `mut-loop4/measure-d13.{main,fixed}.out` (1:1 columns identical to
origin/main for every row on both caches).

| Row | Ask (addressed) | origin/main 1:1 | merged BEFORE | AFTER | = main? |
|---|---|---|---|---|---|
| L10 | put the MGT-782 exam on the calendar for Friday (Eli) | keep | -> Iris | keep | yes |
| S1 | put my MGT-782 exam on the calendar (Eli) | keep | -> Iris | keep | yes |
| S2 | add the MGT-782 final exam to the calendar, it's Dec 12 (Eli) | keep | -> Iris | keep | yes |
| S4 | can you get the MGT-782 exam onto my schedule (Eli) | keep | -> Iris | keep | yes |
| L13 | send my MGT-782 group the slides before the deadline (Cam) | keep | -> Elle | keep | yes |
| S5 | share the slides with my MGT-782 group before Friday's deadline (Cam) | keep | -> Elle | keep | yes |
| L14 | DM my MGT-782 group that the proposal deadline moved (Cam) | keep | -> Elle | keep | yes |
| S7 | reply to my MGT-782 professor about the exam (Cam) | keep | -> Elle | keep | yes |
| L3 | book a room near campus for the MGT-701 residency… (Troy) | keep | -> Elle | keep | yes |
| S8 | book a room for the MGT-701 residency, it's due by Friday (Troy) | keep | -> Iris | keep | yes |
| L4 | get me a ride to the MGT-782 exam on Friday (Troy) | keep | -> Iris | keep | yes |
| S9 | I need a ride to my MGT-782 exam (Troy) | keep | -> Iris | keep | yes |
| L6 | order the MGT-782 textbook… before the exam (Finn) | keep | -> Iris | keep | yes |
| S10 | order the EMBA694 textbook before the exam (Finn) | keep | -> Elle | keep | yes |
| L8 | plan my meals for MGT-782 exam week (Charleston) | keep | -> Iris | keep | yes (group: see residuals) |
| S11 | meal prep for my MGT-782 exam week (Charleston) | keep | -> Iris | keep | yes (group: see residuals) |
| S14 | stretch routine before my MGT-782 exam (Flex) | keep | -> Iris | keep | yes |
| L12 | find a babysitter for the MGT-701 residency weekend… (Charleston) | keep | -> Elle | keep | yes |
| S6 | send the MGT-782 group my draft before the deadline (Cam) | -> Elle (keyword) | -> Elle (prime) | -> Elle (keyword) | yes |
| S12 | what should I cook the night before my MGT-782 exam (Charleston, query) | keep | -> Iris | keep | yes |
| **O3** | change my vehicle info in my NEXUS account (Troy) | keep | -> Iris | keep | yes |
| **O4** | add my new passport number to NEXUS (Troy) | keep | -> Iris | keep | yes |
| **O8** | set a reminder to log into Nexus tonight and check my grades (Eli) | keep | -> Iris | keep | yes |
| O1 | update my address in NEXUS before my next border crossing (Troy) | -> Eli | -> Iris | -> Eli | yes |
| O2 | reschedule my interview in NEXUS… (Troy) | -> Cole | -> Iris | -> Cole | yes |
| O11 | Finn, add the EMBA694 textbook cost to Nexus (Finn) | keep | -> Elle | keep | yes |
| O15 | save my flight confirmation to Nexus (Troy) | keep | -> Iris | keep | yes |
| O12 / O14 / P1 / P3 | explicit "put/add/update … case analysis / essay / proposal / due date … in(to)/to Nexus" | keep / keep / keep / -> Eli | -> Iris/Elle | -> Iris/Elle | intended override (unchanged) |
| P2 | my MGT-782 paper is due Friday (Finn) | keep | -> Iris | keep (LLM judge decides the DM) | yes -- see residuals |

## Tests (scripts/nexus-write-routing.test.ts, 825 -> 1224)

- **R13-\***: the 27 verifier rows above, GENERATED from `mut-loop4/measure-d13.{main,fixed}.out` (not typed), warm and
  cold: group leader (named "= origin/main" or "coursework group rule; origin/main X" where they differ), no
  deterministic prime hand-off from ANY non-holder, `laneOwnerFor` = origin/main's, not an override, 1:1 answers itself.
- **R13-ovr-\***: the capability's `oneToOneHandoff` data; 10 non-assignment Nexus writes (passport, NEXUS account,
  reminder to log in, flight confirmation, textbook cost, address, interview, profile phone, log in, email address)
  are NOT overrides; each of the owner's 21 nouns (+4 plurals) in two carrier sentences IS; the verifier's intended
  overrides still hand off from a non-holder, Elle/Iris keep, Elle/Iris lead the group (warm + cold).
- **R13-cw**: non-override coursework -> Elle/Iris keep; Finn makes no deterministic hand-off.
- **R-M0-\***: `resolveOwnerLLM` with fetch mocked: `{ primeHint: true }` carries PRIME OWNERS + `[prime for: …]`;
  grooming `{ framing: "assigned" }`, no opts (task creation / produce task), `{ framing: "dm" }` and
  `{ framing: "assigned", primeHint: true }` carry neither; grooming keeps #124's "currently owned by" framing; call
  sites: exactly one `primeHint: true` in huddle.functions.ts and it is `resolveOwnerLLM(data.text, nextId, …)`; the
  title / askText calls and groom.ts never pass it.
- Pre-loop-4 assertions that pinned the old rule ("1:1 Finn hands <any coursework ask> to Elle/Iris": routing
  R-CW, loop2 L2-D5g, loop3 L3-D6g; router-winners F2-43 "any hand-off goes to Elle/Iris") now assert the D13 rule:
  a deterministic hand-off to Elle/Iris only on an explicit override, otherwise none.

## Suites on the merged tree (final)

| Suite | Result |
|---|---|
| nexus-write-redteam | ALL PASS 39/0 |
| router-redteam | 12/0 |
| nexus-write-tool | ALL PASS 115/0 |
| router-winners | 39/0 |
| nexus-read-tools | ALL PASS 190/0 |
| cross-app-turn-gate | 92/0 |
| voice-toolset-hidden | 36/0 |
| nexus-write-fix | ALL PASS 51/0 |
| nexus-write-loop2 | ALL PASS 185/0 |
| nexus-write-loop3 | ALL PASS 315/0 |
| nexus-write-voice-gate | ALL PASS 43/0 |
| nexus-write-routing | ALL PASS 1224/0 |
| #124: ownership-judge | ALL PASS (16 checks) |
| #124: assign-on-create | ALL PASS |
| #124: ask-shape | ALL PASS |
| #124: board-delete | ALL PASS |
| `npx tsc --noEmit -p .` | exit 0 |

## Mutations (mutate.sh; anchors generated from source by `mut-loop4/make-anchors.py`; runner `mut-loop4/run-mutations.sh`)

| id | Defect reinstated | Named test | Verdict (verbatim) |
|---|---|---|---|
| m1 | `primeLaneDecision` hands off on any match (`handing = holders`) | R13-S1 warm 1:1 with ANY agent | FIRED |
| m2 | `capabilityHandsOffInOneToOne` ignores `oneToOneHandoff` | first named R13-L10 **cold** -> UNDETERMINED (L10 has no holder on a cold cache); re-run named R13-L10 warm | FIRED |
| m3 | `oneToOneHandoff: "explicit-override"` removed from the capability | R13-ovr-data | FIRED |
| m4 | override pattern without the assignment object (loop-4 shape) | R13-ovr-neg "add my new passport number | FIRED |
| m5 | prime directory for every `resolveOwnerLLM` caller | first named R-M0-grooming -> UNDETERMINED (the `assigned` branch never prints it); re-run named R-M0-task creation | FIRED |
| m6 | `assigned` no longer overrides `primeHint` | assigned wins | FIRED |
| m7 | chat hand-off stops opting in | R-M0-site exactly one primeHint | FIRED |
| m8 | merge took main's side: voice loses `nexusWriteTools()` | voice toolset pushes the write tools (nexus-write-tool) | FIRED |
| m9 | merge took the PR's side: FOCUS_TOOL offered with journey off | voice only offers focus_on when journey is on (ask-shape) | FIRED |

Every run ended `restored: … matches HEAD` and `tree clean`. Output: `mut-loop4/mutations.out`, `mutations-rerun.out`.
9 FIRED, 0 INERT, 0 NOT-APPLIED (2 first attempts UNDETERMINED from mis-named tests, re-run and FIRED).

## Residuals (measured, for the owner -- not changed here)

- **Group leader differs from origin/main on 6 rows** (owner's hard group rule, pre-existing on the PR head, unchanged
  by this fix): O1/O2/O3 (warm + cold; "in NEXUS" / "in my NEXUS account" -- the trusted-traveler program -- reads as
  Nexus-the-app via the strong "in (my) Nexus" pattern, so Iris leads instead of Eli/Cole/Ezra), L8/S11/S12 (warm;
  meals / cooking with a course code -> Iris instead of Charleston/Tess). The 1:1 for all six = origin/main.
- **D13 consequence:** a non-override coursework ask in a 1:1 with another agent (e.g. P2 "my MGT-782 paper is due
  Friday" to Finn, "update the due date on my research paper" to Finn) no longer hands off deterministically. The
  directive is origin/main's keyword `laneOwnerFor` (for the second: Eli -- origin/main's existing behaviour) and the
  follow-up DM is the LLM judge's call. Loop-4 F2-41/42/43 are MET for explicit Nexus writes and keep-by-holder; the
  "Finn always hands coursework to Elle/Iris" reading is withdrawn by the owner's rule.
- The chat-path LLM judge receives the prime-owners hint (as instructed), so it is not byte-identical to origin/main's
  prompt; it is advisory, the keep-with-the-addressed-agent default is unchanged, and no offline probe can observe it.
- Not overrides by design (not in the owner's verb/noun lists): "upload/import the syllabus … to Nexus", "add this
  syllabus's deadlines to Nexus" -- they take the ordinary 1:1 path (group still led by Elle/Iris).
- O6/O7 (mixed asks containing a clause-initial explicit Nexus assignment write) still hand off -- the verifier rated
  these acceptable / same as main.
- `scripts/focus.test.ts` F22 fails (24 passed, 1 failed) **on origin/main itself** (measured on a `git archive
  origin/main` export): #124 made the voice `raw` list multi-line and F22 still greps the old one-line shape. Not
  touched here; the FOCUS_TOOL journey gate itself is guarded by ask-shape (m9 FIRED).

## Group-veto rows (resolves the first residual above: the 6 GROUP leaders that differed from origin/main)

**Change, data only, `src/features/huddle/data/agents.ts`** (no routing/capabilities code, no agent names):
- `NEXUS_PROGRAM_WORDS` = account, passport, vehicle, membership, renewal, interview, enrollment, enrolment, global
  entry, border -- the NEXUS trusted-traveler program's vocabulary. ONE list, used twice: appended to the shared
  `NEXUS_NOT_THE_APP` lookahead ("Nexus" right before one of them is not the app; the strong pattern AND the explicit
  override both read it), and as a new clause veto `NEXUS_PROGRAM_CLAUSE` on the coursework capability ("nexus" and a
  program word in the same clause, either order, within 80 chars). The clause form is needed because O1 ("in NEXUS
  before my next border crossing") and O2 ("my interview in NEXUS") put the word away from, or before, "Nexus". The
  explicit override is still checked before every veto.
- Dining / food veto group gains meal, meals, meal prep, cook, cooking, recipe, groceries, grocery, snack
  (grocery/groceries were already household vetoes; listed in both).

**Before -> after (GROUP leader; `mut-loop4/measure-d13.fixed.out` -> `mut-group-veto/measure-d13.after.out`):**

| Row | Ask | Cache | Before | After | origin/main |
|---|---|---|---|---|---|
| O1 | update my address in NEXUS before my next border crossing | warm + cold | iris-chase | eli-vaughn | eli-vaughn |
| O2 | reschedule my interview in NEXUS, I can't make the 14th | warm + cold | iris-chase | cole-blake | cole-blake |
| O3 | change my vehicle info in my NEXUS account | warm + cold | iris-chase | ezra-miles | ezra-miles |
| L8 | plan my meals for MGT-782 exam week | warm | iris-chase | charleston-lewis | charleston-lewis |
| S11 | meal prep for my MGT-782 exam week | warm | iris-chase | charleston-lewis | charleston-lewis |
| S12 | what should I cook the night before my MGT-782 exam | warm | iris-chase | tess-sutton | tess-sutton |

All 27 D13 rows x warm/cold: group, `laneOwnerFor` and prime hand-offs byte-identical to `measure-d13.main.out`
(`diff` of the first five columns is empty).

**Tests (`scripts/nexus-write-routing.test.ts`, 1224 -> 1303):** the 6 rows' group columns re-measured; every R13 row
now also asserts `group = origin/main leader` (54); `R13-G6-*` asserts the six rows match NO coursework capability and
lead as origin/main, warm and cold (24 + 1 presence check). No assertion was weakened; every coursework positive and
every explicit-override positive passes unchanged.

**Suites:** nexus-write-redteam 39/0, router-redteam 12/0, nexus-write-tool 115/0, router-winners 39/0, nexus-read-tools
190/0, cross-app-turn-gate 92/0, voice-toolset-hidden 36/0, nexus-write-fix 51/0, nexus-write-loop2 185/0,
nexus-write-loop3 315/0, nexus-write-voice-gate 43/0, nexus-write-routing 1303/0; #124 ownership-judge /
assign-on-create / ask-shape / board-delete ALL PASS; `npx tsc --noEmit -p .` exit 0.

**Mutations** (`mut-group-veto/run-mutations.sh`, anchors cut from source by `mut-group-veto/make-anchors.py`; output
`mut-group-veto/mutations.out`; each run ended `restored: … matches HEAD` and `tree clean`):

| id | Defect reinstated | Named test | Verdict (verbatim) |
|---|---|---|---|
| v1 | dining/food group's new words removed | R13-G6-L8 warm group | FIRED |
| v2 | `NEXUS_PROGRAM_CLAUSE` veto removed | R13-G6-O2 warm group | FIRED |
| v3 | `NEXUS_PROGRAM_WORDS` back to membership + interview only | R13-G6-O1 warm group | FIRED |

**Collateral, measured on asks outside the suite** (`bun mut-group-veto/probe-edges.ts <tree>`, PR head ->
this fix: `mut-group-veto/probe-edges.{before,after}.out`), for the owner:
- "add my essay to my Nexus account" is **no longer an explicit override** (the shared lookahead now reads "Nexus
  account" as the program); group leader unchanged (elle-rowan). Removing "account" from the list would restore it
  and O3 would still match origin/main through "vehicle".
- "my MGT-782 interview assignment is due in Nexus": group iris-chase -> **cole-blake** (the clause veto on
  "interview"). "add my interview reflection paper to Nexus" is unaffected (the override still wins).
- "log into my Nexus account and check what's due": group iris-chase -> **tess-sutton**.
- Coursework whose TOPIC is food ("essay on meal kit startups", "paper on the cooking industry", "the recipe for
  success essay") no longer matches the capability, but the keyword router still leads with Elle/Iris (unchanged
  group). "case study on grocery pricing" was already vetoed by the household group before this change.

## D14 — override needs Nexus as the destination

**RESPONDS TO** `docs/VERIFY-nexus-write-tool-5.md` D14 (BLOCKING): `NEXUS_EXPLICIT_WRITE` read "write verb … assignment
noun … in Nexus" as a write TO Nexus when Nexus was the SOURCE or a side remark, and it runs before every veto
("add the exam dates in Nexus to my calendar", "set reminders for every assignment in Nexus", "move my flight home, my
exam in Nexus got moved to Monday", "move my workout to tomorrow so I can finish my paper in Nexus").

**Fix (data on the capability + one generic evaluator; no agent names):**

| Piece | Where | What |
|---|---|---|
| Clause boundary | agents.ts `NEXUS_OVERRIDE_CLAUSE_BREAK` -> `requiresContext.explicitOverrideClauseBreak` | the override is tested ONE CLAUSE at a time; a clause ends at `,` `;` a spaced/long dash, "so", "because", "and then", or a sentence end |
| Destination | `NEXUS_EXPLICIT_WRITE` branch (a) | "to / into (my) Nexus" anywhere after the assignment noun, or "in (my) Nexus" ONLY as the clause's last phrase, optionally followed by a date/time tail (`NEXUS_DATE_TAIL`: "to Dec 3", "for Friday", "by Nov 3 at 5pm", "due …") and courtesy words ("for me", "please", "now") |
| Competing destination / object | `NEXUS_OVERRIDE_CANCELS` -> `requiresContext.explicitOverrideCancels` | calendar(s), reminder(s), study block/session, schedule(s), flight(s), hotel(s), checkout(s), workout(s), budget(s), email(s) in the SAME clause cancel it -- unless the word is only an assignment's TOPIC (up to two content words, then an assignment noun: "the email marketing case analysis", "my hotel management essay", "the flight operations essay", "my hotel case study") |
| Not write verbs | `NEXUS_EXPLICIT_WRITE` verb list | `set` not followed by "up", "a reminder", "reminder(s)" |
| Purpose phrase | `NEXUS_EXPLICIT_WRITE` branch (a), lookbehind | an assignment noun introduced by "for (my/the …)" is not the thing written: "log the textbook I bought **for my MGT-782 project** in Nexus" (N8) writes a purchase. Added beyond the brief because N8 was otherwise the one remaining non-coursework diff; "update the due date for my MGT-701 proposal in Nexus to Dec 3" still overrides ("due date" is the object) |
| Evaluator | capabilities.ts `explicitOverrideMatches` | used by BOTH `capabilityContextPresent` (override before vetoes) and `capabilityExplicitOverride` (1:1 hand-off gate): split by the clause break, a clause counts iff an override pattern matches and no cancel pattern does |

**Acceptance -- verifier probes vs a `git archive origin/main` export (4bad00f)**, warm and cold
(`bash mut-d14/run-probes.sh <tree> <label> mut-d14/out`, `bash mut-d14/diff-probes.sh mut-d14/out main after`;
`mut-d14/probe-d14-all.ts` reruns every row of the three probes honouring cold, which `probe-l5-extra`/`probe-l5-f245`
do not). Compared: group leader and the 1:1 `laneOwnerFor` (the PR-only `prime` column stripped). Full diff:
`mut-d14/probe-diff.main-vs-after.out`; before this fix: `mut-d14/probe-diff.main-vs-before.out`.

| Probe | warm | cold |
|---|---|---|
| probe-l5-extra (E1-E6) | **empty** | **empty** |
| probe-l5-f245 (F1-F4) | **empty** | **empty** |
| probe-l5-routing / probe-d14-all, every D14 row (N1-N8, N10, N11, E1-E6, F1-F4) and every K / N12-N15 / N17 row | **empty** | **empty** |
| remaining rows that differ | N9, N16, P4, P5, P7, P8, P9 | N9, P4, P5, P7, P9 |

The remaining rows, precisely:
- **N9** "email my professor and then update the due date in Nexus" (Cam) -- the mixed ask. "and then" ends the email
  clause; the second clause "update the due date in Nexus" IS an explicit coursework write, so the override fires:
  GROUP **Elle** (origin/main Eli), Cam's 1:1 hands off to **Elle** (origin/main: Cam keeps). Same as before this fix;
  pinned as measured (`D14-N9`). Rule 2's competing word ("email") is in the OTHER clause, so it does not cancel.
- **N16** (warm only) "draft a pitch deck for my startup, the MGT-701 deadline is Friday" (Sam): group Elle vs main
  Sam. Pre-existing D13-class coursework GROUP rule (real course code + "deadline", no veto word), identical before
  this fix; not an override (prime `-`, lane = main). Not D14; not changed.
- **P4 P5 P7** are the intended explicit overrides (coursework writes into Nexus); **P8 P9** are coursework asks the
  coursework group rule leads (allowed by the owner's rule; 1:1 lane = main).

**Explicit-override positives** (`mut-d14/probe-units.out`; all still override; the full POS / OVR_POS / NOUNS sets in
`scripts/nexus-write-routing.test.ts` pass unchanged, warm and cold):

| Positive | override |
|---|---|
| add my essay to my Nexus account | true |
| put my travel industry essay due Nov 3 into Nexus | true |
| update the Airbnb pricing case study due date in Nexus | true |
| set the travel essay due date to Friday in Nexus | true |
| log the tax accounting paper due Friday in Nexus | true |
| add the MGT-782 email marketing case analysis to Nexus ("email" = topic) | true |
| can you add my hotel management essay to Nexus ("hotel" = topic) | true |
| move my hotel case study to Dec 4 in Nexus ("hotel" = topic; "to Dec 4" precedes "in Nexus") | true |
| add the flight operations essay to my Nexus assignments ("flight" = topic) | true |
| save the email marketing paper to my Nexus ("email" = topic) | true |
| please reschedule the budgeting case study to Dec 2 in Nexus | true |
| change the client presentation paper deadline in Nexus to Monday (date tail) | true |
| update the due date for my MGT-701 proposal in Nexus to Dec 3 (date tail; object before "for") | true |
| add my MGT-782 reflection paper to Nexus, due Sunday (clause 1) | true |

No positive conflicted with rules 1/2; none was weakened.

**Tests (`scripts/nexus-write-routing.test.ts`, 1315 -> 1545):** `D14-*` -- the 20 D14 rows (N1-N8, N10, N11, E1-E6,
F1-F4) x warm/cold x {not an override, group = origin/main, 1:1 lane = origin/main, no prime hand-off from ANY agent,
the addressed agent answers its 1:1}; expected values GENERATED from the main export by `mut-d14/gen-rows.py`, not
typed. `D14-N9` pins the mixed ask as measured. Unit rows `D14-clause` / `D14-dest` / `D14-cancel` / `D14-for` /
`D14-set` and `D14-data` (both new fields are DATA on the capability). One assertion re-shaped, not weakened:
`R-X-order` greps the override-before-vetoes order and now matches `if (explicitOverrideMatches(ctx, raw)) return true;`
(the override is no longer a bare `anyPattern` call); the order it asserts is unchanged.

**Suites** (`mut-d14/suites.out`): nexus-write-redteam 39/0, router-redteam 12/0, nexus-write-tool 115/0,
router-winners 39/0, nexus-read-tools 190/0, cross-app-turn-gate 92/0, voice-toolset-hidden 36/0, nexus-write-fix 51/0,
nexus-write-loop2 185/0, nexus-write-loop3 315/0, nexus-write-voice-gate 43/0, nexus-write-routing 1545/0; #124
ownership-judge (15 PASS), assign-on-create (52), ask-shape (69), board-delete (6) ALL PASS; `npx tsc --noEmit -p .`
exit 0 (`mut-d14/tsc.out` empty).

**Mutations** (`bash mut-d14/run-mutations.sh`, anchors cut from source and count-checked by
`mut-d14/make-anchors.py`; output `mut-d14/mutations.out`):

| id | Defect reinstated | Named test | Verdict (verbatim) |
|---|---|---|---|
| m1 | clause boundary removed (`explicitOverrideClauseBreak` dropped: whole ask = one clause) | `D14-clause "add my reading list, the essay is in Nexus"` | see mutations.out |
| m2 | destination requirement removed ("in (my) Nexus" anywhere, the loop-4 shape) | `D14-dest "add my essay in Nexus to the shared folder"` | see mutations.out |
| m3 | competing-destination cancel removed (`explicitOverrideCancels` dropped) | `D14-cancel "add a reminder about my essay to Nexus"` | see mutations.out |
| m4 | purpose ("for my … project") lookbehind removed | `D14-for "log the textbook I bought for my MGT-782 project in Nexus"` | see mutations.out |

**Collateral, measured on asks outside the suite** (`bun mut-d14/probe-edges.ts <tree>`, PR head ec6127a -> this fix:
`mut-d14/out/probe-edges.{before,after}.out`). Four asks NO LONGER override (deterministic 1:1 hand-off from a
non-holder lost; the ordinary 1:1 owner path decides, as on origin/main); the GROUP leader is unchanged in all four:
- "add my essay in Nexus for Friday's class" ("for Friday's class" is not a pure date tail)
- "update the paper in Nexus to reflect the new rubric" ("in Nexus" is not the last phrase)
- "add the notes for my case study to Nexus" (noun introduced by "for"; the object is "notes")
- "add the exam to my schedule and to Nexus" (competing destination "schedule" in the same clause, per rule 2)
Still overriding: "… in Nexus please / for me / now", "… in Nexus to the 14th / to next Friday / by Nov 3", "…, it's due
Friday", "… so Iris can track it", "… because it's due Sunday", "… - due Monday", "add my study session reflection to
Nexus", "add my workout essay to Nexus" (topic exemptions).

**Not touched:** D15 (Elle/Iris "keep" on another lane's coursework-shaped ask) -- owner-visible decision, separate.
The `routerHint` prose for the LLM routers is unchanged.
