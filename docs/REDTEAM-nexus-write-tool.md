# Red-team pass: `write_nexus_assignments`

<!--
WHAT:          An adversarial red-team pass over the Huddle -> Nexus assignment WRITE tool and its
               Elle/Iris prime routing: the spelling table it attacked with, every attack, its verdict
               (WRONG / HOLDS) with evidence, and the failing test that pins each WRONG.
WHY:           Tier-1 pre-pass (eds global rules, owner-approved 2026-10-27): each verifier round on
               Tier-1 work kept finding an input spelling the builder's own tests never tried. This
               pass tries those spellings BEFORE the PR's independent verifier.
SUPERSEDES:    nothing.
SUPERSEDED-BY: nothing -- current.
EVIDENCE:      target commit 507e13b (branch worktree-agent-a5321d2fac007d47a, base origin/main
               4809e2e); failing tests scripts/nexus-write-redteam.test.ts and
               scripts/router-redteam.test.ts on branch redteam/nexus-write; baseline routing
               measured by checking out 4809e2e in the same worktree. Offline only: fetch mocked, no
               live Nexus/Huddle, no DB writes.
-->

Scope: `src/features/huddle/lib/nexus/nexus-write.server.ts`, `nexus-write-shared.ts`, the dispatch
wiring in `huddle.functions.ts` and `voice/realtime-tools.server.ts`, and the routing data in
`data/agents.ts` + `lib/capabilities.ts` + `lib/routing.ts`. Nexus side read from the nexus-hub
working tree (`api/src/functions/d1.ts`). Acceptance criteria: nexus-hub
`docs/cross-app-agent/AC-syllabus-deliverables-write-tool.md` Feature 2 + RESOLUTIONS.

Run the failing tests: `bun scripts/nexus-write-redteam.test.ts` and `bun scripts/router-redteam.test.ts`.
Every `not ok` / `FAIL` line in them is a WRONG finding below. They are deliberately separate files so
the builder's own suites stay green (and `mutate.sh` attribution in them is undisturbed); fold them in
when fixing.

## 1. Spelling table (inputs and the verdict the tool's own conventions imply)

Sources: the tool schema's own field descriptions (`due_date` = "YYYY-MM-DD, or a full ISO datetime
WITH offset"; `due_time` = "HH:MM (24h)"; `time_zone` = "IANA zone"; `course` = "course code as the owner
says it ... or the course's exact name"), ECMAScript `Intl`/`Date.parse` (what the code actually calls),
the IANA tz database (which DOES contain fixed-offset legacy names `EST`, `MST`, `EST5EDT`), and the AC.

