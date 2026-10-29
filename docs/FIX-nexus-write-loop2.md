# Fix pass, loop 2: the verifier's REFUTED findings D1-D5 on `write_nexus_assignments`

<!--
WHAT:          Fix log for docs/VERIFY-nexus-write-tool-1.md (loop-1 verdict REFUTED): per defect D1..D5
               and per wrong row of the verifier's 48-input table -- fixed / not + why, the test that
               pins it, and the mutate.sh verdict proving the new STRUCTURAL guard is load-bearing.
WHY:           Two rounds of phrase/keyword patching leaked (D2: a comma defeated the "head" split; D3:
               "I didn't just add …" defeated the denial regex; D5: "to NEXUS", "thesis", "semester"
               over-matched). Loop 2 replaces each patched mechanism with a structural rule (owner-approved
               design, see each section) instead of adding vocabulary.
SUPERSEDES:    nothing. RESPONDS TO docs/VERIFY-nexus-write-tool-1.md. Builds on
               docs/FIX-nexus-write-redteam.md (whose W4 "head decides", W8/W10/W11 claim-parsing-as-
               primary, W19 broad weak context are REPLACED here, as stated per section).
SUPERSEDED-BY: nothing -- current.
EVIDENCE:      branch fix/nexus-write-loop2 from origin/claude_nexus-write-tool-fixed e881be0, pushed to
               claude_nexus-write-tool-fixed (PR #114). `bash scripts/run-nexus-fix-suites.sh` (counts in
               Results); scripts/nexus-write-loop2.test.ts; mutation anchors/replacements in mut-loop2/.
               Offline only: fetch mocked, no live Nexus/Huddle, no DB or board writes.
-->

Written as the work goes. Status words: **fixed** = the verifier's input is now a passing test and the
mechanism is proved by a mutation; **not fixed** = with the reason.

## D1 — dedup "same local day" computed in the zone the date was WRITTEN in

**Status: fixed.**

Mechanism: `resolveDueInstant` now returns `zone` = the COURSE zone (the item's `time_zone`, else
`America/New_York`) for every input, including an ISO instant with `Z` or an offset (the offset still
decides the INSTANT; it no longer decides the DAY). `findDuplicate` and the per-turn claim key compute
the day through one function, `courseDayZone()`, which only accepts a region zone (`Area/City`) and
otherwise falls back to the default -- so `"UTC"` or `"-04:00"` (how a string was spelled) can never
become the day's zone, even when a caller passes one.

| Verifier input | Before | After | Test |
|---|---|---|---|
| "Research Proposal" `2026-10-30T20:00:00Z`, stored `2026-10-31T03:59:59Z` | inserted, 1 POST | duplicate, 0 POSTs | L2-D1a |
| (extra) `2026-10-31T02:00:00Z` = Oct 30 22:00 ET | inserted | duplicate | L2-D1b |
| (control) `…T16:00:00-04:00` | duplicate | duplicate | L2-D1c |
| (extra) `…T23:00:00-07:00` = Oct 31 02:00 ET | — | inserted (next course day) | L2-D1d |
| (extra) stored `"2026-12-10 04:59:59+00"`, new `2026-12-09T22:00:00Z` | — | duplicate | L2-D1e |
| `findDuplicate(zone:"UTC")` / `zone:"-04:00"` | different day | same course day | L2-D1h, L2-D1i |
| claim key: Z instant vs plain date, same course day | different keys | same key | L2-D1j |

Side effect, intended: `due_local` labels for an ISO-instant input are now shown in the course zone
(previously `UTC`). No existing test asserted the old `zone: "UTC"`.

## D2 — kind filter: a comma/period/slash defeated "the head decides"

**Status: fixed** (owner-approved design: allow-list + deny-anywhere). The W4 "title HEAD decides"
mechanism from docs/FIX-nexus-write-redteam.md is REMOVED, not extended.

Mechanism (`classifyNonDeliverable`, nexus-write.server.ts):
1. **Deny anywhere.** A meeting/session/class word (`DENY_MEETING`), an event word (`DENY_EVENT`:
   symposium, networking, dinner, trip, …) or an admin/holiday/break/payment word (`DENY_ADMIN`)
   ANYWHERE in the title refuses it, whatever deliverable noun is also present. The meeting word wins.
   "Break-even" is not a break.
