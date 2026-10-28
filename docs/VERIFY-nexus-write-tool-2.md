# VERIFY nexus-write-tool, loop 2 — independent re-verification of huddle PR #114 (head 6b11bae)

<!--
WHAT:          Independent, offline re-verification of PR #114 (branch claude_nexus-write-tool-fixed,
               head 6b11bae) after the loop-2 fix pass: per-claim verdicts C1..C9 with observed evidence.
WHY:           Loop 1 (docs/VERIFY-nexus-write-tool-1.md) returned REFUTED (D1 dedup zone, D2 meeting
               punctuation, D3 honesty laundering, D4 1:1 stream, D5 routing over-match). The fixer
               (docs/FIX-nexus-write-loop2.md) reports all fixed with structural redesigns; this pass
               re-derives every claim from scratch.
SUPERSEDES:    nothing. FOLLOWS docs/VERIFY-nexus-write-tool-1.md (branch claude_verify-nexus-write-tool-1).
SUPERSEDED-BY: nothing -- current.
EVIDENCE:      this file; probes + mutation anchors in mut-verify-114-2/ on branch
               claude_verify-nexus-write-tool-2. Offline only: fetch mocked, no live Nexus/Huddle,
               no DB or board writes.
-->

Started 2026-10-28 18:25 UTC. Worktree branch `verify-nexus-write-tool-2` from
`origin/claude_nexus-write-tool-fixed` @ `6b11bae`. Written as the work goes.

## C7 — suite counts + tsc (CONFIRMED)

`bash scripts/run-nexus-fix-suites.sh` (node_modules symlinked from the main checkout), then
`npx tsc --noEmit -p .`:

| Suite | Observed |
|---|---|
| nexus-write-redteam | exit 0, ALL PASS: 39 passed, 0 failed |
| router-redteam | exit 0, 12 passed, 0 failed |
| nexus-write-tool | exit 0, ALL PASS: 115 passed, 0 failed |
| router-winners | exit 0, 39 passed, 0 failed |
| nexus-read-tools | exit 0, ALL PASS: 190 passed, 0 failed |
| cross-app-turn-gate | exit 0, 92 passed, 0 failed (origin/main had moved to 39f464d; G7 still green) |
| voice-toolset-hidden | exit 0, 36 passed, 0 failed |
| nexus-write-fix | exit 0, ALL PASS: 51 passed, 0 failed |
| nexus-write-loop2 | exit 0, ALL PASS: 185 passed, 0 failed |
| script RC | 0 |
| tsc | exit 0, no output |

Every number matches the fixer's Results table. **C7: CONFIRMED.**

## C4 — routing vs origin/main (39f464d; routing files identical to d618114)

Probes: `bun mut-verify-114-2/probe-routing.ts <tree>` and `bun mut-verify-114-2/probe-intent.ts <tree>` run on
this worktree and on a `git archive origin/main` export (same node_modules). `group` = `routeMessage(...).winners[0]`
with the whole roster; 1:1 = `laneOwnerFor(text, self)` / `primeLaneDecision(text, self)`, plus
`classifyTurnIntent` (the 1:1 follow-up DM at huddle.functions.ts:6762-6780 fires when intent is `perform` and
`primeLaneDecision` returns another agent -- deterministically, BEFORE and INSTEAD OF the LLM owner resolver
that origin/main uses for the same branch).

Coursework (13 asks incl. loop-1's 11): group led by Elle/Iris 13/13; Elle and Iris keep all of them in a 1:1;
every other agent hands them to Elle/Iris. Loop-1's D5 inputs (NEXUS before trip, investment thesis, semester
tuition, course of action, fasting case study, training class) are back to baseline. Controls (seat
assignment, NEXUS card, client deliverable, tax papers) = baseline.

**NEW over-matches (loop 2), all `intent: perform`, all `laneOwnerFor = null` on origin/main** ("keep" below means
origin/main has no deterministic hand-off; there the LLM owner resolver decides, which is not measurable offline --
the PR replaces that decision with a deterministic one for these asks):