| Field | Input | Expected | Observed | Verdict |
|---|---|---|---|---|
| due_date | `Oct 30`, `10/30`, `30/10`, `10/30/2026`, `2026/10/30`, `20261030`, `Friday, October 30, 2026`, `end of week 9` | refuse, ask | ambiguous-date | HOLDS |
| due_date | `2026-02-29` | refuse | ambiguous-date | HOLDS |
| due_date | `2028-02-29` | accept | 2028-03-01T04:59:59Z (= Feb 29 23:59:59 EST) | HOLDS |
| due_date | `2026-10-30T23:59` (no offset) | course-local | 2026-10-31T03:59:00Z | HOLDS |
| due_date | `2026-10-30T23:59:00-07:00` / `+0530` / `Z` / `.000-04:00` | honour offset | honoured | HOLDS |
| due_date | `2026-10-30T23:59:00-07` (hour-only offset) | accept or refuse | refused (ambiguous) | HOLDS (safe) |
| due_date | `2026-10-30T23:59:60Z`, `+99:00`, `0000-01-01` | refuse | refused | HOLDS |
| due_date | `9999-12-31` | refuse or accept | accepted, iso `+010000-01-01T04:59:59Z` (Nexus will 4xx/5xx -> persisted:false) | HOLDS (fails closed) |
| due_date | `2025-01-01` (past) | no AC requires refusal | accepted silently, no flag | NOTE (no AC) |
| due_date | `null`, `""`, `TBD` | refuse undated | refused | HOLDS |
| due_time | `11:59pm`, `11:59 PM`, `noon`, `midnight`, `EOD`, `24:00`, `23:59:59.999` | refuse (not HH:MM) | refused | HOLDS |
| due_time | `7:00`, ` 23:59 `, `00:00` | accept | accepted | HOLDS (`00:00` for "due midnight" is the model's translation -- start of day; see NOTE) |
| due_time | DST spring gap `2026-03-08 02:30` ET (does not exist) | shift forward (03:30 EDT, 07:30Z) or refuse | **06:30Z = 01:30 EST, an hour EARLIER than the gap**, silently | WRONG-low (W13) |
| due_time | DST fall overlap `2026-11-01 01:30` ET | either occurrence | 05:30Z (first, EDT) | HOLDS |
| time_zone | `America/Los_Angeles`, `US/Eastern`, `EST5EDT`, `PST8PDT`, `America/Phoenix`, `UTC` | honour | honoured | HOLDS |
| time_zone | `ET`, `PST`, `Eastern`, `GMT-4`, `Z` | refuse (not IANA) | refused | HOLDS |
| time_zone | **`EST` / `est`** for an Oct 30 (EDT) deadline | the syllabus means Eastern (03:59Z) | **04:59Z -- one hour LATE**, accepted as a valid IANA fixed-offset zone | WRONG (W9) |
| time_zone | `MST` (fixed -7) | Arizona-correct; Denver in summer wrong | accepted | same class as W9 |
| title kind | `Residency 4`, `Residency participation`, `Class session 3`, `Zoom meeting`, `Present at residency`, `Live session`, `Webex session`, `Teams meeting`, `Attend lecture 5` | refuse meeting | refused | HOLDS |
| title kind | `Residency 4 – present ideas and insights from the readings` (the AC row) | refuse | refused | HOLDS |
| title kind | **`Residency 4: present your research proposal`**, `Kickoff meeting for final project`, `Office hours: project Q&A`, `Midterm exam review session` | refuse (a session with an incidental deliverable noun) | **accepted** -- "deliverable noun wins" | WRONG (W4) |
| title kind | **`Doctoral colloquium 2`, `Week 3 class`, `Class 5`, `Module 3 live call`, `Coaching call`, `Conference call`, `Advising appointment`, `Guest speaker`, `Study group`** | refuse (meeting) | **accepted** | WRONG (W5) |
| title kind | **`Thanksgiving`, `Thanksgiving break`, `Labor Day`, `Reading week`, `Mid-semester break`, `Last day to withdraw`, `Grades due`** | refuse (administrative, AC-F1-23 names holidays) | **accepted** | WRONG (W6) |
| title kind | `Reading: chapter 4` | not a graded deliverable | accepted | WRONG-low (W12) |
| title kind | `Group presentation at Residency 4`, `Presentation at Residency 4 (graded, 15%)` | judgment: the AC's own residency-presentation row is refused | refused (no "presentation" deliverable noun) | HOLDS per AC-F2-11 (override by rephrasing exists) |
| dedup | `research proposal`, `Research-Proposal`, `Research Proposal (20%)`, `“Research Proposal”`, trailing spaces, `Research Paper Proposal` same instant | duplicate | duplicate | HOLDS |
| dedup | **`Discussion Post` due Nov 8 and Nov 15 when a `Discussion Post` due Nov 2 exists** (recurring weekly deliverable) | insert both | **both `duplicate` of the Nov 2 row; note tells the agent to UPDATE (move) the Nov 2 row** | WRONG (W1) |
| dedup | **`Research Paper Peer Review` / `Research Paper Presentation` / `Paper` due Dec 9 when `Research Paper` due Dec 9 exists; `Case Study 2` / `Case Study Reflection` same day as `Case Study`** | insert (different deliverables) | **duplicate** (same-instant word-subset rule; every time-less date defaults to the same 23:59:59) | WRONG (W2) |
| dedup | **`Final Reflection` due Dec 1 when an UNDATED `Final Reflection` row exists** | duplicate + say the stored row has no date (offer update) | **duplicate, note says only "Already in Nexus"** -- the owner's date is dropped silently | WRONG (W7) |
| dedup | `研究提案` (non-Latin) twice | duplicate on the 2nd | **both inserted** (normTitle -> "") | WRONG-low (W14) |
| dedup | **two group agents, same item, args differ by one field (priority)**, same wave | one row | **two rows** (claimAction keys on the exact JSON; executor read-then-POST races) | WRONG (W3) |
| course | `MGT782`, `mgt-782`, `MGT 782`, `MGT–782` (en dash), `MGT_782`, exact name | c782 | c782 | HOLDS |
| course | `782`, `Strategic`, `MGT-782-W1` | not found | not found | HOLDS |
| course | `MGT-78` vs `MGT-782` vs `MGT-7821` (shared prefix) | each exact | each exact | HOLDS |
| course | same code in a prior term | ambiguous | ambiguous | HOLDS (safe) |
| course | archived course | n/a: `content.courses` has no status/archived column (d1.ts:332-337) | -- | N/A |
| course | `!!!` when some course's code normalises to "" (e.g. `--`) | not found | **resolves to that course** | WRONG-low (W15) |
| identity | `owner`/`user_id`/`email` in args or items | dropped | dropped (whitelist; builder test F2-04) | HOLDS |
| identity | `assignment_id: "x&owner=evil#frag"`, `"../../courses?id=1"` | encoded, owner set last | `?id=x%26owner%3Devil%23frag&owner=own` | HOLDS |
| identity | foreign-owner assignment id | 404 | Nexus PATCH reads the pre-image with `id = $1 AND <ownerClause>` -> 404 (d1.ts:1284-1289) | HOLDS |
| points | `12.5` | refuse or report | **silently dropped, item reports `persisted:true` with no mention** | WRONG-low (W16) |

## 2. Attacks and verdicts

Severity: HIGH = a wrong row in Nexus, a lost deliverable, a false "saved", or an unrelated lane
stolen with a follow-up DM fired; MEDIUM = wrong but visible/recoverable; LOW = edge spelling.

### Honesty guard (AC-F2-35)

- **W8 HIGH -- incidental denial words disable the guard.** `DENIAL_RE` short-circuits on ANY of its
  words anywhere in the reply. With the write stubbed 500: "Done! Your Research Proposal is in Nexus,
  and nothing failed." and "All set -- I was unable to find any conflicts, so the Research Proposal is
  saved." pass through UNCHANGED (probe output). Test: `RT-H1 'nothing failed' does not launder a
  false save`, `RT-H2 'unable to find any conflicts' does not launder a false save`.
- **W10 HIGH -- mixed batch: one truthful denial launders a false claim about another item.** Final
  Paper timed out (`persisted:'unknown'`), Residency 4 was rejected. "Final Paper is saved. Residency 4
  wasn't added because it's a meeting." passes unchanged. Test: `RT-H3 mixed batch`.
- **W11 MEDIUM -- success claims outside `CLAIM_RE` are appended to, not replaced.** "Your Research
  Proposal is now in Nexus for Oct 30.", "Got it -- ..., it's in.", "I've put the Research Proposal into
  Nexus.", "Research Proposal ✅" keep the success claim and get "Not saved to Nexus: ..." appended -- a
  self-contradicting reply. AC-F2-35 requires "no success claim". Test: `RT-H4 'is now in Nexus' claim
  is not left standing`.
- **W17 HIGH -- group turn: the suppressed teammate's reply is unguarded.** In a parallel wave the
  second agent's identical call is short-circuited by `claimAction` and recorded as
  `recordToolUse(winner.id, c.name, "Nexus write -- already done this turn", true)` -- `ok:true` and NO
  `detail` (huddle.functions.ts, the `already_done_this_turn` branch). The guard reads only that agent's
  own `r.toolUses` and skips a use with no detail, so the second agent's "I've added it." stands even when
  the first agent's write failed (probe: unchanged). A teammate that never called the tool ("Elle saved
  it") is likewise never checked. Test: `RT-H5 suppressed duplicate carries the first write's outcome`
  (source-shape, like the builder's F2-31/F2-36 checks).
- **W18 HIGH -- voice path has no runtime honesty at all.** `realtime-tools.server.ts` returns
  `JSON.stringify(await executeNexusWriteTool(...))` to the Realtime model, which voices its own words;
  no file under `lib/voice/` references `enforceNexusWriteHonesty` or any post-generation check
  (grep: 0 hits). AC-F2-35 says honesty "must not rest on a prompt line alone"; on voice it rests on the
  tool-result `note` alone. Test: `RT-H6 voice path enforces write honesty`.
- HOLDS: a 200 with no row id -> `persisted:false`; tool-level `ok:false` errors
  (`courses_unreadable`, `batch_too_large`) replace an "I added" claim; timeouts are `unknown`, never
  success; the full result is recorded untruncated in `detail`, so the JSON parse in the guard is not
  defeated by truncation.

### Dedup (AC-F2-14/15, AC-F1-11..16)

- **W1 HIGH -- recurring deliverables with one title collapse onto the first.** Rule 1 (same
  normalised title => same row) ignores the due date entirely. Existing "Discussion Post" (Nov 2); adding
  "Discussion Post" Nov 8 and Nov 15 -> both `duplicate` of `dp1`, nothing inserted, and the note says
  "call again with assignment_id and due_date to update it" -- which would MOVE week 1's post. Weekly
  "Discussion Post"/"Reflection"/"Quiz" titles are normal in syllabi. Test: `RT-D1`.
- **W2 HIGH -- same-day word-subset over-match.** Every time-less date defaults to 23:59:59 local, so
  any two items due the same DAY share an instant, and rule 2 then fires on any word subset:
  "Research Paper Peer Review", "Research Paper Presentation", even "Paper" -> duplicate of "Research
  Paper"; "Case Study 2" -> duplicate of "Case Study". Same defect class AC-F1-12 forbids. Test: `RT-D2`.
- **W3 HIGH -- concurrent near-identical writes insert twice.** Two calls in one wave (Elle + Iris both
  prime) whose args differ in one optional field both read "no row" and both POST: 2 rows titled
  "Research Proposal". `claimAction` keys on the exact JSON of the args. AC-F1-16 (concurrency) is the
  shared dedup's contract. Test: `RT-D3`.
- **W7 MEDIUM -- an undated stored row swallows the owner's date silently.** Existing undated "Final
  Reflection"; add with due Dec 1 -> `duplicate`, note "Already in Nexus ... Nothing new was added." The
  differs-check is `storedMs !== null && ...`, so a NULL stored date never triggers the "DIFFERENT due
  date ... update it" hint. Test: `RT-D4`.
- **W14 LOW -- non-Latin titles never dedup** (normTitle strips to ""): `研究提案` twice -> two inserts.
  Test: `RT-D5`.
- HOLDS: case/punctuation/unicode quotes/trailing space/"(20%)"/"20 percent of the grade"; "Research
  Paper" (Dec 9) does not swallow "Research Paper Proposal" (Oct 30); retry-after-timeout -> duplicate
  (builder test).

### Kind filter (AC-F2-11, AC-F1-20..23, OQ-11)

- **W4 HIGH -- a session with an incidental deliverable noun is filed as an assignment.** "Residency
  4: present your research proposal" -- the same shape as the row the owner deleted by hand -- is
  accepted because "proposal" is a deliverable noun and "the noun wins". Also "Kickoff meeting for final
  project", "Office hours: project Q&A", "Midterm exam review session". Test: `RT-K1`.
- **W5 HIGH -- meeting vocabulary gaps.** "Doctoral colloquium 2" (a DBA staple), "Week 3 class",
  "Class 5", "Module 3 live call", "Coaching call", "Conference call", "Advising appointment", "Guest
  speaker", "Study group" are all accepted as assignments. Test: `RT-K2`.
- **W6 MEDIUM -- administrative/holiday gaps.** "Thanksgiving", "Thanksgiving break", "Labor Day",
  "Reading week", "Mid-semester break", "Last day to withdraw", "Grades due" accepted; AC-F1-23 names
  holidays explicitly. Test: `RT-K3`.
- **W12 LOW -- "Reading: chapter 4"** accepted as a dated graded deliverable. Test: `RT-K4`.
- HOLDS: every AC-listed meeting word; "Seminar paper" and "Residency 4 reflection paper" accepted.

### Dates (AC-F2-10, AC-F2-13)

- **W9 MEDIUM -- `time_zone: "EST"` stores an Eastern deadline one hour late during EDT.** "11:59 pm
  EST" is how US syllabi write Eastern time year-round; the model passes it through, `Intl` accepts
  `EST` as a fixed UTC-5 zone, and Oct 30 23:59 is stored 04:59Z instead of 03:59Z. Same for `est`, `MST`.
  The schema says "IANA zone" and EST technically is one, which is exactly why it slips through. Test:
  `RT-T1`.
- **W13 LOW -- a nonexistent spring-forward time is moved EARLIER.** 2026-03-08 02:30 ET -> 06:30Z
  (01:30 EST). The conventional resolution (and Temporal's "compatible") is 03:30 EDT (07:30Z); a
  deadline must never move earlier. Test: `RT-T2`.
- NOTE (no AC): past dates are accepted with no flag; "due midnight" -> `00:00` is start-of-day if the
  model translates it that way (the tool refuses the word "midnight" itself, which HOLDS).

### Course resolution (AC-F2-16..19)

- **W15 LOW -- a reference that normalises to "" matches a course whose code normalises to "".**
  Test: `RT-C1`.
- HOLDS: all code spellings, exact names, shared prefixes, null-code exact name, partial name, same code
  across terms (ambiguous). Archived courses: no such column exists.

### Owner / identity / injection

- HOLDS throughout: no identity property in the schema; whitelist read; `owner` set last via
  `searchParams.set`; ids URL-encoded; Nexus PATCH is owner-scoped and parameterised (d1.ts:1251-1301);
  POST writable list excludes `user_id`; header ref is built from server/turn ids, not model args.
- **W16 LOW -- `points: 12.5` silently dropped** with `persisted:true` and no note. Test: `RT-P1`.

### Routing (AC-F2-40..46)

Baseline = origin/main 4809e2e, measured by checking it out in this worktree and running the same probe.

- **W19 HIGH -- non-coursework asks newly stolen by Elle/Iris (group, deterministic path).** The prime
  block returns before stickiness/topic and the triggers `assignment`, `nexus`, `deliverable` plus the
  pair `paper(s)` + `due/submit/deadline` are generic English:

  | ask | baseline | now |
  |---|---|---|
  | change my seat assignment on the flight to Denver | troy-lennox | iris-chase |
  | renew my NEXUS card before the trip (US/Canada trusted-traveler card) | troy-lennox | iris-chase |
  | the client deliverable for Acme is due Friday | ezra-miles | iris-chase |
  | the quarterly report deliverable is due | ezra-miles | iris-chase |
  | what is the nexus of AI and finance | tess-sutton | iris-chase |
  | my tax papers are due April 15 | iris-chase | elle-rowan (prime reason) |
  | toilet paper is due for restock | iris-chase | elle-rowan (prime reason) |

  Test: `RT-R1`.
- **W20 HIGH -- 1:1 hand-off out of the agent's OWN lane, with a follow-up DM.** `primeLaneDecision`
  runs before everything in `laneOwnerFor` and the 1:1 follow-up: Troy in a 1:1 asked "change my seat
  assignment on the flight" now defers to Iris (baseline: keeps it) and `deliverIfOwner` enqueues a
  durable turn in `dm-iris-chase` (with a phone push). Finn with "my tax papers are due April 15" defers
  to Elle (baseline: keeps). Test: `RT-R2`.
- **W21 HIGH -- the AC-F2-42 symptom survives for nouns outside the trigger list.** In a 1:1 with Elle,
  "update the due date for my case analysis" -> `laneOwnerFor` = eli-vaughn 0.32 (exactly the defect
  AC-F2-42 was written for, with "case analysis" instead of "research paper"); group: same -> eli-vaughn.
  "my professor moved the paper to Dec 12, update it" -> eli-vaughn (group). Test: `RT-R3`.
- HOLDS: the AC's 10 phrasings; board/grocery/typo asks; "buy paper towels"; "assign the grocery run".

## 3. Results

21 WRONG findings (W1-W21), each pinned by at least one failing test. Measured on 507e13b:
`bun scripts/nexus-write-redteam.test.ts` -> 0 passed, 39 failed; `bun scripts/router-redteam.test.ts`
-> 0 passed, 12 failed. The builder's own suites are untouched and still green (115/115, 39/39).

| Severity | Findings |
|---|---|
| HIGH (12) | W1 recurring titles collapse, W2 same-day subset over-match, W3 concurrent double insert, W4 session-with-noun filed, W5 meeting vocabulary gaps, W8 stray denial word launders a false save, W10 mixed-batch laundering, W17 group teammate unguarded, W18 voice unguarded, W19 other lanes stolen (group), W20 1:1 hand-off out of own lane + DM, W21 AC-F2-42 symptom for "case analysis" |
| MEDIUM (4) | W6 holiday/admin gaps, W7 undated row swallows the new date, W9 `EST` one hour late, W11 unknown claim phrasing appended-to not replaced |
| LOW (5) | W12 readings, W13 DST-gap moved earlier, W14 non-Latin dedup, W15 empty-normalised course ref, W16 float points dropped silently |

Not attacked live (offline brief): AC-F2-40's LLM-router path -- the LLM router prompt now carries
`[prime for: …]` on Elle/Iris, so W19's over-match may also appear there; measure with the
`test-agent-serverfn` harness before claiming either way.