2. **Allow-list.** Otherwise the title must contain a graded-deliverable noun (`DELIVERABLE_ALLOW`:
   paper, essay, proposal, report, case/case study/brief, analysis, memo, reflection, post, quiz,
   exam/midterm/final, test, project, presentation, problem set, assignment, deliverable, literature/peer
   review, response, journal, portfolio, capstone, dissertation, thesis, draft, …). None -> refused as
   `reading` (reading-shaped) or the new reason `not-a-deliverable`.
3. A title with no Latin letters is not judged by the English lists (keeps W14 `研究提案` working). A
   leading `Test-` (the org's test-artifact prefix) is not read as the noun "test".
No bypass argument was added (owner: "keep it simple: refused with reason"). Each refusal's `note` now
tells the agent to tell the owner why.

| Verifier input (table row) | Before | After | Test |
|---|---|---|---|
| "Residency 4, present your research proposal" (+ no punctuation, ". ", " / ") | accepted | meeting/session | L2-D2a (10 spellings) |
| "Spring Recess" | accepted | administrative | L2-D2b |
| "Tuition payment due" | accepted | administrative | L2-D2b |
| "Course evaluations due" | accepted | administrative | L2-D2b |
| "Annual research symposium" | accepted | event | L2-D2b |
| "Networking dinner" | accepted | event | L2-D2b |
| "Field trip to Ford plant" | accepted | event | L2-D2b |
| "Pre-read: Porter Five Forces (HBR 1979)" | accepted | reading | L2-D2b |
| "Chapter 4 problem set" (over-reject) | reading | **accepted** | L2-D2d |
| "Holiday Inn case study" (over-reject) | administrative | administrative -- accepted cost | L2-D2e |
| "Spring break reflection paper" (over-reject) | administrative | administrative -- deny-anywhere | L2-D2c |
| "Thanksgiving reflection essay" (inconsistency) | accepted | administrative -- now consistent with the break row | FX-K1 (changed) |
| "Read and respond: chapter 4" (over-reject) | reading | reading -- no deliverable noun; accepted cost | L2-D2f |

**Existing assertions changed (not silently):** these asserted the OLD "a deliverable noun in the head
wins" behaviour that the owner's rule replaces:
- `scripts/nexus-write-fix.test.ts` FX-K1: "Paper due at Residency 4", "Residency 4 reflection paper",
  "Seminar paper" now assert `meeting/session`; "Thanksgiving reflection essay" asserts
  `administrative`. The other four FX-K1 titles still assert accepted.
- `scripts/nexus-write-tool.test.ts` F2-11 "Seminar paper": now `meeting/session` (was null).
- `scripts/nexus-write-tool.test.ts` FIXTURE TITLES only (assertions unchanged): "Test-Same Batch
  Twice", "Test-x", "Test-Batch One/Two/Three", "Test-Persist <m>" carried no deliverable noun and
  are now refused by the allow-list before reaching the code those tests exercise; each gained the
  word "Paper".

Mutations (mutate.sh, anchors/replacements in `mut-loop2/`, test cmd `bun scripts/nexus-write-loop2.test.ts`):

| # | Guard | Mutation | mutate.sh verbatim |
|---|---|---|---|
| d1a | ISO instant reports the course zone | `zone` back to `"UTC"`/written offset | `FIRED: 'L2-D1f resolveDueInstant reports the COURSE zone' failed with the defect reinstated. The guard is real.` |
| d1b | `courseDayZone` refuses a non-region zone | accept any valid zone ("UTC") | `FIRED: 'L2-D1h findDuplicate ignores a written-zone' failed with the defect reinstated. The guard is real.` |
| d2a | deny-anywhere, meeting family | meeting check removed | `FIRED: 'L2-D2a "Residency 4, present your research proposal" is refused' failed with the defect reinstated. The guard is real.` |
| d2b | allow-list | allow check -> accept everything | `FIRED: 'L2-D2g "Module 3 overview" names no deliverable' failed with the defect reinstated. The guard is real.` |
| d2c | deny-anywhere, event family | event check removed | `FIRED: 'L2-D2b "Annual research symposium"' failed with the defect reinstated. The guard is real.` |
| d2d | deny-anywhere, admin family | admin check removed | `FIRED: 'L2-D2b "Spring Recess"' failed with the defect reinstated. The guard is real.` |
| d2e | `Test-` prefix is not the noun "test" | prefix strip removed | `FIRED: 'L2-D2i the org' failed with the defect reinstated. The guard is real.` |

Every run also printed `restored: … matches HEAD` and `tree clean: … passes again on the restored tree`.

## D5 — coursework routing captured travel / finance / work asks

**Status: fixed** (owner-approved design: specific signals only, kept as DATA on the capability in
agents.ts). The W19 "broad weak context" (class/course/semester/school, `to Nexus`, `thesis`, `case
study`, lowercase `word + 3 digits` as a course code) is REPLACED.

New `requiresContext` (agents.ts `NEXUS_ASSIGNMENTS_CAPABILITY`):
- **strong words**: syllabus/syllabi, EMBA, MBA, DBA, doctoral, professor/prof, instructor, coursework.
- **strong patterns**: a course code `\b[A-Z]{2,4}[- ]?\d{3}[A-Z]?\b` (capitals, case-sensitive) or a
  hyphenated `mgt-782`; an explicit Nexus-ASSIGNMENT phrase -- "Nexus assignment(s)", "due in Nexus",
  or a write verb (add/put/log/save/enter/record/sync) followed by "to/into/in Nexus". NEXUS alone is
  never context. (The verb-anchored "add … to Nexus" is my reading of the owner's "due in Nexus"
  example; it keeps FX-R2 "add the case study due Nov 3 to Nexus" and is pinned by L2-D5e/D5b.)
- **weak (veto-able)**: "my assignment(s)" / "my <word> assignments"; a deliverable noun (paper, essay,
  research proposal, case analysis/study/brief, thesis, dissertation, midterm) PAIRED with a
  deadline/grading cue (due date, deadline, graded, submit…). A bare "due" is not a cue.
- **removed**: `course(s)`, `class(es)`, `semester`, `school`, `grad school`, `thesis`/`case study`/
  `research paper`/… as stand-alone strong words, the bare `to/in/on/from Nexus` pattern, and the
  lowercase `[a-z]{2,5} ?\d{3}` code pattern (it matched "pay 300", "is 300").

| Verifier input | group main -> loop1 -> loop2 | 1:1 hand-off to Elle/Iris (loop1 -> loop2) | Tests |
|---|---|---|---|
| should I apply to NEXUS before my trip to Toronto | troy -> iris -> **troy** | Finn, Troy -> none | L2-D5a/b/c |
| what's the investment thesis for buying more NVDA | tess -> iris -> **tess** | Finn, Troy -> none | L2-D5a/b/c |
| my semester tuition payment is due Dec 1, can I afford it | finn -> iris -> **finn** | Finn, Troy -> none | L2-D5a/b/c |
| review the course of action for the merger proposal due Friday | cole -> elle -> **cole** | Finn, Troy -> none | L2-D5a/b/c |
| is there a case study on intermittent fasting results | cole -> iris -> **cole** | Finn, Troy -> none | L2-D5a/b/c |
| I'm teaching a training class at work, slides due Friday | flex -> iris -> **flex** | Finn, Troy -> none | L2-D5a/b/c |
| 1:1 Finn "write up an investment thesis for NVDA" | — | iris -> **null** | L2-D5d |
| 1:1 Troy "apply to NEXUS for me before my Toronto trip" | — | iris -> **null** | L2-D5d |

L2-D5c checks the 1:1 hand-off from EVERY agent on the roster, not just Finn/Troy. All 11 verifier
coursework phrasings + 6 specific-signal spellings: group led by Elle/Iris (L2-D5e), kept by Elle and
Iris in a 1:1 (L2-D5f), handed to Elle/Iris from Finn (L2-D5g). router-redteam (12/12) and the FX-R1/R2
near-misses stay green unchanged. Observation outside D5 (pre-existing, not changed): "teach the course
of action workshop…, deck due Friday" in a 1:1 with Ezra hands to Elle on origin/main too -- Elle's
THEME "course" (topic scoring, unchanged since 4809e2e), not the prime rule; pinned as the baseline in
L2-D5d.

Mutations (`src/features/huddle/data/agents.ts`, test cmd `bun scripts/nexus-write-loop2.test.ts`):

| # | Guard | Mutation | mutate.sh verbatim |
|---|---|---|---|
| d5a | no generic weak words | `weak` back to class/course/semester/school | `FIRED: 'L2-D5b "my semester tuition payment is due Dec 1, can I afford it"' failed with the defect reinstated. The guard is real.` |
| d5b | thesis/case study not strong | added back to `strong` | `FIRED: 'L2-D5b "what's the investment thesis for buying more NVDA"' failed with the defect reinstated. The guard is real.` |
| d5c | NEXUS alone is not context | bare `to/in/on/from nexus` re-added | `FIRED: 'L2-D5b "should I apply to NEXUS before my trip to Toronto"' failed with the defect reinstated. The guard is real.` |
| d5d | "due in Nexus" / "add … to Nexus" are load-bearing for coursework | patterns removed | `FIRED: 'L2-D5e group "what's due in Nexus this week"' failed with the defect reinstated. The guard is real.` |
| d5e | a course code must look like one | lowercase `word ?\d{3}` re-added | `FIRED: 'L2-D5i "the deadline to pay 300 for my gym is Friday"' failed with the defect reinstated. The guard is real.` |

## D3 — honesty: false save claims laundered or decorated (text + voice, 1:1 + group)

**Status: fixed** (owner-approved design: stop parsing the model's prose for claims as the primary
defence). W8/W10/W11's clause-level claim/denial parsing (`enforceNexusWriteHonesty`) is kept,
unchanged, as a secondary function for its existing tests; the RUNTIME no longer calls it.

Mechanism (`nexusWriteGuardedReply`, nexus-write-shared.ts): when ANY write this turn -- this agent's or a
teammate's, text or voice -- has an item whose `persisted !== true` (failed, rejected, unknown, or a
duplicate: nothing new was written), the reply is:
1. **one code-built line per item** from the results (`nexusWriteItemLines`): "Saved to Nexus: “T” (due …)."
   / "Updated in Nexus: …" / "Already in Nexus, nothing new added: …" / "Not saved to Nexus: “T” — <plain
   reason>." / "Unknown: “T” — … check Nexus before treating it as saved.";
