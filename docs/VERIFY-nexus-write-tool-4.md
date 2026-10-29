# VERIFY nexus-write-tool, loop 4 — final independent re-verification of huddle PR #114 (head 38e1b17)

<!--
WHAT:          Independent, offline re-verification of PR #114 (branch claude_nexus-write-tool-fixed, head
               38e1b17) after the routing (D12) + voice-gate (V1-V5) fix passes: per-claim verdicts C1..C9 with
               observed evidence, every defect classified BLOCKING / NON-BLOCKING with realistic likelihood.
WHY:           Loop 3 (docs/VERIFY-nexus-write-tool-3.md) returned REFUTED on D12 (course-code + deadline word
               captured other lanes' asks). Fixers (docs/FIX-nexus-write-routing.md, docs/FIX-nexus-write-voice-gate.md)
               report D12 and V1-V5 fixed. FINAL check before the owner's merge.
SUPERSEDES:    nothing. FOLLOWS docs/VERIFY-nexus-write-tool-3.md (branch claude_verify-nexus-write-tool-3).
SUPERSEDED-BY: nothing -- current.
EVIDENCE:      this file; probes + mutation anchors in mut-verify-114-4/ on branch claude_verify-nexus-write-tool-4.
               Offline only: fetch mocked, no live Nexus/Huddle, no DB or board writes.
-->

Started 2026-10-29 12:53 UTC (budget 45 min, ends 13:38). Worktree branch `verify-nexus-write-tool-4` from
`origin/claude_nexus-write-tool-fixed` @ `38e1b17`. Written as the work goes.

## M0 — merge state (radius challenge: origin/main moved)

`git fetch` showed `origin/main` advanced `ee8f7b6..4cb2273` (#124 "One ownership judge (task creation +
grooming) and a board Delete action", 2026-10-29 08:45 ET). `git merge-tree --write-tree --name-only
origin/claude_nexus-write-tool-fixed origin/main` -> exit 1:

```
CONFLICT (content): Merge conflict in src/features/huddle/lib/routing.ts
CONFLICT (content): Merge conflict in src/features/huddle/lib/voice/realtime-tools.server.ts
```

Both files are inside this fix's blast radius (C3, C4). **PR #114 at 38e1b17 cannot be merged as-is**; whoever
resolves the conflict changes code no loop has verified, and #124 changes `resolveOwnerLLM` -- the 1:1 judge this
PR's prime-owner hint is appended to. Classified **BLOCKING for the merge** (not a behaviour defect of 38e1b17).
Conflict hunks are analysed under C4 below.

## C7 — suites + tsc

`bash scripts/run-nexus-fix-suites.sh` (node_modules symlinked from the main checkout):

| Suite | Observed |
|---|---|
| nexus-write-redteam | exit 0, ALL PASS: 39 passed, 0 failed |
| router-redteam | exit 0, 12 passed, 0 failed |
| nexus-write-tool | exit 0, ALL PASS: 115 passed, 0 failed |
| router-winners | exit 0, 39 passed, 0 failed |
| nexus-read-tools | exit 0, ALL PASS: 190 passed, 0 failed |
| cross-app-turn-gate | exit 0, 92 passed, 0 failed |
| voice-toolset-hidden | exit 0, 36 passed, 0 failed |
| nexus-write-fix | exit 0, ALL PASS: 51 passed, 0 failed |
| nexus-write-loop2 | exit 0, ALL PASS: 185 passed, 0 failed |
| nexus-write-loop3 | exit 0, ALL PASS: 315 passed, 0 failed |
| nexus-write-voice-gate | exit 0, ALL PASS: 43 passed, 0 failed |
| nexus-write-routing | exit 0, ALL PASS: 825 passed, 0 failed |

`npx tsc --noEmit -p .` -> exit 0, no output. Matches the fixers' reported counts (routing 825, voice-gate 43,
loop3 315, loop2 185). **C7: CONFIRMED** (on 38e1b17; not on a merge with 4cb2273, which does not exist yet).

## C5 / C6 / C2 — loop-3 probes re-run (unchanged)

`bun mut-verify-114-4/l3-probe-exec.ts` (loop-3 `probe-exec.ts`, copied verbatim) on 38e1b17: rc 0, output
**byte-identical** to loop 3's `mut-verify-114-3/probe-exec.out` (`diff` empty). That probe carries C5 (one
server owner on every POST/PATCH/GET, literal URL, whitelisted body, model identity keys dropped, headers), C6
(read tools never write) and C2 (owner's meeting/deliverable canonicalisation, course-zone dedup, stored-title
update). **C5: CONFIRMED. C6: CONFIRMED. C2: CONFIRMED** (unchanged since loop 3, residual vocabulary edges as
loop 3 recorded).

## C3 — honesty (text + voice)

`bun mut-verify-114-4/l3-probe-voice.ts` vs loop 3's output: identical except the V1 block, which changed from
the loop-3 defect to the fix:

| V1 (executor throw `{error,tool}`) | loop 3 | loop 4 (38e1b17) |
|---|---|---|
| `holding` after output | false | **true** |
| finalize("Done — your Research Proposal is in Nexus…") | streamed raw + empty "Saved in Nexus:" | **"Nexus write status: • Not saved: the whole write request — TypeError: boom …" (whole)** |

Server side: `realtime-tools.server.ts` throw now returns ok:false (commit 02944b8). Hook lifecycle (read in the
diff ebd805b..38e1b17): `cleanup()` and `connect()` each install a fresh gate (V3/V4); the write's `.then` settles
the gate captured at the call BEFORE the hang-up early-return (V3); `sendText` resets (V2); a keyed reset at
`input_audio_buffer.committed` (V5).

New orders (`bun mut-verify-114-4/probe-c9-voice.ts`, output in `probe-c9-voice.out`):

| # | Order | Result |
|---|---|---|
| W1 | barge (committed B) while write pending, write fails, model says "Done, saved." | failure message spoken (whole); late transcription(B) no-op; next exchange streams normally -- correct |
| W2 | committed A, write fails, LATE transcription(A) before delivery | holding true; "All set, it is in Nexus." replaced by failure message -- correct (V5 fixed) |
| W3 | W2 with item_id missing (unkeyed) | holding true; replaced -- correct |
| W4 | failure spoken, then an ECHO commit (agent's own voice re-committed), then a 2nd text.done "Actually it is saved now." | **mode none, full text -> streamed raw.** Before 38e1b17 that text was suppressed ("the failure message was the exchange's only words"). The committed handler (hook :509) has no echo filter, unlike the transcription handler (:524-527). |
| W5 | typed reset during a pending write that times out | "Saved!" replaced by "Unknown — check Nexus"; typed reply then streams -- correct |
| W6 | success delivered, second write fails, "Both are in Nexus." | replaced by Saved + Not saved list -- correct |

W4 needs the mic to re-commit the agent's own audio AND the model to then contradict its own failed tool output;
it is the H15 class (a claim made with no failed result in the current exchange). **C3: CONFIRMED as scoped**,
residual W4 (NON-BLOCKING, very low) and H15 (owner-accepted).

## C4 / C9 — routing vs origin/main (4cb2273), loop-3 D12 rows + NEW adversarial inputs

Loop-3 `probe-routing.ts` re-run on 38e1b17 and on a `git archive origin/main` export: every one of the 13 D12
other-lane rows now has `prime=null` and the same group leader / 1:1 lane as origin/main
(`l3-probe-routing.{pr,main}.out`). Coursework rows still route to Iris/Elle. **D12 as reported: fixed.**

How the 1:1 path consumes it (huddle.functions.ts:2466 directive, :6835 follow-up): `primeLaneDecision` is
evaluated BEFORE `resolveOwnerLLM` and is deterministic; a non-null holder produces both the "this is X's lane,
do not answer" directive to the addressed agent and a durable follow-up DM to X. No LLM can undo it.

NEW inputs (`probe-c9-routing.ts`, `probe-c9-steal2.ts`; course list = the owner's real rows). "1:1 steal" =
PR hands off deterministically where origin/main keeps the ask with the addressed agent.

| Tag | Ask (addressed agent) | PR 1:1 | main 1:1 | Verdict |
|---|---|---|---|---|
| O3 | "change my vehicle info in my NEXUS account" (Troy) | -> Iris | keep | **steal** (NEXUS trusted traveler; override beats vetoes) |
| O4 | "add my new passport number to NEXUS" (Troy) | -> Iris | keep | **steal** ("passport" veto overridden) |
| O1 | "update my address in NEXUS before my next border crossing" (Troy) | -> Iris | -> Eli | wrong either way; PR now Iris |
| O2 | "reschedule my interview in NEXUS, I can't make the 14th" (Troy) | -> Iris | -> Cole | wrong either way |
| O8 | "set a reminder to log into Nexus tonight and check my grades" (Eli) | -> Iris | keep | **steal** ("reminder" veto overridden by "into Nexus") |
| O15 | "save my flight confirmation to Nexus" (Troy) | -> Iris | keep | explicit "to Nexus": by the owner's override rule (ambiguous) |
| O11 | "Finn, add the EMBA694 textbook cost to Nexus" (Finn) | -> Elle | keep | explicit "to Nexus" (ambiguous) |
| O7 | "text my professor and then update the due date in Nexus" (Cam) | -> Elle | -> Eli | mixed ask; acceptable |
| O6 | "Email Professor Smith: I need to add the essay to Nexus but the site is down" (Cam) | -> Elle | -> Elle | same as main |
| O9/O10/O13 | remind-to-add / "that I will add" / passive "needs to be added to Nexus" | no override | same | correct (O13 misses the override -> main routing, NON-BLOCKING) |
| O12/O14 | "put the MGT-782 email marketing case analysis … into Nexus", "hey Troy, please add the travel industry essay … to my Nexus" | -> Iris/Elle | keep | intended override -- correct |
| L10/S1/S2 | "put the MGT-782 exam on the calendar (for Friday)", "add the MGT-782 final exam to the calendar, it's Dec 12" (Eli) | -> Iris | keep | **steal** (veto only covers "on/to MY calendar") |
| S4 | "can you get the MGT-782 exam onto my schedule" (Eli) | -> Iris | keep | **steal** |
| L13/S5/S6/L14/S7 | "send my MGT-782 group the slides before the deadline", "share the slides with my MGT-782 group before Friday's deadline", "DM my MGT-782 group that the proposal deadline moved", "reply to my MGT-782 professor about the exam" (Cam) | -> Elle | keep (S6: main -> Elle too) | **steal x4** (send/share/DM/reply not vetoed) |
| L3/S8 | "book a room near campus for the MGT-701 residency, deadline is Friday" (Troy) | -> Elle/Iris | keep | **steal** ("room" not vetoed) |
| L4/S9 | "get me a ride to the MGT-782 exam on Friday", "I need a ride to my MGT-782 exam" (Troy) | -> Iris | keep | **steal** |
| L6/S10 | "order the EMBA694 textbook before the exam" (Finn) | -> Iris/Elle | keep | **steal** |
| L8/S11/S12 | "plan my meals for MGT-782 exam week", "meal prep …", "what should I cook the night before my MGT-782 exam" (Charleston) | -> Iris | keep | **steal** (L8 also moves the GROUP leader Charleston -> Iris) |
| S14 | "stretch routine before my MGT-782 exam" (Flex) | -> Iris | keep | **steal** |
| L12 | "find a babysitter for the MGT-701 residency weekend, deadline Friday" (Charleston) | -> Elle | keep | **steal** |
| L1/L2/L5/L9/L11/L15/S3/S13 | meeting/Zoom/coffee/workout/"to my calendar"/pack list/"in my calendar"/gym | keep | keep | correct |

**D13 (new, D12 class): 21 deterministic 1:1 lane steals origin/main does not make** (counted from the table:
L10 S1 S2 S4, L13 S5 L14 S7, L3 S8, L4 S9, L6 S10, L8 S11, S14, L12 = 18 from lane vocabulary missing from the veto
LIST -- calendar without "my", schedule, send/share/DM/reply, room, ride, order, meals, stretch, babysitter -- plus
O3 O4 O8 = 3 from the explicit override beating a veto: NEXUS trusted-traveler account/passport, "set a reminder to
log into Nexus"). S12 is excluded: `classifyTurnIntent` = query, and both the directive (:2465) and the follow-up
(:6822) require `perform`; every other row is `perform` (probe-c9-steal2 prints it). The trigger needs only
"exam"/"deadline"/"due"; a real course code is strong context; nothing else is required. The veto list is a word
list over open-ended lane vocabulary, so this class is not closed by adding words -- loop 3 found 13, the fix
vetoed those words, and 21 new ones were found here in ~10 minutes. **C4: REFUTED. C9: REFUTED.**

## C8 — mutations (mutate.sh; anchors/replacements are files in mut-verify-114-4/, generated and count-checked by
`make-anchors.py`)

| id | Mutation | Suite | Named test | Verdict (verbatim) |
|---|---|---|---|---|
| q1 | override verb list drops `put` | nexus-write-routing | `put my travel industry essay due Nov 3 into Nexus" -> holders are Elle/Iris` | FIRED |
| q2 | NEXUS-not-the-app drops `trusted|traveler|traveller` | nexus-write-routing | `"update my address in NEXUS trusted traveler before the deadline" matches NO coursework prime capability` | FIRED |
| q3 | D12 email veto group deleted | nexus-write-routing | `1:1 with ANY agent: "email my professor that my MGT-782 paper will be a day late" makes no prime hand-off` | FIRED |
| q4 | D12 lodging veto PATTERN deleted | nexus-write-routing | `1:1 with ANY agent: "find a place to stay for the MGT-701 residency, the deadline is Friday" makes no prime hand-off` | FIRED |
| q5 | keyed reset no longer dedups a turn key (V5) | nexus-write-voice-gate | first named VG-V5b -> **UNDETERMINED** (a different test failed); re-run named `VG-V5d` | FIRED |
| q6 | hook settles the write AFTER the hang-up early return (V3, the loop-3 defect) | nexus-write-voice-gate | first named VG-V3b -> **UNDETERMINED**; re-run named `VG-H3c` | FIRED |
| q7 | server throw returns the loop-3 `{error,tool}` shape (V1) | nexus-write-voice-gate | `VG-V1a` | FIRED |

Every run ended `restored: … matches HEAD` / `tree clean`. q1-q4 are from the new routing/override work, q5-q7 from
the voice-gate work. Observation on q6: the ONLY test that catches reverting the hook's ordering is `VG-H3c`, a
source-shape check of the hook; the behavioural VG-V3a-f run a simulation of the hook and stayed green with the
hook reverted (the hook itself is React and is not executed by any suite). **C8: CONFIRMED** (7 FIRED, 0 INERT,
0 NOT-APPLIED; 2 UNDETERMINED first attempts were mis-named tests, re-run and FIRED).

## M0 (cont.) — what the two conflicts are, and what a careless resolution would do

Conflicted files read from the merge tree `c94a98a` (`git merge-tree --write-tree`):

| File | PR side | main side (#124) | Correct resolution | Wrong resolution and its effect |
|---|---|---|---|---|
| `lib/voice/realtime-tools.server.ts` :192-206 | `raw = [… GET_EXTERNAL_CALENDAR_EVENTS_TOOL, ...nexusReadTools(), ...nexusWriteTools()]` | multi-line `raw`, FOCUS_TOOL only when `opts.journey !== false` (AC8 gate), `...nexusReadTools()` -- no write tools | union: main's shape + `...nexusWriteTools()` | take main -> **voice silently loses the Nexus write tool**; take PR -> **voice re-offers FOCUS_TOOL with journey off** (main's AC8 fix reverted) |
| `lib/routing.ts` :626-636 (`resolveOwnerLLM` prompt) | adds `primeOwners` directory to the 1:1 prompt | splits the prompt into `assigned` (grooming / 1:1 task creation owner) vs 1:1 | union; then DECIDE whether the prime-owner hint also goes into the `assigned` branch | after #124, `resolveOwnerLLM` is also the grooming judge (groom.ts:317-330) and the 1:1 task-creation owner (huddle.functions.ts:2930 on main) -- so wherever the hint lands, it now influences board-task ownership too, which no loop has verified |

Probes this loop ran against 38e1b17 (the PR head) and against a `git archive origin/main` export; none ran
against a resolved merge, because none exists. The merged result is unverified code on the C3/C4 paths.

## C1 — Feature 2 ACs

Unchanged since loop 3 except: **F2-35** stays MET (V1 now also MET on the throw shape; W4 residual is H15 class).
**F2-41/42/43** MET (P1-P3: "add the MGT-701 research proposal due Dec 1 to Nexus" -> Iris from Troy; "my MGT-782
paper is due Friday" -> Iris from Finn; "update the due date of my research paper in Nexus to Dec 9" -> Iris from
Cam). **F2-45 NOT MET**: "Fitness, finance and travel asks still route to Flex, Finn and Troy as before" -- D13
rows: Troy hands "I need a ride to my MGT-782 exam" / "book a room for the MGT-701 residency…" / "add my new
passport number to NEXUS" to Iris/Elle; Finn hands "order the EMBA694 textbook before the exam"; Flex hands
"stretch routine before my MGT-782 exam"; also Eli (calendar), Cam (send/share/DM/reply), Charleston (meals,
babysitter). F2-10/F2-14 "shared with F1" NOT MET by construction (cross-repo, unchanged since loop 1).
**C1: REFUTED** (F2-45).

## Defects, ranked by realistic likelihood with a real model and real owner phrasing

| # | Defect | Class | Likelihood | Repro |
|---|---|---|---|---|
| **M0** | PR #114 @38e1b17 conflicts with origin/main 4cb2273 in `routing.ts` and `realtime-tools.server.ts`; one-sided resolution drops either the voice Nexus write tool or main's FOCUS_TOOL journey gate; the merged `resolveOwnerLLM` now also judges grooming / task-creation owners | **BLOCKING for the merge** (merge impossible as-is; the result is unverified) | certain | `git merge-tree --write-tree --name-only origin/claude_nexus-write-tool-fixed origin/main` -> exit 1 |
| **D13** | An other-lane ask in a 1:1 that names a real course CODE ("MGT-782", "MGT 782", "EMBA694") plus "exam"/"deadline"/"due", using lane vocabulary the veto list lacks (on THE calendar, onto my schedule, send/share/DM/reply, room, ride, order, meals, stretch, babysitter), is deterministically handed to Iris/Elle: directive "not your lane, don't answer" + durable follow-up DM. origin/main keeps all 18 with the addressed agent. Course NAMES and code-less phrasing do not trigger (probe-c9-names). | **BLOCKING** (another agent's lane stolen that origin/main kept) | **moderate** -- needs the code + a deadline word + an unlisted verb; "put my MGT 782 exam on the calendar" to Eli is ordinary; no LLM involved, so it reproduces every time | `bun mut-verify-114-4/probe-c9-routing.ts <tree>`, `probe-c9-steal2.ts <tree>` (PR vs main) |
| **D13-ovr** | the explicit override beats every veto, so "add my new passport number to NEXUS", "change my vehicle info in my NEXUS account" (trusted-traveler program, only `card/program/…/trusted/traveler` excluded) and "set a reminder to log into Nexus tonight and check my grades" hand Troy's / Eli's asks to Iris | **BLOCKING** by definition (lane stolen origin/main kept) | low (NEXUS-program asks without "card/program/trusted traveler"; reminders that say "into Nexus") | same probe, rows O3 O4 O8 |
| W4 | after a failed write was spoken, an echo of the agent's own voice committed by server VAD resets the gate (the committed handler has no echo filter), so a later contradictory sentence in that exchange is streamed instead of suppressed | NON-BLOCKING (needs the model to contradict its own failed tool output; H15 class) | very low | `bun mut-verify-114-4/probe-c9-voice.ts` W4 |
| H15 | a save claim with no write call in the exchange is shown/spoken unchanged | BLOCKING by definition; owner-accepted design residual | low-moderate | loop 3 `probe-voice.ts` T1 |
| O13 | passive "… needs to be added to Nexus" misses the override -> origin/main routing | NON-BLOCKING (baseline routing; any agent may still call the write tool) | low-moderate | probe-c9-routing O13 |
| q6-cov | reverting the hook's V3 ordering is caught only by a source-shape test (VG-H3c); the behavioural V3 tests simulate the hook | NON-BLOCKING (test-quality) | n/a | C8 q6 |
| D7-gap / D7-over / D8-far / over-veto | as loop 3 (unchanged) | as loop 3 | as loop 3 | loop 3 probes |

Fixed and confirmed this loop: D12 (all 13 loop-3 rows match origin/main), V1 (throw -> "Not saved"), V2 (typed reset,
W5), V3 (write settles captured gate; q6 FIRED), V4 (fresh gate per call), V5 (keyed reset; W2/W3; q5 FIRED).

## Verdict

| Claim | Verdict |
|---|---|
| C1 F2 ACs | REFUTED (F2-45 NOT MET via D13; F2-10/14 shared-with-F1 NOT MET by construction) |
| C2 owner rules | CONFIRMED (loop-3 probe byte-identical) |
| C3 honesty | CONFIRMED as scoped (V1-V5 fixed; residuals W4 very low, H15 owner-accepted) |
| C4 routing | REFUTED (D13: 18 vocabulary + 3 override lane steals origin/main does not make) |
| C5 identity/url/headers | CONFIRMED |
| C6 read-only | CONFIRMED |
| C7 suites + tsc | CONFIRMED on 38e1b17 (12 suites, exact counts; tsc 0) -- not on a merge with main (M0) |
| C8 mutations | CONFIRMED (7 FIRED: q1-q4 routing/override, q5-q7 voice gate; 0 INERT; 0 NOT-APPLIED) |
| C9 new adversarial | REFUTED (D13, D13-ovr; voice W1-W6 hold except W4) |

**Overall: REFUTED.** The write path itself -- what is written, where, as whom, and what the owner is told --
holds on every input tried, and every loop-3 defect is fixed with a guard that FIRES. Two things stand between
this head and a merge: **M0** (it does not merge with today's main, and the conflict sits on the exact files the
fixes live in) and **D13** (the D12 class is not closed: the veto list removed the 13 phrasings loop 3 found, and 21
new ones were found in one pass, because a course code + "exam/deadline/due" is still enough to hand any lane's
1:1 ask to Iris/Elle deterministically, ahead of the LLM owner judge).