| Ask (1:1 with) | origin/main | PR | Mechanism |
|---|---|---|---|
| "my UA 902 check-in deadline is tonight, can you handle it" (Troy) | keep | **-> elle-rowan, follow-up DM** | flight number matches the course-code strongPattern `[A-Z]{2,4}[- ]?\d{3}`; strong is checked BEFORE the `flight`/`trip` vetoes (capabilities.ts:290-291) |
| "check me in for UA 902 before the deadline tonight" (Troy) | keep | **-> elle-rowan** | same |
| "my DS-160 visa form is due Friday" (Troy) | keep | **-> iris-chase** | US visa form id matches the code pattern |
| "fill out my DS-160 visa form, it's due Friday" (Troy) | keep | **-> iris-chase** | same |
| "my DBA filing deadline for the LLC is Friday" (Sam) | keep | **-> elle-rowan** | `dba` (doing-business-as) is a STRONG word |
| "file my DBA for the LLC before the deadline" (Sam) | keep | **-> elle-rowan** | same |
| "pay the IRS 941 payment due Friday" / "the IRS 941 payment is due Friday" (Finn) | keep | **-> iris-chase** | IRS form 941 matches the code pattern |
| "my MBA loan payment is due Monday, can I afford it" (Finn) | keep | **-> iris-chase**; group finn -> **iris** | `mba` STRONG beats any veto |
| "set up autopay for my MBA loan payment due Monday" (Finn) | keep | **-> iris-chase** | same |
| "pay my yoga instructor, the payment is due Monday" (Finn) | keep | **-> iris-chase** | `instructor` STRONG |
| "my yoga instructor says the class pass payment is due Monday" (Flex) | keep | **-> iris-chase** | same |
| "sign my mortgage papers before the due date" / "when is the due date on my mortgage papers" (Finn) | keep | **-> iris-chase** | weakPair `papers`+`due date`, no veto word |
| "my new job assignment in Germany starts Monday, what's my assignment exactly" (Sam) | keep | **-> iris-chase**; group sam -> **iris** | weakPattern `my assignment` |
| "roll my NVDA 200 calls before the deadline Friday" (Finn) | keep | **-> elle-rowan** | ticker + number = code pattern (fixer's own listed residual) |

**C4: REFUTED** (new defect D6 below): the loop-2 "specific signals" are not specific -- flight numbers, visa/tax
form numbers, tickers, DBA (business filing), MBA (loan), instructor (yoga) are STRONG context, which skips the
veto list entirely; each produces a deterministic out-of-lane 1:1 hand-off + follow-up DM where origin/main kept
the ask. The LLM-router path is not measurable offline.

## C3 — honesty (text + voice, single + group)

Probe: `bun mut-verify-114-2/probe-honesty.ts` (pure `nexusWriteGuardedReply` exactly as huddle.functions.ts:6595
calls it, and `createNexusWriteSpeechGate` in the event orders useVoiceCallRealtimeSpeak.ts:406-545 can produce).
Item "Research Proposal" failed with http_500 unless stated.

Loop-1 inputs N1–N16: covered by the fixer's L2-D3a/k (green in C7); spot-checked here (control "I've added the
Research Proposal to Nexus." -> only the code-built line). **The loop-1 laundering mechanism is gone.**

But the "structural" rule is still a VOCABULARY rule: a sentence is dropped only if it matches `WRITE_TALK` (a word
list) or names the item; everything else is kept AFTER the truthful line. New inputs:

| # | Reply (own writer, item failed) | Output | Verdict |
|---|---|---|---|
| H1 | "It's in." | `Not saved to Nexus: “Research Proposal” — http 500.` + `It's in.` | **false claim kept** |
| H2 | "It is on your list for Oct 30." — **AC-F2-35 names "is on your list" verbatim** | line + claim kept | **false claim kept** |
| H3 | "Penciled it in for the 30th." | line + claim kept | **kept** |
| H4 | "Handled. You're good for the 30th." | line + claim kept | **kept** |
| H5 | "Booked it for Oct 30." | line + claim kept | **kept** |
| H6 | "Sorted! It will show up in your coursework view." | line + claim kept | **kept** |
| H7 | "Your RP is good to go for Oct 30." | line + claim kept | **kept** |
| H8 | "Listo, ya quedó guardado para el 30." (Spanish) | line + claim kept | **kept** |
| H9 | "Ａｄｄｅｄ it for Oct 30." (full-width; WRITE_TALK runs on the raw text, not NFKC) | line + claim kept | **kept** |
| H10 | "I've add​ed it" (zero-width space) | line only | ok |
| H11 | "Got it on there, you're all good." | line + claim kept | **kept** |
| H12 | TEAMMATE (no own write), writer failed: "It's in, Elle got it." | **UNCHANGED, no line** | **false claim, no truth shown** |
| H13 | TEAMMATE: "Elle handled that one for you." | **UNCHANGED** | **false claim, no truth shown** |
| H14 | clean 1-item write, reply "I've added all 5 assignments from your MGT-782 syllabus." | UNCHANGED | **over-claim passes** (all persisted -> pass-through) |
| H15 | NO write call this turn, reply "I've added your Research Proposal to Nexus." | UNCHANGED | **hallucinated save passes** (no results -> pass-through) |
| ctl | "Also, remember to hydrate." | line + kept | ok |

**Voice (new, blocking):**

| # | Event order | Observed | Verdict |
|---|---|---|---|
| V-a | write call STARTED (`noteToolCall`), result not in, then a `text.done` arrives | `holding=true`, so the hook takes the held branch and calls `speak(full)` with `full = gate.finalize(raw)` = **the raw text** ("Done, I've added the Research Proposal for Oct 30.") because `nexusWriteGuardedReply` with no results yet is a pass-through. The write then fails: `holding=true` -- too late; it was spoken, captioned and persisted (hook :426-436). | **false save SPOKEN** |
| V-b | text item before the call in the same response | `holding=false` -> streams | fixer's documented residual |
| V-c | failed write, reply "It is on your list for Oct 30." | line + claim kept (= H2 on voice) | **kept** |

When does V-a happen? Any `text.done` while a write is in flight: (1) the model calls the write AND a read tool in
one response ("add my proposal and tell me what's due this week") -- the read returns first and the hook sends
`response.create` (:534) while the write is still pending, so the model answers before it knows the write's result;
(2) the user talks during the write (a new auto-response); (3) a message item after the function_call in the same
response. The "hold from call start" (L2-V2) delays the false sentence until `text.done` and then speaks it whole.
L2-V1..V13 never call `finalize` while `pending > 0`.

**1:1 text stream (D4):** source re-read (huddle.functions.ts:4394 arms the hold before the claim/execute;
:4923-4935 `onDelta` wrapped; the final reply is computed after every tool call of the agent has returned, so the
V-a race does not exist on the text path). Residual: text published BEFORE the write call is shown until the final
reply replaces it (transient; the final reply is guarded). Non-blocking.

**Parallel teammates (fixer residual) -- MEASURED from source, mostly NOT real:** group waves run
`Promise.all(wave.map(runBounded))` (huddle.functions.ts:7174) and only THEN `mergeAgentResult` (where the guard
runs, :6595) for each, so every in-wave write is in `turnNexusWriteUses` before any teammate's reply is guarded.
The residual is real in two narrower cases: (a) the writer hit the `runBounded` deadline with its write still in
flight; (b) **a later CHUNK**: `turnNexusWriteUses` is a per-execution array (:2136) that is NOT in
`buildResumeState` (:6889-6908) and not re-seeded on resume, so a teammate replying in a later chunk of a durable
group turn is guarded against nothing (H12/H13-style claims then reach the user). Not blocking alone (the teammate
sees the writer's code-built "Not saved" line in its prior). Text emitted BEFORE the write call: transient on text,
spoken on voice (V-b) -- non-blocking residual as the fixer states.

**C3: REFUTED.** Blocking: V-a (a false save is spoken on voice whenever a reply completes while the write is in
flight) and H2 (the exact phrase AC-F2-35 forbids survives after a failed write). Non-blocking but real:
H1/H3–H9/H11 (contradictory replies -- truthful line first, then a claim), H12/H13 (teammate claim with no truth
shown), H14/H15 (no failed result to check against -- outside F2-35's letter, inside C3's "ever").

## C2 — owner rules

Probes: loop-1's `bun mut-verify-114/probe-exec.ts` re-run on 6b11bae (re-derivation), plus the new
`bun mut-verify-114-2/probe-exec.ts` (fake fetch; executor + `classifyNonDeliverable`).

**Re-derived (all ok):** ET/EST/E.S.T./US/Eastern 10-30 23:59 -> 03:59Z; 12-09 -> 12-10T04:59Z; DST eve/day; gap
02:30 -> `timeShifted`; overlap 01:30 -> first; `-07:00` and `+0530` honoured; null/""/TBD -> undated; Week 5 /
Oct 30 / 10/30 / 2026-02-30 -> ambiguous-date; MST refused as ambiguous. Loop-1 D1 (Z instant, same ET day) ->
**duplicate, 0 POSTs (fixed)**; `-04:00` same instant -> duplicate; next day -> inserted; recurring Discussion
Post 11-09/11-16 inserted, 11-02 duplicate. Loop-1 D2: all four punctuation variants + "Present your research
proposal at Residency 4" -> meeting/session **(fixed)**; Thanksgiving / Spring Recess / Tuition payment / symposium
/ networking dinner / field trip / Pre-read -> refused. New, ok: EST in July -> 2026-07-16T03:59:59Z (DST honoured);
EDT in December -> 04:59:59Z; plain date with time_zone LA / PST / UTC -> duplicate; full-width title, hyphen +
trailing period, "(20% of final grade)", "- 20%" -> duplicate; the same new item twice in ONE batch, and plain vs Z
on the same course day in one batch -> 1 POST + duplicate; claim keys equal for plain vs Z.

**NEW defects:**

| # | Input | Observed | Rule broken |
|---|---|---|---|
| D7a | "Residency4, present your research proposal" | `null` (accepted) | meeting refused in any spelling |
| D7b | "Residency_4: present your research proposal" | `null` | same |
| D7c | "ResidencyIV: present your research proposal" | `null` | same |
| D7d | "Ｒｅｓｉｄｅｎｃｙ 4: present your research proposal" (full-width) | `null` | same |
| D7e | "Office-hours: bring your proposal draft" | `null` | same |
| D7f | "Oﬃce hours: bring your proposal draft" (U+FB03 ligature) | `null` | same |
| D7g | "Office hours: …" (NBSP, common in PDF-extracted syllabi) / "Office  hours: …" (two spaces) | `null` / `null` | same |
| D7h | "Re­sidency 4: …" (soft hyphen) | `null` | same |
| D7i | "Residence weekend: …", "Weekend intensive: …", "Doctoral consortium: …", "Academic conference: present your paper", "Cohort gathering: bring your case analysis" | all `null` | meeting/event vocabulary gaps |
| D8 | "Research Proposal" `2026-10-30T12:00:00Z` with `time_zone: "Asia/Tokyo"`; plain `2026-10-30` with `time_zone: "Europe/London"` (stored row 2026-10-31T03:59:59Z = Oct 30 ET) | **inserted, 1 POST each** -- a second Research Proposal on the same ET course day | dedup day "in the COURSE zone regardless of input zone": the day zone is the model-supplied `time_zone` argument (nexus-write.server.ts resolveDueInstant `zone` -> findDuplicate `courseDayZone(cand.zone)`), not the course's zone |

Mechanism D7: `classifyNonDeliverable` (nexus-write.server.ts:323-332) runs the deny regexes on the RAW title --
no NFKC, no separator folding -- with `\b…\b` word boundaries and literal single spaces. `Residency4`/`Residency_4`/
`ResidencyIV` have no boundary after the `y`; `office hours?` needs exactly one ASCII space; full-width letters and
ligatures never match an ASCII pattern. The allow-list then finds "proposal"/"draft"/"paper"/"analysis" and accepts.
(`dedupTitle` and the honesty `wordsOf` both NFKC-normalise; the classifier does not.)

Over-rejections (recoverable: refused with a reason, nothing written; the fixer lists this class as accepted cost):
"Program evaluation report" -> administrative, "Case analysis: Stripe payments" -> administrative, "Literature review:
tuition pricing models" -> administrative, "Holiday retail sales analysis" -> administrative, "Final paper: lessons
from the Delta Air Lines trip to bankruptcy" -> event, "Business plan: corporate retreat startup" -> event, "Class
participation reflection paper" -> meeting/session, "Team project: Ford plant visit report" -> event.
"Eastern Standard Time" (the Windows/Graph zone name) -> refused as ambiguous-date (recoverable).

**C2: REFUTED.** Blocking: D7a–D7g (the brief's own canonicalisation spellings of the owner's named meeting example
are accepted as assignments). D8 blocking per the rule as stated (a real duplicate row), low frequency (needs a
non-ET `time_zone` argument).

## C5 — the model cannot steer owner / URL / table / auth headers (CONFIRMED)

Loop-1 probe re-run on 6b11bae (`bun mut-verify-114/probe-exec.ts`, C5 block): POST url
`https://nexus.test/api/d1/assignments?owner=owner-uuid-1111` (one owner param); headers
`{content-type, x-uat-token: srv-token, x-agent-tool: write_nexus_assignments, x-agent-ref: probe}`; body
`{course_id: c782, title, type: assignment, status: active, due_date, program_id: p-dba}` -- every model-supplied
owner/user_id/email/url/headers/table/program_id/id/canvas_meta dropped; injected
`assignment_id: "aafbf80f&owner=evil&id=6616bef3"` encoded into ONE `id`, owner stays single; every GET carries the
server owner; 26 items -> batch_too_large, 0 writes. Fresh loop-2 injections (`bun mut-verify-114-2/probe-exec.ts`):
`time_zone: "America/New_York&owner=evil"` -> rejected ambiguous-date, 0 POSTs, owners `[["owner-uuid-1111"]]`;
`course: "MGT-782&owner=evil"` -> course_not_found, 0 POSTs; JSON-ish title/description (`…", "user_id": "evil`) ->
body keys `course_id,title,type,status,due_date,program_id,description`, no owner/user_id key. The single
outbound `fetch(` of the write module is nexus-write.server.ts:503; untouched by loop 2 (fixer's blast radius;
`git diff e881be0 6b11bae --stat -- src/` lists 8 files, none of them the call site).

## C6 — read tools stay read-only (CONFIRMED)

`git diff origin/main...HEAD -- nexus.server.ts`: 4 changed lines, each only adds `export` (`nexusOwner`,
`nexusBase`, `TIMEOUT_MS`, `nexusGet`) plus comments. Only `fetch(` in it: `fetch(url.toString(), { signal:
controller.signal })` (:128). `bun mut-verify-114/probe-read.ts`: 12 read tools = 12 NEXUS_TOOL_NAMES; 16 calls,
0 with any init key other than `signal`. (The probe's "write tool among reads: true" is the read tool
`get_nexus_writer_transcript` matching /write/ -- not the write tool.)

## C8 — mutations (mutate.sh; anchors + replacements are files in mut-verify-114-2/; runner
`bash mut-verify-114-2/run-mutations.sh`; anchors n1–n5 written from exact source lines by
`mut-verify-114-2/make-anchors.py`, each occurring once)

| # | Guard | File | Mutation | Test / must-fail | mutate.sh verbatim |
|---|---|---|---|---|---|
| m1 | loop-1 W10 | nexus-write-shared.ts | `if (namedOwn.some(unsaved)) ownFalse = true;` -> `if (false)` | redteam / RT-H3 | `FIRED: 'RT-H3' failed with the defect reinstated. The guard is real.` |
| m2 | loop-1 W1 | nexus-write.server.ts | same-local-day check -> `return rm !== null;` | redteam / RT-D1 | `FIRED: 'RT-D1' failed with the defect reinstated. The guard is real.` |
| m5 | loop-1 W19 | capabilities.ts | context gate removed | router-redteam / RT-R1 | `FIRED: 'RT-R1' failed with the defect reinstated. The guard is real.` |
| m6 | loop-1 W18 | useVoiceCallRealtimeSpeak.ts | holding check removed | nexus-write-fix / FX-V6 | `FIRED: 'FX-V6' failed with the defect reinstated. The guard is real.` |
| m7 | loop-1 W3 | nexus-write.server.ts | `withWriteLock` bypassed | redteam / RT-D3 | `FIRED: 'RT-D3' failed with the defect reinstated. The guard is real.` |
| n1 | **loop-2 D2** deny-anywhere meeting | nexus-write.server.ts | `if (DENY_MEETING.test(t))` -> `if (false)` | loop2 / L2-D2a | `FIRED: 'L2-D2a' failed with the defect reinstated. The guard is real.` |
| n2 | **loop-2 D1** `courseDayZone` region-only | nexus-write.server.ts | accept any valid zone | loop2 / L2-D1h | `FIRED: 'L2-D1h' failed with the defect reinstated. The guard is real.` |
| n3 | **loop-2 D3** write-talk sentences dropped | nexus-write-shared.ts | `WRITE_TALK.test(s.text) ||` removed | loop2 / L2-D3a N14 | `FIRED: 'L2-D3a N14' failed with the defect reinstated. The guard is real.` |
| n4 | **loop-2 D4** stream hold | nexus-write-shared.ts | `if (!held) fn(...a);` -> `fn(...a);` | loop2 / L2-D4a | `FIRED: 'L2-D4a' failed with the defect reinstated. The guard is real.` |
| n5 | **loop-2 D5** no generic strong words | agents.ts | `"semester", "thesis"` added to `strong` | loop2 / L2-D5b | `FIRED: 'L2-D5b' failed with the defect reinstated. The guard is real.` |

Every run printed `restored: … matches HEAD` and `tree clean: … passes again on the restored tree`; `git status
--short` = 0 lines afterwards. **10 FIRED, 0 INERT, 0 NOT-APPLIED. C8: CONFIRMED** -- the guards are real for the
inputs they test. (No test covers V-a, D6, D7, D8: they are inputs, not guards.)

**Changed existing assertions -- judged:** FX-K1 (4 titles now refused), F2-11 "Seminar paper" -> meeting/session:
legitimate updates to a REPLACED, owner-approved rule (deny-anywhere); the fixer lists them as accepted cost.
F2-35 source regex (`nexusWriteGuardedReply(`), RT-H6 (accepts `createNexusWriteSpeechGate()` + `gate.finalize(raw)`),
FX-V7 (`const full = gate.finalize(raw);`): legitimate renames to the new call sites, same strength (source greps
before and after). FX-V4/V4b (reset deferred until finalize): legitimate for the new design -- but note it is the
deferral that makes V-a's "speak raw at text.done while pending" path reachable without a test. Fixture titles
gaining "Paper" (Test-Same Batch Twice, Test-x, Test-Batch One/Two/Three, Test-Persist): legitimate (they test
dedup/persist/not-found, not classification). **None is a weakening.** Radius challenge: the loop-2 classifier
also runs on UPDATEs that pass a title (nexus-write.server.ts:717-719), so an update of the kept Canvas row
"Residency participation" (OQ-2) that carries its title is refused -- inside the radius, untested, low impact
(an update by `assignment_id` alone still works).

## C1 — Feature 2 ACs (+ RESOLUTIONS: W1 auth, owner = Huddle's server-held NEXUS_OWNER_ID)

Re-derived on 6b11bae: loop-1 `probe-ac.ts`, `probe-exec.ts`, `probe-read.ts`, `probe-routing.ts` re-run, plus the
loop-2 probes in mut-verify-114-2/. AC text read from /home/user/nexus-hub/docs/cross-app-agent/AC-syllabus-deliverables-write-tool.md.

| AC | Verdict | Evidence (this loop) |
|---|---|---|
| F2-01/02/03 | NOT TESTABLE OFFLINE | Nexus-side token checks (W1). Huddle side: token from server env; F2-30 no-token -> 0 write tools. |
| F2-04 | MET (Huddle side) | C5: every model identity key dropped; one server `owner=`. |
| F2-05 | MET as re-read by OQ-10 | owner = `NEXUS_OWNER_ID` on every POST/PATCH/GET (C5). |
| F2-06 | NOT TESTABLE OFFLINE | Nexus route matrix. |
| F2-07 | MET (Huddle side) | literal path, POST/PATCH only, whitelisted body keys (C5). |
| F2-08 | NOT TESTABLE OFFLINE | Nexus 404; Huddle maps 404 -> not_found, persisted:false (C5 PATCH). |
| F2-09 | PARTIAL | `X-Agent-Tool`/`X-Agent-Ref` sent (C5); preimage `source` is Nexus-side. |
| F2-10 | NOT MET (as written, unchanged) | behaviour MET (null/""/TBD undated; Week 5/Oct 30/10/30 ambiguous); "one predicate imported by F1 and this endpoint" impossible cross-repo (Huddle-local copy). |
| F2-11 | MET for the AC's fixture; **owner rule NOT MET** | "Residency 4 – present ideas and insights from the readings" -> meeting/session, 0 POSTs. But D7: "Residency4, …", "Residency_4: …", "Office-hours: …", "Oﬃce hours: …", full-width "Ｒｅｓｉｄｅｎｃｙ 4: …" accepted. |
| F2-12 | MET | update `due_date:null` -> rejected/undated, 0 writes. |
| F2-13 | MET | 10-30 -> 03:59Z; 12-09 -> 12-10T04:59Z; 03-07 -> 03-08T04:59Z; `-07:00` honoured; EST in July uses DST. |
| F2-14 | MET for the stated fixtures; **D8 hole** | "Research Proposal (20%)"/"Research Paper Proposal" -> duplicate aafbf80f…; loop-1 D1 fixed; but a non-ET `time_zone` argument (Asia/Tokyo, Europe/London) inserts a same-ET-day duplicate. Same-function-as-F1 NOT MET by construction. |
| F2-15 | MET | timeout-after-commit -> unknown; identical retry -> duplicate; rows = 1. |
| F2-16..19 | MET | MGT-782 / mgt 782 / MGT782 / mgt-782 / "MGT-782-W1 (202711)" -> c782; MGT-999 not found; TST-701 ambiguous; "Strategic Management" -> csm; "Strategy" not found. |
| F2-20/21 | NOT TESTABLE OFFLINE | preimage + undo are Nexus-side. |
| F2-22 | MET | POST body type/status forced, program_id from course (C5). |
| F2-23 | MET | [dated, undated, dated] -> inserted/rejected/inserted; 26 -> batch_too_large, 0 writes. |
| F2-30 | MET | full 1+12; no URL 0/0; no owner 0/0; no token 0 write/12 read. |
| F2-31/32 | MET (source + suites) | voice-toolset-hidden 36/0, cross-app-turn-gate 92/0. |
| F2-33 | MET | schema unchanged in loop 2 (suite nexus-write-tool 115/0). |
| F2-34 | MET | 200 inserted; 400/500 http_N; throw network_error; no id; timeout unknown. |
| **F2-35** | **NOT MET** (offline part) / live part NOT TESTABLE | H2: "It is on your list for Oct 30." -- a phrase the AC names -- survives after a failed write; V-a: on voice a false "I've added …" is spoken when a reply completes while the write is in flight; H1/H3–H9/H11 keep other claims after the truthful line. |
| F2-36 | MET | "Nexus write: 1 inserted, 0 updated" ok:true; FAILED summaries ok:false. |
| F2-37 | MET | C6. |
| F2-38 | NOT TESTABLE OFFLINE | prompt-level. |
| F2-39 | N/A offline | no live writes made. |
| F2-40 | NOT TESTABLE OFFLINE | LLM router. |
| F2-41 | MET | 13/13 coursework phrasings -> Elle/Iris on `routeMessage`. |
| F2-42 | MET | Elle and Iris keep all 13 in a 1:1. |
| F2-43 | MET | 1:1 Finn "add my MGT-782 research paper due Dec 9" -> iris-chase. |
| F2-44 | MET | 0 added lines with `elle-rowan`/`iris-chase` in routing.ts, huddle.functions.ts, capabilities.ts, nexus.server.ts, nexus-write*.ts (agents.ts data only). |
| **F2-45** | **NOT MET** | board asks -> Iris; run/dining/flight -> Flex/Finn/Troy (ok); but "my MBA loan payment is due Monday, can I afford it" moves finn -> **iris** in group, and 1:1 Finn/Troy/Sam/Flex hand finance/travel/business asks to Elle/Iris (D6). |
| F2-46 | MET vs baseline | "tidy up my calendar adjustments" -> eli; "fix the typo in the email draft" -> cam-post on both trees. |
| F2-50 | NOT TESTABLE OFFLINE | TIMEOUT_MS 15 s imported; surfaces as unknown (F2-34). |

**C1: REFUTED** -- F2-35 and F2-45 NOT MET on new inputs; F2-11/F2-14 MET only for their literal fixtures (D7, D8);
F2-10/F2-14 "shared with F1" NOT MET by construction (unchanged since loop 1, out of this repo's reach).

## C9 — new adversarial inputs (verifier's own; none appear in REDTEAM / FIX / FIX-loop2 / VERIFY-1)

78 new inputs: routing 17 (+6 coursework/controls), honesty 15 + 3 voice orderings, classifier 15 deny + 9 allow,
dedup/zone 16, injection 3. Wrong results, each reproducible:

| Defect | Input(s) | Wrong result | Repro |
|---|---|---|---|
| **D6 routing** | 1:1 Troy "my UA 902 check-in deadline is tonight, can you handle it" / "check me in for UA 902 before the deadline tonight"; Troy "my DS-160 visa form is due Friday" / "fill out my DS-160 …"; Sam "my DBA filing deadline for the LLC is Friday" / "file my DBA …"; Finn "pay the IRS 941 payment due Friday", "my MBA loan payment is due Monday, can I afford it", "set up autopay for my MBA loan payment due Monday", "pay my yoga instructor, the payment is due Monday", "sign my mortgage papers before the due date", "roll my NVDA 200 calls before the deadline Friday"; Flex "my yoga instructor says the class pass payment is due Monday"; Sam "my new job assignment in Germany starts Monday…" | `primeLaneDecision` -> elle/iris, intent `perform` -> deterministic follow-up DM; group "MBA loan" finn->iris, "job assignment" sam->iris | `bun mut-verify-114-2/probe-intent.ts <tree>`, `probe-routing.ts <tree>` |
| **D7 classifier** | "Residency4, present your research proposal", "Residency_4: …", "ResidencyIV: …", "Ｒｅｓｉｄｅｎｃｙ 4: …", "Office-hours: bring your proposal draft", "Oﬃce hours: …", "Office hours: …", "Office  hours: …", "Re­sidency 4: …", "Residence weekend: …", "Weekend intensive: …", "Doctoral consortium: …", "Academic conference: present your paper", "Cohort gathering: bring your case analysis" | accepted (`null`) | `bun mut-verify-114-2/probe-exec.ts` |
| D7-over | "Program evaluation report", "Case analysis: Stripe payments", "Literature review: tuition pricing models", "Holiday retail sales analysis", "Final paper: … trip to bankruptcy", "Business plan: corporate retreat startup", "Class participation reflection paper", "Team project: Ford plant visit report" | refused (recoverable; accepted-cost class) | same |
| **D8 dedup zone** | "Research Proposal" `2026-10-30T12:00:00Z` + `time_zone: Asia/Tokyo`; `2026-10-30` + `time_zone: Europe/London` | inserted a 2nd row (1 POST each) | same |
| **D9 honesty, voice** | write in flight + `text.done` "Done, I've added the Research Proposal for Oct 30." | spoken raw (finalize is a pass-through with no results) | `bun mut-verify-114-2/probe-honesty.ts` (V-a) |
| **D10 honesty, vocab** | own failed write + "It is on your list for Oct 30." (AC-F2-35 phrase), "It's in.", "Penciled it in…", "Handled…", "Booked it…", "Sorted! …", "Your RP is good to go…", Spanish, full-width "Ａｄｄｅｄ…", "Got it on there…" | false claim kept after the truthful line | same (H1–H11) |
| D10b | teammate "It's in, Elle got it." / "Elle handled that one for you." after the writer's failure | UNCHANGED, no truthful line | same (H12/H13) |
| D10c | clean 1-item write + "I've added all 5 assignments…"; no write call + "I've added your Research Proposal to Nexus." | UNCHANGED | same (H14/H15) |
| D11 chunk | teammate in a later chunk of a durable group turn | `turnNexusWriteUses` not in resume state -> unguarded | source: huddle.functions.ts:2136, :6889-6908 |
| obs | "Eastern Standard Time" (Windows/Graph name) | refused ambiguous-date (recoverable) | probe-exec |

**C9: REFUTED.**

## Verdict

| Claim | Verdict |
|---|---|
| C1 F2 ACs | REFUTED (F2-35, F2-45 NOT MET; F2-11/F2-14 fixture-only; F2-10/14 shared-with-F1 NOT MET by construction) |
| C2 owner rules | REFUTED (D7 canonicalisation of the owner's own meeting example; D8 input-zone dedup) |
| C3 honesty | REFUTED (D9 voice speaks a false save while the write is in flight; D10 vocabulary leaks incl. the AC's own phrase) |
| C4 routing | REFUTED (D6: flight/visa/tax-form numbers, tickers, DBA/MBA/instructor are STRONG and skip vetoes) |
| C5 identity/url/headers | CONFIRMED |
| C6 read-only | CONFIRMED |
| C7 suites + tsc | CONFIRMED (counts match exactly) |
| C8 mutations | CONFIRMED (10/10 FIRED: m1 m2 m5 m6 m7 + loop-2 n1–n5) |
| C9 new adversarial | REFUTED |

**Overall: REFUTED.** Loop-1's D1–D5 inputs are fixed and their guards are real. Blocking now:
**D7** (the brief's own canonicalisation spellings of "Residency"/"Office hours" are accepted -- the deny
regexes run on the raw, un-normalised title with ASCII word boundaries), **D9** (voice: the call-start hold
releases the RAW reply at `text.done` while the write is pending), **D10/H2** (AC-F2-35's named phrase survives),
**D6** (deterministic out-of-lane 1:1 hand-offs for travel/finance/business asks; F2-45). D8 is blocking per the
rule as stated but needs a non-ET `time_zone`. The pattern across D6/D7/D10 is the same one loop 1 named:
the "structural" redesigns are still word lists (WRITE_TALK, DENY_*, strong words/patterns), so each leaks on
the next spelling the list does not hold.