2. followed by the model's text with **every sentence removed** that names a written item (all its title
   words, or its head noun) or contains write-talk (add/save/update/move/schedule/Nexus/log/record/create/
   change/put/set/done/took care/squared away/on the books/✓ …). Nothing else is judged.
When every item persisted, the model's text passes untouched. A teammate whose reply says nothing about
the write is untouched; one whose reply did (even "Elle took care of it") loses those sentences and gets
the writer's lines -- which closes the loop-1 documented residual N14.

| Verifier input | Before | After | Test |
|---|---|---|---|
| N1 "I didn't just add the Research Proposal, I also set it to high priority." | UNCHANGED | the line only | L2-D3a N1, L2-V4 (voice) |
| N2 "Not a problem I've saved the Research Proposal for Oct 30." | UNCHANGED | the line only | L2-D3a N2 |
| N3 "Never fear I added the Research Proposal to Nexus." | UNCHANGED | the line only | L2-D3a N3 |
| N4 "Not only did I add the Research Proposal, …" | UNCHANGED | the line only | L2-D3a N4 |
| N5 "… is all squared away for Oct 30." | kept + appended | the line only | L2-D3a N5, L2-V7 (voice) |
| N6 "I've changed the Research Proposal deadline to Nov 2." (update failed) | kept + appended | the line only | L2-D3a N6 |
| N7 "Moved the Research Proposal to Nov 2 for you." | kept + appended | the line only | L2-D3a N7 |
| N8 "Research Proposal ✓" | kept + appended | the line only | L2-D3a N8 |
| N9 "Case Brief 2 could not be saved. The proposal is added though." | UNCHANGED | "Not saved … Research Proposal …" + "Saved to Nexus: “Case Brief 2”." | L2-D3a N9 |
| N10 "… is on the books for Oct 30." | kept + appended | the line only | L2-D3a N10 |
| N11 "… is set — due …, scheduled in Nexus." | kept + appended | the line only | L2-D3a N11 |
| N12/N13 controls | replaced / unchanged | the line only (an honest denial is also code-built) | L2-D3a N12, N13 |
| N14 teammate "Elle took care of it." | unchanged (residual) | the line only | L2-D3a N14 |
| N15 teammate "Elle has added your Research Proposal." | replaced | the line only | L2-D3a N15 |
| (new) N16 title named, no write word: "The Research Proposal is good to go for Oct 30." | — | the line only | L2-D3a N16 |

