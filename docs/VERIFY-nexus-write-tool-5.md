# VERIFY nexus-write-tool, loop 5 — pre-merge independent re-verification of huddle PR #114 (head ec6127a)

<!--
WHAT:          Independent, offline, pre-merge re-verification of PR #114 (branch claude_nexus-write-tool-fixed,
               head ec6127a): M0 + per-claim verdicts C1..C9 with observed evidence, every defect classified
               BLOCKING / NON-BLOCKING with realistic likelihood.
WHY:           Loop 4 (docs/VERIFY-nexus-write-tool-4.md) returned REFUTED on M0 (conflict with origin/main #124)
               and D13 / D13-ovr (deterministic 1:1 lane steals). Fixers (docs/FIX-nexus-write-loop4.md) report all
               three fixed. This is the check before the owner's merge.
SUPERSEDES:    nothing. FOLLOWS docs/VERIFY-nexus-write-tool-4.md (branch claude_verify-nexus-write-tool-4).
SUPERSEDED-BY: nothing -- current.
EVIDENCE:      this file; probes, outputs, mutation anchors in mut-verify-114-5/ on branch
               claude_verify-nexus-write-tool-5. Offline only: fetch mocked, no live Nexus/Huddle, no DB/board writes.
-->

Started 2026-10-29 13:27 UTC (budget 40 min, ends 14:07). Worktree branch `verify-nexus-write-tool-5` from
`origin/claude_nexus-write-tool-fixed` @ `ec6127a`. Written as the work goes.

## M0 — merge with origin/main

- `git merge-tree --write-tree origin/claude_nexus-write-tool-fixed origin/main` -> **exit 0** (no conflict).
- `git merge --no-edit origin/main` on the checkout -> `Already up to date.` (a no-op): `origin/main` @ `4bad00f`
  is already an ancestor of `ec6127a` (`git merge-base --is-ancestor` exit 0; `rev-list --left-right` 0/0).
  So every check below ran on a tree that already contains origin/main. **M0: CONFIRMED** (loop-4 M0 resolved).
- The two loop-4 conflict sites, read on ec6127a: covered in C4/C8 below (voice `raw` union; `resolveOwnerLLM` opts).

## C7 — suites + tsc (re-run, not trusted)

`bash scripts/run-nexus-fix-suites.sh` -> EXIT 0 (`mut-verify-114-5/suites.out`): redteam 39/0, router-redteam 12/0,
nexus-write-tool 115/0, router-winners 39/0, nexus-read-tools 190/0, cross-app-turn-gate 92/0, voice-toolset-hidden
36/0, fix 51/0, loop2 185/0, loop3 315/0, voice-gate 43/0, **routing 1315/0**. #124 suites on the PR tree:
ownership-judge ALL PASS, assign-on-create ALL PASS, ask-shape ALL PASS, board-delete ALL PASS.
`npx tsc --noEmit -p .` -> exit 0, no output (`tsc.out`).

`scripts/focus.test.ts`: PR tree 24 passed / 1 failed (`FAIL F22 a voice call to Iris can do it too`);
**`git archive origin/main` export: identical 24/1, same F22**. F22 greps the one-line `[PRIORITIZE_TOOL, FOCUS_TOOL,`
which #124 made multi-line. **Pre-existing on origin/main, not caused by #114.** **C7: CONFIRMED.**

## C2 / C5 / C6 / C3 — loop-4 probes re-run on ec6127a

| Probe (copied verbatim into mut-verify-114-5/) | Result vs loop 4's stored output |
|---|---|
| `l3-probe-exec.ts` (C5 owner/URL/body/headers, C6 read-only, C2 canonicalisation/dedup/update) | **byte-identical** (`diff` empty) |
| `l3-probe-voice.ts` (C3 voice gate) | **byte-identical** |
| `probe-c9-voice.ts` (C3 W1-W6 orders) | **byte-identical** (W4 residual unchanged) |

**C2: CONFIRMED. C5: CONFIRMED. C6: CONFIRMED. C3: CONFIRMED as scoped** (residuals W4 very low, H15 owner-accepted,
unchanged).

## C4 — routing vs origin/main 4bad00f: loop-4 rows re-derived on ec6127a

Loop-4 probes re-run on the PR tree and on a `git archive origin/main` export (`*.l5pr.out` vs `*.l5main.out`):

- `probe-c9-steal2` (S1-S14): **PR output == main output** (`diff` empty). `probe-c9-names`: identical.
- `probe-c9-routing` (O1-O15, L1-L15, P1-P3): every L row (the 18 D13 vocabulary steals) and O3/O4/O8 (the 3 D13-ovr
  steals) now give **the same group leader, `prime=-` and the same `laneOwnerFor` as main**. Remaining diffs are
  intended coursework writes: O12/O14/P1/P3 (explicit "… into/to/in Nexus" of an assignment -> Iris/Elle), and
  O6/O7 (mixed "email/text my professor … add/update … in Nexus"): O6's lane on main is also Elle; O7 hands off on
  both (main -> Eli, PR -> Elle) -- not a new steal from Cam.
- `l3-probe-routing`: only diff is P1's prime/lane (intended) and the PR-only cache block.

**D13 as reported: fixed. D13-ovr as reported (O3/O4/O8): fixed.** The override now requires an assignment noun
(`NEXUS_ASSIGNMENT_OBJECTS`), "account" is not a program word, and the 1:1 deterministic hand-off is gated by
`oneToOneHandoff: "explicit-override"` (capabilities.ts `capabilityHandsOffInOneToOne`).

## C9 — NEW realistic owner phrasings (`probe-l5-routing.ts`, warm + cold, vs main; `probe-l5-extra.ts`)

Columns: PR warm | PR cold | origin/main. "1:1 steal" = PR deterministically hands off (directive "not your lane" +
durable follow-up DM) where main's `laneOwnerFor` keeps the ask with the addressed agent.

| Tag | Ask (addressed) | PR warm prime | PR cold prime | main lane | PR group / main group | Verdict |
|---|---|---|---|---|---|---|
| N1 | "set a reminder to submit my MGT-782 paper in Nexus Friday" (Eli) | elle | elle | keep | elle / elle | **1:1 steal** |
| N2 | "add the exam dates in Nexus to my calendar" (Eli) | iris | iris | keep | iris / iris | **1:1 steal** |
| N3 | "put the due dates in Nexus on my calendar" (Eli) | iris | iris | keep | iris / iris | **1:1 steal** |
| N4 | "add my essay deadline in Nexus to my calendar" (Eli) | elle | elle | elle | elle / elle | same as main |
| N5 | "move my workout to tomorrow so I can finish my paper in Nexus" (Flex) | iris | iris | keep | **iris / flex** | **1:1 + GROUP steal** |
| N6 | "reschedule my study session, the exam in Nexus moved to Friday" (Eli) | iris | iris | keep | **iris / eli** | **1:1 + GROUP steal** |
| N7 | "save me some dinner, I'm finishing my essay in Nexus" (Charleston) | elle | elle | elle | elle / elle | same as main (main also hands off) |
| N8 | "log the textbook I bought for my MGT-782 project in Nexus" (Finn) | iris | iris | keep | iris / iris | 1:1 differs; explicit "log … in Nexus" -- ambiguous |
| N9 | "email my professor and then update the due date in Nexus" (Cam) | elle | elle | keep | elle / **eli** | mixed ask; coursework clause -- acceptable |
| N10 | "set up a study block tonight for the exam in Nexus" (Eli) | iris | iris | keep | iris / iris | **1:1 steal** |
| N11 | "add the MGT-782 exam to my calendar, it's listed in Nexus" (Eli) | iris | iris | keep | iris / iris | **1:1 steal** |
| E1 | "add my assignments in Nexus to my calendar" (Eli) | iris | (n/a) | keep | -- | **1:1 steal** |
| E5 | "add all my paper deadlines in Nexus to my Google calendar" (Eli) | elle | -- | keep | -- | **1:1 steal** |
| E6 | "set reminders for every assignment in Nexus" (Eli) | iris | -- | keep | -- | **1:1 steal** |
| E2-E4 | "add everything due in Nexus…", "put my Nexus due dates on my calendar", "copy the exam dates from Nexus to my calendar" (Eli) | - | -- | keep | -- | same as main |
| N12-N15, N17 | text group / coffee / coworking spot / exam fee / PRD (Cam, Charleston, Troy, Finn, Tess) | - | - | keep | same | same as main |
| N16 | "draft a pitch deck for my startup, the MGT-701 deadline is Friday" (Sam) | - | - | keep | **elle (warm) / sam**; cold sam | 1:1 same; GROUP differs warm (course deliverable? ambiguous) |
| P4, P5, P7 | explicit "add/put/update <assignment> … to/into/in Nexus" (Finn, Cam, Sam) | iris/elle | same | keep | iris/elle | intended hand-off (owner's override) |
| P6 | "add my essay to my Nexus account" (Troy) | elle | elle | elle | elle / elle | **override works** (owner decision, "account" not a program word) |
| P8 | "help me outline my MGT-782 strategy paper due Friday" (Finn) | - | - | keep | iris (warm) / liam | 1:1 = main (D13 rule); group = coursework (allowed) |
| P9 | "what's due in Nexus this week" (Iris) | keep | keep | keep | iris / tess | coursework, allowed |
| K1-K9 | D13 vocabulary asks (room, ride, send/share slides, order textbook, stretch, "the calendar", babysitter, "onto my schedule") addressed to **Iris/Elle** | **keep** | - (no holder cold) | keep (`laneOwnerFor` null) | same | see D15 |
| K10 | N1 addressed to Iris | keep | keep | keep | elle / elle | fine |

**D14 (new, D13-ovr class): the explicit override reads "in Nexus" as the write destination even when Nexus is the
SOURCE and the destination is the calendar / a reminder / a workout.** `NEXUS_EXPLICIT_WRITE` = clause-initial
write verb (add/put/set/move/save/reschedule/log …) + an assignment noun anywhere in 80 chars + `(to|in|into) (my)
nexus`. "add the exam dates **in Nexus** to my calendar" satisfies it ("add" … "exam" … "in Nexus"), and the override is
checked BEFORE every veto (so "my calendar", "reminder", "workout", "study session", "dinner" vetoes never run). In a
1:1 with Eli/Flex this is a deterministic "this is Iris's lane, do not answer" + follow-up DM; main keeps all of them
with the addressed agent. 10 of the 17 override-shaped other-lane asks above steal (N1 N2 N3 N5 N6 N10 N11 E1 E5 E6);
N5 and N6 also move the GROUP leader (Flex -> Iris, Eli -> Iris), which the owner's rule permits only for coursework.
Not caught: "from Nexus", "my Nexus due dates", "everything due in Nexus" (no assignment noun). **C4: REFUTED (D14).
C9: REFUTED (D14; D15 below).**

**D15 (pre-existing since loop 3, not probed by loop 4): Elle/Iris addressed in a 1:1 with another lane's ask that
matches the coursework capability (course code + exam/deadline, no veto word) return `"keep"`.** On the 1:1 path
(huddle.functions.ts:6890-6897) `keep` means no follow-up and the semantic `resolveOwnerLLM` judge is never called;
on main the judge runs (it may DM Troy/Finn/Flex/Cam). The directive (`laneOwnerFor`) is null on both trees, so
Iris/Elle answer on both; the only difference is a suppressed LLM-judged follow-up DM. Warm cache only.

**F2-45 / travel-finance-fitness rows with the D14 shape** (`probe-l5-f245.ts`, PR vs main):

| Ask (addressed) | PR group / prime | main group / lane |
|---|---|---|
| "move my flight home, my exam in Nexus got moved to Monday" (Troy) | **iris / iris** | troy / keep |
| "change my hotel checkout, the final exam in Nexus is Saturday now" (Troy) | **iris / iris** | troy / keep |
| "move my run to the evening so I can finish my essay in Nexus" (Flex) | elle / elle | elle / elle (same) |
| "set a budget for the textbooks for my projects in Nexus" (Finn) | **iris / iris** | finn / keep |

A comma does not end the override's clause (`[^.?!;\n]`), so "move my flight home, my exam in Nexus …" reads as
"move … exam … in Nexus". The `flight`/`hotel`/`budget` vetoes never run because the override is checked first.

## C8 — mutations (mutate.sh; anchors cut from source and count-checked by `mut-verify-114-5/make-anchors.py`;
runner `run-mutations.sh`; output `mutations.out`)

| id | Defect reinstated | Suite | Named test | Verdict (verbatim) |
|---|---|---|---|---|
| r1 | `capabilityHandsOffInOneToOne` ignores the `oneToOneHandoff` flag (always hands off) | nexus-write-routing | `Finn makes no deterministic hand-off` | FIRED |
| r2 | override without the assignment-noun group (any object, loop-4 shape) | nexus-write-routing | `R13-ovr-neg` | FIRED |
| r3 | `primeHint` for every non-assigned `resolveOwnerLLM` caller (task creation gets the hint) | nexus-write-routing | `R-M0-task creation` | FIRED |
| r4 | merge takes main's side: voice `raw` loses `...nexusWriteTools()` | nexus-write-tool | `voice toolset pushes the write tools` | FIRED |
| r5 | merge takes the PR's old side: FOCUS_TOOL offered with journey off | ask-shape | `voice only offers focus_on when journey is on` | FIRED |
| r6 | "account" put back in `NEXUS_PROGRAM_WORDS` | nexus-write-routing | `add my essay to my Nexus account` | FIRED |
| r7 | `oneToOneHandoff: "explicit-override"` removed from the capability DATA | nexus-write-routing | `R13-ovr-data` | FIRED |

Every run printed `restored: … matches HEAD` and `tree clean: … passes again`. **7 FIRED, 0 INERT, 0 NOT-APPLIED.**
r1, r2, r3, r4, r5 are the five loop-4 guards named in the brief. r4 and r5 are caught only by source-shape regexes
(`F2-31 (2)` greps the `raw` list; ask-shape greps the FOCUS line); r1/r2/r3/r6/r7 are caught behaviourally.
**C8: CONFIRMED.**

### Rewritten assertions — legitimacy

| Test | Before (38e1b17) | After (ec6127a) | Judgement |
|---|---|---|---|
| L2-D5g / L3-D6g | 1:1 Finn hands every coursework row to Elle/Iris (`laneOwnerFor`) | Elle/Iris only when `capabilityExplicitOverride`, else `primeLaneDecision === null` | Legitimate: implements the owner's D13 rule. Narrower: the non-override branch asserts no PRIME hand-off but not equality with main's `laneOwnerFor` (R13 rows do check main equality for the D13 rows). |
| R-CW (R-X rows) | 1:1 Finn hands each to Elle/Iris | same D13 rule | Legitimate (same rule). |
| F2-43 | `laneOwnerFor` never names a third lane | `primeLaneDecision` never names a third lane | Legitimate but narrower: non-override coursework now takes main's `laneOwnerFor`, which can name a third lane (e.g. Eli for a due-date ask) -- owner-accepted residual in FIX-nexus-write-loop4.md. |
| R-A4 | prime directory in every 1:1 resolver prompt | only with `{ primeHint: true }` + R-M0 variants | Legitimate, strengthened (r3 FIRED). |

None of the rewrites hides D14: the suite has no row where Nexus is the SOURCE and another lane's object is the
destination. Its OVR_POS list itself contains "move my hotel case study to Dec 4 in Nexus" (Troy) as an intended
override, which is a coursework object -- fine -- but the same shape with a non-coursework object
("move my flight home, my exam in Nexus …") is untested.

## C1 — Feature 2 ACs

F2-41/42/43 MET as the owner re-scoped them (P1/P4/P5/P7 hand off on explicit writes; P8/P2 do not; Elle/Iris keep).
F2-35 MET (C3 unchanged). **F2-45 NOT MET**: "move my flight home, my exam in Nexus got moved to Monday" and "change my
hotel checkout, the final exam in Nexus is Saturday now" (Troy) and "set a budget for the textbooks for my projects in
Nexus" (Finn) lead the GROUP with Iris and hand off deterministically in the 1:1, where main keeps Troy/Finn; Flex's
"move my workout to tomorrow so I can finish my paper in Nexus" likewise (group Flex -> Iris). F2-10/F2-14 "shared
with F1" NOT MET by construction (cross-repo, unchanged since loop 1). **C1: REFUTED (F2-45 via D14).**

## Defects (pre-merge classification)

| # | Defect | Class | Likelihood | Repro |
|---|---|---|---|---|
| **D14** | Explicit override reads "in Nexus" as the write DESTINATION when Nexus is the source or a side remark, and runs before every veto; a comma does not end the clause. Eli: "add my assignments in Nexus to my calendar", "add the exam dates in Nexus to my calendar", "set reminders for every assignment in Nexus", "reschedule my study session, the exam in Nexus moved to Friday"; Troy: "move my flight home, my exam in Nexus got moved to Monday"; Finn: "set a budget for the textbooks for my projects in Nexus"; Flex: "move my workout to tomorrow so I can finish my paper in Nexus". 1:1 = deterministic "not your lane" directive + follow-up DM to Iris/Elle; 6 rows also move the GROUP leader. main keeps every one. | **BLOCKING** (other lane's ask taken, group and 1:1) | **moderate** for the calendar phrasing (pulling Nexus dates into a calendar is an everyday student ask to the calendar agent); low-moderate for the travel/fitness/finance side-remark shapes. Deterministic -- reproduces every time, warm and cold. | `bun mut-verify-114-5/probe-l5-routing.ts <tree> warm|cold`, `probe-l5-extra.ts`, `probe-l5-f245.ts` (PR vs main export) |
| D15 | Elle/Iris addressed in a 1:1 with another lane's ask that matches the coursework capability (course code + exam/deadline, no veto) -> `keep`: no follow-up and no LLM owner judge; main runs the judge (may DM Troy/Finn/Cam/Flex). Who answers is the same on both trees. Pre-existing (loop 3), not introduced by the loop-4 fix. | NON-BLOCKING (no wrong row, no false claim, the addressed agent answers on both) | low-moderate (needs Elle/Iris addressed with another lane's ask) | `probe-l5-routing.ts` rows K1-K9 |
| N16 | "draft a pitch deck for my startup, the MGT-701 deadline is Friday": GROUP Elle (warm) vs main Sam; cold = Sam; 1:1 same | NON-BLOCKING (arguably a course deliverable -- owner's call) | low | `probe-l5-routing.ts` N16 |
| W4, H15, O13, q6-cov, D7-gap/over, D8-far | unchanged from loop 4 (probes byte-identical) | as loop 4 | as loop 4 | loop-4 probes |
| focus F22 | `scripts/focus.test.ts` F22 fails 24/1 | **pre-existing on origin/main** (identical failure on a `git archive origin/main` export); not #114 | n/a | `bun scripts/focus.test.ts` on both trees |

Fixed and confirmed this loop: **M0** (merge-tree exit 0; main already an ancestor), **D13** (all 18 vocabulary rows =
main), **D13-ovr** (O3/O4/O8 = main), **#124 `resolveOwnerLLM`** (prime hint only via `primeHint: true` on the chat
hand-off; r3 FIRED; grooming/task creation never get it -- R-M0-site checks pass).

## Verdict

| Claim | Verdict |
|---|---|
| M0 merge with origin/main | CONFIRMED (merge-tree exit 0; `git merge` no-op) |
| C1 F2 ACs | REFUTED (F2-45 via D14) |
| C2 owner rules | CONFIRMED (loop-4 probe byte-identical) |
| C3 honesty | CONFIRMED as scoped (byte-identical; residual W4 very low, H15 owner-accepted) |
| C4 routing | REFUTED (D14; D13 and D13-ovr as reported are fixed) |
| C5 identity/url/headers | CONFIRMED |
| C6 read-only | CONFIRMED |
| C7 suites + tsc | CONFIRMED (12 suites incl. routing 1315/0; #124's 4 suites ALL PASS; tsc 0; focus F22 pre-existing on main) |
| C8 mutations | CONFIRMED (7/7 FIRED, incl. the 5 named loop-4 guards) |
| C9 new realistic phrasings | REFUTED (D14 on 10 of 17 override-shaped other-lane asks + 3 of 4 F2-45 rows; D15 NON-BLOCKING) |

**Overall: REFUTED -- one BLOCKING defect (D14).** The write path, the voice gate, owner/URL/header pinning, the
merge with main, the D13 vocabulary fix and the #124 primeHint scoping all hold. What does not: the explicit-override
pattern (checked before every veto, in group and 1:1) treats "… <assignment noun> … in Nexus" as a write to Nexus even
when the request is to put Nexus dates on the calendar, move a flight, or set a budget.
