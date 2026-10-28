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