Plus: unrelated sentences survive after the lines (L2-D3b), all-persisted passes (L2-D3c), no write
passes (L2-D3d), duplicate/timeout/refusal/tool-error lines (L2-D3e..i), and the text path's reply
assembly is wired to it with teammates' writes (L2-D3j). L2-D3k: none of the verifier's 13 own-writer
replies survives verbatim.

**Changed assertions:** `scripts/nexus-write-tool.test.ts` F2-35 source check now looks for
`const safeText = nexusWriteGuardedReply(` (was `enforceNexusWriteHonesty(`);
`scripts/nexus-write-redteam.test.ts` RT-H6 now also accepts a voice file that creates the speech gate
AND speaks `gate.finalize(raw)` (it previously required the name `enforceNexusWriteHonesty` there).
The behavioural F2-35 / RT-H1..H5 assertions on `enforceNexusWriteHonesty` are unchanged and green.

## D4 — the 1:1 text stream showed the raw reply forming; the voice hold could be released early

**Status: fixed.**

- **Text (1:1 streaming).** `createNexusWriteStreamHold()` is turn-scoped in `runHuddleTurn` (beside
  `turnNexusWriteUses`). The write dispatch calls `nexusStreamHold.noteToolCall(c.name)` FIRST, before
  the claim/execute, and the 1:1 `onDelta` is `nexusStreamHold.wrap(...)`: once a write call has
  started, no further partial reply is published to the durable row for the rest of the turn; only the
  final guarded reply (D3) is persisted by the normal reply assembly. A turn with no write streams
  exactly as before.
