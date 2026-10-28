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