- **Voice.** `createNexusWriteSpeechGate` now (a) holds speech from the moment the write call STARTS
  (`noteToolCall`, called from the hook's `response.function_call_arguments.done` before
  `runRealtimeTool`), not only once a failed result arrives; (b) `finalize(raw)` returns
  `nexusWriteGuardedReply(raw, uses)` -- the SAME code-built text as the text path -- and the hook
  speaks, captions and persists exactly that; (c) `reset()` at the next user utterance is DEFERRED while
  the write's reply has not been delivered and lands on the next `finalize`, so a barge-in during the
  write can no longer release the hold early.

| Behaviour | Test |
|---|---|
| deltas after a write call starts are never published; a read call does not hold | L2-D4a, L2-D4b |
| onDelta wrapped / dispatch arms the hold before executing / hold is turn-scoped | L2-D4c, L2-D4d, L2-D4e (source) |
| voice holds at call start; reset during the write deferred; code-built line spoken; reset lands after delivery | L2-V1..V7 |
| clean write: hold released when result is in; reply untouched; reset clears | L2-V8..V10 |
| hook arms at call start / speaks `gate.finalize(raw)` / streams only while not holding | L2-V11..V13 |

**Changed assertions:** `scripts/nexus-write-fix.test.ts` FX-V4 asserted "reset releases the hold"
unconditionally; it now asserts the reset is deferred until the reply is delivered (FX-V4) and releases
after `finalize` (new FX-V4b). FX-V7's source regex now matches `const full = gate.finalize(raw);`
(was `held ? enforceNexusWriteHonesty(raw, gate.uses) : raw`).

Mutations (test cmd `bun scripts/nexus-write-loop2.test.ts`):

| # | File | Guard | Mutation | mutate.sh verbatim |
|---|---|---|---|---|
| h1 | nexus-write-shared.ts | write-talk sentences dropped | only title mentions dropped | `FIRED: 'L2-D3a N14 teammate unnamed' failed with the defect reinstated. The guard is real.` |
| h2 | nexus-write-shared.ts | title-mention sentences dropped | only write-talk dropped | `FIRED: 'L2-D3a N16 title named with no write-talk word' failed with the defect reinstated. The guard is real.` |
| h3 | nexus-write-shared.ts | the reply IS code-built | `return t` | `FIRED: 'L2-D3a N1 negated-intensifier claim' failed with the defect reinstated. The guard is real.` |
| h4 | nexus-write-shared.ts | stream hold blocks deltas | `if (!held)` removed | `FIRED: 'L2-D4a deltas after a write call starts' failed with the defect reinstated. The guard is real.` |
| h5 | nexus-write-shared.ts | voice reset deferred | reset always clears | `FIRED: 'L2-V3 a reset during the write is deferred' failed with the defect reinstated. The guard is real.` |
| h6 | nexus-write-shared.ts | voice holds at call start | `pending += 1` removed | `FIRED: 'L2-V2 holding from the moment the write call STARTS' failed with the defect reinstated. The guard is real.` |
| h7 | nexus-write-shared.ts | voice speaks the code-built text | `finalize` returns raw | `FIRED: 'L2-V4 the voice speaks the code-built line' failed with the defect reinstated. The guard is real.` |
| h8 | huddle.functions.ts | dispatch arms the hold | `noteToolCall` removed | `FIRED: 'L2-D4d the write dispatch arms the hold' failed with the defect reinstated. The guard is real.` |
| h9 | huddle.functions.ts | onDelta wrapped | wrap removed | `FIRED: 'L2-D4c the 1:1 onDelta is wrapped' failed with the defect reinstated. The guard is real.` |
| h10 | huddle.functions.ts | reply assembly runs the guard | identity function | `FIRED: 'L2-D3j the text path's reply assembly' failed with the defect reinstated. The guard is real.` |
| h11 | useVoiceCallRealtimeSpeak.ts | hook arms at call start | `noteToolCall` removed | `FIRED: 'L2-V11 the hook arms the gate' failed with the defect reinstated. The guard is real.` |
| h12 | useVoiceCallRealtimeSpeak.ts | hook speaks finalize | `const full = raw` | `FIRED: 'L2-V12 the hook speaks/persists' failed with the defect reinstated. The guard is real.` |

h8-h12 are proved by SOURCE assertions (the call sites live in a 7k-line server function and a React
hook that cannot run offline); the behaviour behind them is proved by the pure tests h3-h7 fire on.
Every run printed `restored: … matches HEAD` and `tree clean: … passes again on the restored tree`.

## The verifier's own mutations m1-m7, re-run on the loop-2 code

| # | Verdict (mutate.sh verbatim) | Note |
|---|---|---|
| m1 RT-H3 | `FIRED: 'RT-H3' failed with the defect reinstated. The guard is real.` | `enforceNexusWriteHonesty` kept as secondary |
| m2 RT-D1 | `FIRED: 'RT-D1' failed with the defect reinstated. The guard is real.` | |
| m3 RT-K1 | `NOT-APPLIED: the anchor does not appear in src/features/huddle/lib/nexus/nexus-write.server.ts. NOTHING WAS TESTED.` | expected: the "head decides" line it mutates was REMOVED by D2; the replacement guard is d2a (FIRED) |
| m4 RT-T1 | `FIRED: 'RT-T1' failed with the defect reinstated. The guard is real.` | |
| m5 RT-R1 | `FIRED: 'RT-R1' failed with the defect reinstated. The guard is real.` | |
| m6 FX-V6 | `FIRED: 'FX-V6' failed with the defect reinstated. The guard is real.` | |
| m7 RT-D3 | `FIRED: 'RT-D3' failed with the defect reinstated. The guard is real.` | |

## C1 ACs the verifier marked NOT MET

- **F2-35** (runtime honesty): now MET on every verifier input offline (D3/D4 above). Live part still
  NOT TESTABLE OFFLINE.
- **F2-45** (non-coursework asks keep their agent): MET on every verifier input (D5).
- **F2-10 / F2-14 "one shared function with F1"**: NOT fixed -- cannot hold by construction (F1 lives in
  nexus-hub; Huddle has a spelled-identical copy). Out of scope for this repo; unchanged.

## Residuals (not fixed, and why)

- **Over-strip in a failed-write turn.** While any write this turn did not persist, ANY agent's sentence
  containing a write-talk word is dropped -- including an unrelated "I've updated your budget" from a
  teammate. That is the owner's rule as written ("any agent"); the cost is lost prose in a turn that
  already failed, never a false claim.
- **Text streamed/spoken BEFORE the write call** in the same model response ("Adding it now!") was
  already published; the hold starts at the call. Same as the loop-1 W18 residual.
- **A teammate reply assembled before the writer's write completed** (parallel wave) is not checked
  against that write: `turnNexusWriteUses` is filled as writes finish. Pre-existing (W17 scope).
- **D2 accepted costs:** "Holiday Inn case study", "Seminar paper", "Paper due at Residency 4",
  "Post-residency reflection paper", "Conference call notes memo" and any title with a deny word are
  refused with a reason; there is deliberately no bypass.
- **D5:** a capitalised word + 3 digits ("NVDA 100") still reads as a course code IF the ask also has an
  assignment-shaped trigger; "add … to Nexus" is accepted as context (owner's "due in Nexus" spirit).
  The LLM-router path is still not measurable offline.
- **W3 across server instances**, **MST/MT refused**: unchanged from loop 1.
- **Branch hygiene:** origin/main (d618114, #115) was merged into the branch so cross-app-turn-gate G7
  (which compares public route files with origin/main) is green; #115's files do not overlap this work.

## Results

`bash scripts/run-nexus-fix-suites.sh` on the final commit (after merging origin/main d618114):

| Suite | Result |
|---|---|
| scripts/nexus-write-redteam.test.ts | 39 passed, 0 failed (RT-H6 regex widened, documented) |
| scripts/router-redteam.test.ts | 12 passed, 0 failed (unchanged) |
| scripts/nexus-write-tool.test.ts | 115 passed, 0 failed (F2-11, F2-35 changed; 6 fixture titles gained "Paper") |
| scripts/router-winners.test.ts | 39 passed, 0 failed |
| scripts/nexus-read-tools.test.ts | 190 passed, 0 failed |
| scripts/cross-app-turn-gate.test.ts | 92 passed, 0 failed (G7 needed the origin/main merge) |
| scripts/voice-toolset-hidden.test.ts | 36 passed, 0 failed |
| scripts/nexus-write-fix.test.ts | 51 passed, 0 failed (was 50: FX-V4b added; FX-K1 x4, FX-V4, FX-V7 changed) |
| scripts/nexus-write-loop2.test.ts (new) | 185 passed, 0 failed |
| `npx tsc --noEmit -p .` | clean (exit 0) |

Mutations this pass: 24 new (d1a-b, d2a-e, d5a-e, h1-h12) -> 24 FIRED, 0 INERT, 0 NOT-APPLIED. Verifier's
m1-m7 re-run: 6 FIRED, 1 NOT-APPLIED (m3: its target line was deliberately removed by D2).

## Blast radius

| File | Change | Feeds verifier claims |
|---|---|---|
| src/features/huddle/lib/nexus/nexus-write.server.ts | D1 course-zone day (`resolveDueInstant` zone, `courseDayZone`, `findDuplicate`, claim key); D2 `classifyNonDeliverable` allow-list + deny-anywhere, new reasons `event`/`not-a-deliverable`, refusal notes | C1 (F2-10/11/13/14), C2, C9 |
| src/features/huddle/lib/nexus/nexus-write-shared.ts | D3 `nexusWriteGuardedReply`, `nexusWriteItemLines`; D4 `createNexusWriteStreamHold`; voice gate `noteToolCall`/`finalize`/deferred `reset` | C1 (F2-35), C3, C9 |
| src/features/huddle/lib/huddle.functions.ts | reply assembly calls `nexusWriteGuardedReply`; turn-scoped stream hold armed in the write dispatch; 1:1 `onDelta` wrapped | C1 (F2-31/35), C3 |
| src/features/huddle/hooks/useVoiceCallRealtimeSpeak.ts | gate armed at call start; speaks `gate.finalize(raw)` | C1 (F2-35), C3 |
| src/features/huddle/data/agents.ts | D5 `requiresContext` data only (no agent ids in code) | C1 (F2-41..45), C4, C9 |
| scripts/*.test.ts, scripts/run-nexus-fix-suites.sh | new suite + documented assertion changes | C7, C8 |

Not touched: the outbound call site `nexusWriteFetch`, owner/URL/header handling (C5), the read module
`nexus.server.ts` (C6), `capabilities.ts` (the context gate's code is unchanged; only its data moved).
