# Fix pass, loop 3: the loop-2 verifier's REFUTED findings D6-D11 on `write_nexus_assignments`

<!--
WHAT:          Fix log for docs/VERIFY-nexus-write-tool-2.md (loop-2 verdict REFUTED): per defect D6..D11
               (and the non-blocking H1-H15 / V-a..V-c / D11 rows) -- status, the test that pins each
               verifier input, the mutate.sh verdict proving each new guard, every changed assertion and
               why, and the blast radius mapped to claims C1-C9.
WHY:           Two patch rounds leaked because the defences were WORD LISTS (WRITE_TALK sentence filter,
               DENY_* regexes on the raw title, "strong" words/patterns for routing). Loop 3 removes
               word-list dependence from every path where a wrong answer reaches the owner: honesty is
               code-built from results (no model sentence survives a failed write), routing context is
               the owner's REAL course list from Nexus, the kind filter runs on a canonical form, and the
               dedup day is always the course's zone.
SUPERSEDES:    nothing. RESPONDS TO docs/VERIFY-nexus-write-tool-2.md. Builds on
               docs/FIX-nexus-write-loop2.md, whose D3 sentence filter (WRITE_TALK / mentionsItem), D5
               generic course-code regex + mba/dba/instructor/professor strong words, and D1 "time_zone
               argument decides the day" are REPLACED here, as stated per section.
SUPERSEDED-BY: nothing -- current.
EVIDENCE:      branch fix/nexus-write-loop3 from origin/claude_nexus-write-tool-fixed 6b11bae, pushed to
               claude_nexus-write-tool-fixed (PR #114). scripts/nexus-write-loop3.test.ts;
               `bash scripts/run-nexus-fix-suites.sh`; mutation anchors/replacements in mut-loop3/.
               Offline only: fetch mocked, no live Nexus/Huddle, no DB or board writes.
-->

Written as the work goes. Status words: **fixed** = the verifier's input is now a passing test and the
mechanism is proved by a mutation; **not fixed** = with the reason.

## D7 — kind filter ran on the RAW title (Residency4 / ResidencyIV / full-width / ligature / NBSP / soft hyphen)

**Status: fixed** (owner-specified design: canonicalise before any rule; extend the deny vocabulary; the
code-built saved list of D10 is the owner-visible backstop for any vocabulary gap).

Mechanism (`canonicalTitle` + `classifyNonDeliverable`, nexus-write.server.ts): every kind rule now reads ONE
canonical form -- NFKC; Unicode default-ignorable/format characters stripped (`\p{Default_Ignorable_Code_Point}`
+ `\p{Cf}`: soft hyphen, ZWSP/ZWJ/ZWNJ, U+2060 …); every non-letter/digit (incl. every Unicode space and
`- _ / . , :`) is one ASCII space; lower case; letter↔digit boundaries split ("residency4" -> "residency 4");
a roman numeral glued to a known meeting word split ("residencyiv" -> "residency iv"); spaces collapsed. The
allow-list and deny-anywhere regexes are rewritten against that form (no raw-text variants). Deny vocabulary
extended exactly as directed: residence, intensive, consortium, conference, cohort, immersion, weekend
(meeting/session); gathering, retreat, summit, convocation (event); commencement (admin, already there).
The split of letter↔digit is applied to every token (a superset of "after known meeting words"): it can only
make a deny or allow word visible, never hide one.

| Verifier input (D7) | Before | After | Test |
|---|---|---|---|
| "Residency4, present your research proposal" | accepted | meeting/session | L3-D7a, L3-D7d (executor, 0 POSTs) |
| "Residency_4: …" / "ResidencyIV: …" / full-width "Ｒｅｓｉｄｅｎｃｙ 4: …" | accepted | meeting/session | L3-D7a |
| "Office-hours: …" / "Oﬃce hours: …" (U+FB03) / NBSP / double space | accepted | meeting/session | L3-D7a, L3-D7d |
| "Re­sidency 4: …" (soft hyphen) | accepted | meeting/session | L3-D7a |
| "Residence weekend", "Weekend intensive", "Doctoral consortium", "Academic conference", "Cohort gathering" | accepted | meeting/session | L3-D7a |
| (probe extra) "On-campus residency week 2: research proposal presentation" | meeting | meeting | L3-D7a |
| (extra) ZWJ/ZWNJ/ZWSP/U+2060 inside "Residency", EM SPACE, "Office.hours", "RESIDENCY/4", "Session2", "SeminarIII" | — | meeting/session | L3-D7a |
| (extra) summit / retreat / convocation / commencement / immersion | — | refused | L3-D7a |
| controls: "Research Proposal", "Case Brief 7", "Break-even analysis", "Civic engagement paper", "研究提案", full-width "Ｒｅｓｅａｒｃｈ Ｐｒｏｐｏｓａｌ", "Test 2" | accepted | accepted | L3-D7c |

`canonicalTitle` itself is pinned by L3-D7b (8 spellings). Loop-2's L2-D2a..L2-D2l (owner's example in 11
punctuations, deny-wins-anywhere, allow-list, `Test-` prefix) stay green unchanged on the canonical rules.

Over-rejections the verifier listed ("Program evaluation report", "Case analysis: Stripe payments", …) are
unchanged: refused WITH a reason, nothing written -- the owner's accepted cost of deny-anywhere ("keep it
simple: refused with reason"). The new vocabulary adds a few more of that class ("Cohort analysis paper",
"Weekend reflection paper"); same treatment.

## Item 6 — an UPDATE passing the row's EXISTING stored title unchanged was refused (verifier's OQ-2 note)

**Status: fixed.** An update now reads its stored row once (`nexusGet("assignments", [["id", id]])`, `id` is
in d1's COMMON filterable set; matched by id again client-side). When the title passed equals the stored
title (`dedupTitle`, so spacing/case do not matter), the title is neither re-judged nor PATCHed. A NEW or
CHANGED title is still judged. The stored row also gives an update's result its title and course (for the
code-built saved list of D10) and its course zone for the date label.

| Input | Before | After | Test |
|---|---|---|---|
| update "Residency participation" (stored title, unchanged) + new date | refused meeting/session | updated, PATCH body `due_date` only | L3-K6a, L3-K6b |
| same, title spelled "residency  participation" | refused | updated | L3-K6c |
| update to a CHANGED meeting title "Residency 5 participation" | refused | refused, 0 PATCH | L3-K6d |
| a deliverable renamed "Office hours prep" | refused | refused, 0 PATCH | L3-K6e |
| update with no title | title = id | title/course = stored row's, date in course zone | L3-K6f, L3-K6g |

## D8 — the dedup day followed the MODEL's `time_zone` argument

**Status: fixed** (owner-specified design). The day used for dedup -- and the stored date's local label -- is
always computed in the COURSE's zone: `courseZoneOf(course)` = the course record's own `time_zone`/`timezone`/
`tz` when Nexus has one (a real `Area/City` region), else America/New_York. content.courses has no such
column today (nexus-hub sql/nexus_hub/002_app_tables.sql:53-71), so in production every course is ET until
Nexus adds one. The model's `time_zone` is validated for every input (garbage still refused) but USED only to
interpret a plain wall-clock date; for an ISO string with an offset/Z it plays no part.

One addition, stated so it is not mistaken for scope creep: for a PLAIN date the written calendar date
(`writtenDay`, "2026-10-30") is also a match key against the stored row's course-zone day. It never uses the
model's zone (it is the literal date text). Without it, "2026-10-30" + `America/Los_Angeles` (= Oct 31 02:59
ET) would have INSERTED a second "Research Proposal" -- a regression on an input the verifier recorded as
correct in loop 2.

| Input | Before | After | Test |
|---|---|---|---|
| `2026-10-30T12:00:00Z` + `time_zone: Asia/Tokyo` (verifier D8) | inserted, 1 POST | duplicate, 0 POSTs | L3-D8a |
| `2026-10-30` + `time_zone: Europe/London` (verifier D8) | inserted, 1 POST | duplicate, 0 POSTs | L3-D8b |
| `2026-10-30` + LA / PST / UTC | duplicate | duplicate (written day) | L3-D8c..e |
| `2026-10-30T15:00:00Z` + Pacific/Kiritimati | — | duplicate | L3-D8f |
| next ET day / Z instant on the next ET day + Pacific/Honolulu | — | inserted | L3-D8g, L3-D8h |
| course carrying `time_zone: America/Los_Angeles`: Oct 30 22:00 PT vs stored Oct 30 16:00 PT | — | duplicate (ET would split them) | L3-D8i |
| `due_local` of `2026-11-20` + Asia/Tokyo | "… GMT+9" | "Fri, Nov 20, 2026, 9:59 AM EST" (course zone) | L3-D8j |
| claim key with/without `time_zone` (plain and ISO) | could differ | equal | L3-D8k, L3-D8l |
| `resolveDueInstant` ISO + Tokyo / plain + Tokyo / garbage zone | — | zone ET / 14:59:59Z + writtenDay / refused | L3-D8m..o |
| source: dedup reads `courseZoneOf(course)`, `due.zone` appears nowhere | — | — | L3-D8p |

**Changed assertion:** `scripts/nexus-write-loop2.test.ts` L2-D1g asserted `resolveDueInstant(Z, _, "PT").zone
=== "America/Los_Angeles"` ("an explicit course zone is kept for an ISO instant"). That encoded loop 2's
"the time_zone argument IS the course zone", which the owner's D8 rule replaces; it now asserts
`America/New_York` (the argument is not used for an offset-bearing date). Not a weakening: the dedup
outcomes it protected (L2-D1a..k) all stay green unchanged.

## D6 — coursework routing captured travel / finance / business asks (flight numbers, forms, tickers, MBA/DBA/instructor)

**Status: fixed** (owner-specified design: coursework context is DATA FROM NEXUS, not a regex; vetoes first).

Mechanism:
- **Strong context = the owner's REAL courses.** New `lib/nexus/course-context.ts` (pure, client-safe) holds the
  owner's course codes and names; `nexusCourseMentioned(text)` matches a real code in any spacing ("MGT-782",
  "mgt 782", "MGT782") or a full course NAME of 2+ words / 8+ chars (a one-word name like "Strategy" is never
  context). Filled on the server by `lib/nexus/course-context.server.ts` `primeNexusCourseContext()` through the
  EXISTING read path (`nexusGet("courses")`, the same call `get_nexus_courses` makes, owner-filtered), cached for
  `NEXUS_COURSE_CONTEXT_TTL_MS` = 5 min, a cold read awaited ~1.5 s at most (then it finishes in the background),
  60 s back-off after a failure. The write tool refreshes the same cache whenever it reads the course list.
  Stale/empty cache = no strong course context (weak signals only). Injectable in tests
  (`setNexusCourseContext`). `runHuddleTurn` primes it before routing (resumed chunks too: the 1:1 prime
  hand-off reads it).
- **The capability names it as data:** agents.ts `requiresContext.strongSources: ["nexus-courses"]`, resolved in
  capabilities.ts `CONTEXT_SOURCES` -- no agent id, no course code in code.
- **Other strong context:** only `syllabus`/`syllabi`, and "Nexus" as the APP ("Nexus assignment(s)", "in/on/
  from/into (my) Nexus", a write verb "… to Nexus"), never followed by card/program/membership/application/
  interview/pass/lane/fitness/tracker.
- **Deleted:** the generic course-code regexes (`[A-Z]{2,4}[- ]?\d{3}`, `[a-zA-Z]{2,4}-\d{3}`). **Demoted to
  weak:** mba, dba, emba, doctoral, professor, prof, instructor, coursework.
- **Vetoes FIRST, and they win** (`capabilityContextPresent`): flight(s), airline(s), check-in/check in/checkin,
  boarding, visa(s), passport, seat, trip, hotel, loan(s), mortgage, IRS, tax(es), LLC, filing, job, payroll,
  invoice(s), client(s), customer, boss, quarterly, calls, puts, options, stock(s), shares, ticker, strike, yoga,
  gym, fitness, workout, + the loop-1/2 household words; `vetoPatterns`: a `$TICKER` cashtag.

Baselines are MEASURED, not typed: `bun mut-loop3/probe-routing.ts <tree> d6|cw` run on this branch and on a
`git archive origin/main` export (bee838b, same node_modules). Every D6 ask: PR == origin/main for the group
leader AND for `laneOwnerFor` from the addressed agent; `primeLaneDecision` null from every agent.

| Verifier D6 input (1:1 with) | loop 2 | loop 3 (= origin/main) | Tests |
|---|---|---|---|
| "my UA 902 check-in deadline is tonight…" / "check me in for UA 902…" (Troy) | -> elle, follow-up DM | no prime; lane null; group elle (main's theme scoring) | L3-D6a..d |
| "my DS-160 visa form is due Friday" / "fill out my DS-160…" (Troy) | -> iris | no prime; lane null | L3-D6a..d |
| "my DBA filing deadline for the LLC…" / "file my DBA for the LLC…" (Sam) | -> elle | no prime; lane null | L3-D6a..d |
| "pay the IRS 941 payment…" / "the IRS 941 payment is due Friday" (Finn) | -> iris | no prime; lane null | L3-D6a..d |
| "my MBA loan payment is due Monday, can I afford it" (Finn) | -> iris; group finn->iris | no prime; group **finn** | L3-D6a..d |
| "set up autopay for my MBA loan payment…" (Finn) | -> iris | group finn | L3-D6a..d |
| "pay my yoga instructor…" (Finn) / "my yoga instructor says…" (Flex) | -> iris | no prime | L3-D6a..d |
| "sign my mortgage papers…" / "when is the due date on my mortgage papers" (Finn) | -> iris | no prime | L3-D6a..d |
| "my new job assignment in Germany…" (Sam) | -> iris; group sam->iris | no prime; group **sam** | L3-D6a..d |
| "roll my NVDA 200 calls before the deadline Friday" (Finn) | -> elle | no prime | L3-D6a..d |
| (probe) visa papers, NVDA call options, "log my 5k run to Nexus fitness tracker", gym prof, flight for the EMBA residency | mixed | = main | L3-D6a..d |
| (extra) "$NVDA", passport paperwork, payroll report | — | = main | L3-D6a..d |

Coursework (loop-2 L2-D5e..g list + the verifier's 13 + MGT-702 / course-name spellings, 21 asks): group led
by Elle/Iris, both keep it in a 1:1 (`primeLaneDecision` = keep), Finn hands it to Elle/Iris (L3-D6e..g).
Data, not shape: without the course list, or for a course he does not have (MGT-999), the code is no
context; a stale list is not used; explicit "syllabus" still is (L3-D6h..n). A veto beats a real course
code (owner's order; L3-D6o -- accepted cost: "book the flight for my MGT-782 paper deadline" is not routed
as coursework). "NEXUS card / program / apply to NEXUS / interview" are not the app (L3-D6p). Data checks
(L3-D6q..s), veto-before-strong order (L3-D6t), priming before routing (L3-D6u), the primer through the read
path and owner-scoped, and Nexus-down -> weak only (L3-D6v..x).

**Test setup changed (no assertion changed):** `router-winners`, `router-redteam`, `nexus-write-tool`,
`nexus-write-fix`, `nexus-write-loop2` now inject the owner's course list (MGT-782, MGT-702) with
`setNexusCourseContext` after their imports -- the brief's "tests inject the owner's course list". Without
it, router-winners F2-42 failed 2 asserts ("I have a new paper due next month for MGT-782, add it" is
coursework only because MGT-782 is HIS course, which is now data). Every assertion in those files is
unchanged.

## D10 (H1-H15) + D11 — honesty on the TEXT path: no model sentence survives a failed write; a clean write always shows its list

**Status: fixed** for H1-H14, H16-H17 and D11 (owner-specified design, item 1). **H15 (no write call at all):
not fixed by filtering, by design** -- see Residuals; the code-built list is the backstop.

Mechanism (`presentNexusWriteTurn`, nexus-write-shared.ts) -- decided by the RESULTS alone, for the whole TURN:
- **(a) any write this turn did not persist** (failed / rejected / duplicate -- nothing new written / unknown /
  still in flight): EVERY agent reply of the turn is replaced. The writer's reply (else the first reply, else
  a new reply from the writer) is ONE code-built message: `Nexus write status:` + one bullet per item (saved
  / updated / already in Nexus / not saved + plain reason / unknown — check Nexus) + the fixed closing line
  (`NEXUS_WRITE_STATUS_CLOSING`). Every other reply's text becomes the fixed `NEXUS_WRITE_WITHHELD_REPLY`.
  Nothing is filtered, so no spelling, language or Unicode trick can leak. Code-built attachments on a reply
  (artifact chips, widgets) are kept; only model TEXT is replaced.
- **(b) every write persisted:** the writer's reply gets `Saved in Nexus:` + one bullet per item (title, due date
  in the COURSE's local time from D8, course code) -- built from the executor's results; updates read
  `• Updated: “title” — due … — course` using the stored row (item 6).
- **(c) D11:** `turnNexusWriteUses` (now `TurnNexusWriteUse[]` with the claim key) is persisted in
  `buildResumeState()` (`nexusWriteUses`) and re-seeded on resume; a SETTLED outcome from an earlier chunk is
  re-handed to an identical later call (`nexusWriteOutcomes` seeded from it). A write is recorded the moment
  it STARTS as `nexusWriteInFlightOutcome` (every item `unknown`) and replaced in place by its result, so a
  reply streamed/saved while it is in flight -- or a chunk that ends before it returns, or a writer killed by
  the `runBounded` deadline -- can only show "Unknown — check Nexus".
- **Wiring (huddle.functions.ts):** the per-agent `nexusWriteGuardedReply` call in the reply assembly is
  REMOVED (a write failing AFTER a teammate's reply was assembled must still replace it). `replies` stays raw
  (it is the resume state); `presentedReplies()` is applied at EVERY point a reply leaves the server: the 1:1
  stream, the mid-chunk stream, the partial and final chunk saves, the final result, the prior shown to later
  agents, and researched memory.
- **No word list on any runtime path:** `WRITE_TALK` / `mentionsItem` deleted. `enforceNexusWriteHonesty`
  (CLAIM_RE/DENIAL_RE) is kept only for its pre-loop-3 tests, documented as non-runtime, and L3-H0c asserts no
  runtime file calls it. `nexusWriteGuardedReply` survives as the single-reply view of the same rule (the
  voice gate uses it; no parsing).

| Verifier input | loop 2 | loop 3 | Test |
|---|---|---|---|
| H1 "It's in." / H2 "It is on your list for Oct 30." (AC-F2-35's phrase) / H3-H11 (Penciled, Handled, Booked, Sorted, "good to go", Spanish, full-width "Ａｄｄｅｄ", ZWSP, "Got it on there") | truthful line + claim kept | ONLY the code-built message | L3-H1 (14 inputs incl. ✅ and "Just kidding, it's in") |
| H12 teammate "It's in, Elle got it." after the writer's failure | unchanged, no truth shown | held back; the writer's slot carries the message | L3-H12 |
| H13 teammate "Elle handled that one for you." (teammate replied in an EARLIER wave) | unchanged | held back (slot 0); message on the writer's slot | L3-H13 |
| writer timed out (no reply) / no reply at all | — | first slot carries the message / one code-built reply from the writer | L3-H13b, H13c |
| H14 clean 1-item write + "I've added all 5 assignments…" | unchanged | text + `Saved in Nexus:` with exactly ONE bullet (title, course-local due, course) | L3-H14, H14b/c |
| update | — | `• Updated: “Research Proposal” — due Mon, Nov 2, 2026, 11:59 PM EST — MGT-782` | L3-H14d |
| H15 no write call + "I've added your Research Proposal to Nexus." | unchanged | unchanged, and NO code-built list (residual; see below) | L3-H15 |
| duplicate (nothing new) | code-built line + kept prose | the message, with the stored date + course | L3-H16 |
| a write still in flight | not covered | "Unknown — check Nexus" | L3-H17 |
| D11 teammate in a LATER chunk | unguarded (`turnNexusWriteUses` not in resume) | held back against the earlier chunk's failure (JSON round-trip of the resume state) | L3-D11a |
| wiring: resume type / buildResumeState / re-seed / settled outcome / in-flight-then-result | — | present | L3-D11b..f |
| every exit presented; no raw `replies` saved | — | 7 exits | L3-D10w, L3-D10x |

**Changed assertions (each encoded the REPLACED loop-2 design; the owner's loop-3 rule is strictly stronger):**
- `scripts/nexus-write-loop2.test.ts` L2-D3a (16 rows): expected "the code-built line" (loop 2's line, sometimes
  followed by surviving prose) -> now exactly `nexusWriteFailureMessage(results)`. L2-D3b ("unrelated sentences
  are KEPT after the line") -> no model sentence survives. L2-D3c ("all persisted: passes untouched") -> text +
  the code-built saved list. L2-D3e/f/g/i: exact loop-2 line strings -> the corresponding loop-3 bullet is
  present. L2-D3h ("a teammate silent about the write is untouched") -> replaced too (rule (a): EVERY reply).
  L2-D3j (source: per-agent `nexusWriteGuardedReply` with teammates' writes) -> source: `presentedReplies` over
  every write of the turn. L2-D3d, L2-D3k unchanged.
- `scripts/nexus-write-loop2.test.ts` L2-V4/L2-V7 (voice speaks "the code-built line") -> the code-built
  message; L2-V9 ("clean write passes untouched") -> text + saved list. (Revisited again by D9 below.)
- `scripts/nexus-write-tool.test.ts` F2-35 source check `const safeText = nexusWriteGuardedReply(` -> the
  turn-level `presentedReplies` definition AND `replies: presentedReplies(),` in the final result.
- `scripts/nexus-write-fix.test.ts` FX-G6 (`turnNexusWriteUses.filter((u) => u.agentId !== nextId)`) -> the
  presenter over ALL of the turn's writes (teammates' included).
The behavioural F2-35 / RT-H1..H5 / FX-H* / FX-G1..G3 assertions on `enforceNexusWriteHonesty` are unchanged and
green (that function is now test-only).

## D9 (V-a, V-c) — voice spoke a false save when a reply completed while the write was in flight

**Status: fixed** (owner-specified design, item 2). V-b (text BEFORE the call in the same response) stays a
residual, see below.

Mechanism (`createNexusWriteSpeechGate`, nexus-write-shared.ts + useVoiceCallRealtimeSpeak.ts):
- While ANY write call is pending (`noteToolCall` at `response.function_call_arguments.done`), `finalize` (every
  `text.done`) speaks, captions and persists NOTHING: the text is BUFFERED. Deltas are not stream-synthed
  (`holding`), and a held reply's streamed tail is discarded.
- Once every write result is in, the gate DELIVERS ONCE: any item not persisted -> ONLY the code-built failure
  message (`nexusWriteFailureMessage`, the same text the text path shows); every item persisted -> the
  buffered model text + this text, then the code-built `Saved in Nexus:` list. After a failed delivery the rest
  of the exchange says nothing.
- `finalize` returns `{ full, speak, mode }`: the hook captions/persists `full`; "whole" voices `speak` on its own,
  "append" (a clean write with nothing buffered: the hold is released when the result arrives, so the happy path
  keeps streaming latency) appends the list to the streamed tail. `finalize` can no longer pass text through
  while a write is unresolved (loop 2's V-a hole: it returned the raw text when no results were in yet).
- `flush()` at `response.done` delivers results that are in but undelivered (the follow-up reply was cut short
  by a barge or carried no text) -- always for a failure, for a success when text is buffered.
- `reset()` at the next user utterance stays DEFERRED until the delivery.

Tests: a simulator that drives the gate exactly as the hook does (deltas / text.done / response.done / tool
call / tool output / user utterance), pinned to the hook's source by L3-V20..V23.

| Order (verifier) | loop 2 | loop 3 | Test |
|---|---|---|---|
| V-a: write in flight, `text.done` "Done, I've added the Research Proposal for Oct 30." | spoken + captioned + persisted raw | nothing until the result; then ONLY the message; later model text silent | L3-V1..V3 |
| read tool returns first, model answers ("…I've also added your proposal.") | spoken raw | buffered; failed -> ONLY the message; clean -> buffered + reply + list, once | L3-V4..V6 |
| user talks mid-write (new auto-response) | reset deferred, reply spoken raw | buffered; ONLY the message; deferred reset lands; next exchange streams normally | L3-V7..V10 |
| text item after the function_call in the same response, then response.done | spoken raw at text.done | buffered; not released while pending; follow-up cut short -> response.done delivers ONLY the message; late text silent | L3-V11..V13 |
| V-c: failed write + "It is on your list for Oct 30." | line + claim kept | ONLY the message | L3-V14 |
| clean write, nothing buffered | streamed | streamed, then the list appended; persisted = reply + list | L3-V15..V17 |
| two writes, one fails | — | nothing until both are in; ONLY the message listing both | L3-V18, V19 |

**Changed assertions:** `scripts/nexus-write-loop2.test.ts` L2-V4/L2-V7/L2-V9 now read `finalize(...)`'s
`{ full, speak, mode }` (V4: speak = full = the message, mode whole; V7: speak = the message; V9: mode append,
full = reply + list, speak = list) -- the gate's return type changed, the protected behaviour did not weaken.
L2-V12 and `scripts/nexus-write-fix.test.ts` FX-V7 source regex `const full = gate.finalize(raw);` -> the new
call site (`const out = gate.finalize(raw);` + `void speak(out.speak …)` + `persist(… out.full)`). Unchanged and
green: L2-V1..V3, V5, V6, V8, V10, V11, V13; FX-V1..V6, FX-V8; RT-H6 (still finds `gate.finalize(raw)`).

## Mutations (mutate.sh; anchors/replacements are FILES in `mut-loop3/`, generated and checked to occur exactly once by `mut-loop3/make-anchors.py`; runner `bash mut-loop3/run-mutations.sh`; test cmd `bun scripts/nexus-write-loop3.test.ts`)

| # | Guard | File | Mutation | Must fail | mutate.sh verbatim |
|---|---|---|---|---|---|
| k1 | strip default-ignorable/format chars | nexus-write.server.ts | strip removed | L3-D7a | `FIRED: 'L3-D7a' failed with the defect reinstated. The guard is real.` |
| k2 | NFKC | nexus-write.server.ts | `.normalize("NFKC")` removed | L3-D7a | `FIRED: 'L3-D7a' failed with the defect reinstated. The guard is real.` |
| k3 | every non-letter/digit -> space | nexus-write.server.ts | only ASCII spaces collapsed | L3-D7a | `FIRED: 'L3-D7a' failed with the defect reinstated. The guard is real.` |
| k4 | letter↔digit split | nexus-write.server.ts | split removed | L3-D7a | `FIRED: 'L3-D7a' failed with the defect reinstated. The guard is real.` |
| k5 | meeting-word + roman split | nexus-write.server.ts | token returned unsplit | L3-D7a | `FIRED: 'L3-D7a' failed with the defect reinstated. The guard is real.` |
| k6 | classifier reads the canonical form | nexus-write.server.ts | raw lower-cased title | L3-D7a | `FIRED: 'L3-D7a' failed with the defect reinstated. The guard is real.` |
| k7 | extended deny vocabulary | nexus-write.server.ts | intensive/weekend/consortium/conference/cohort removed | L3-D7a | `FIRED: 'L3-D7a' failed with the defect reinstated. The guard is real.` |
| u1 | unchanged stored title not re-judged | nexus-write.server.ts | skip removed | L3-K6a | `FIRED: 'L3-K6a' failed with the defect reinstated. The guard is real.` |
| z1 | dedup in courseZoneOf(course) | nexus-write.server.ts | `dayZone = due.zone` | L3-D8b | `FIRED: 'L3-D8b' failed with the defect reinstated. The guard is real.` |
| z2 | written-day match key | nexus-write.server.ts | key removed | L3-D8c | `FIRED: 'L3-D8c' failed with the defect reinstated. The guard is real.` |
| z3 | ISO instant ignores the model zone | nexus-write.server.ts | ISO returns the argument's zone | L3-D8m | `FIRED: 'L3-D8m' failed with the defect reinstated. The guard is real.` |
| z4 | claim key on the written/ET day | nexus-write.server.ts | instant's ET day only | L3-D8k | `FIRED: 'L3-D8k' failed with the defect reinstated. The guard is real.` |
| z5 | the course record's own zone is used | nexus-write.server.ts | always the default | L3-D8i | `FIRED: 'L3-D8i' failed with the defect reinstated. The guard is real.` |
| r1 | vetoes BEFORE strong | capabilities.ts | order swapped | L3-D6o | `FIRED: 'L3-D6o' failed with the defect reinstated. The guard is real.` |
| r2 | course list is strong context (data source) | capabilities.ts | `anySource` removed | L3-D6f | `FIRED: 'L3-D6f' failed with the defect reinstated. The guard is real.` |
| r3 | no generic course-code regex | agents.ts | `[A-Z]{2,4}[- ]?\d{3}` re-added | L3-D6a | `FIRED: 'L3-D6a' failed with the defect reinstated. The guard is real.` |
| r4 | mba/dba/instructor/professor not strong | agents.ts | re-added to strong | L3-D6q | `FIRED: 'L3-D6q' failed with the defect reinstated. The guard is real.` |
| r5 | stale course list unused | course-context.ts | TTL check removed | L3-D6l | `FIRED: 'L3-D6l' failed with the defect reinstated. The guard is real.` |
| r6 | course list primed before routing | huddle.functions.ts | prime call removed | L3-D6u | `FIRED: 'L3-D6u' failed with the defect reinstated. The guard is real.` |
| r7 | one-word course names are not context | course-context.ts | `>= 1` word | L3-D6k | `FIRED: 'L3-D6k' failed with the defect reinstated. The guard is real.` |
| h1 | failed write -> code-built message | nexus-write-shared.ts | failure branch disabled | L3-H1 | `FIRED: 'L3-H1' failed with the defect reinstated. The guard is real.` |
| h2 | every other reply held back | nexus-write-shared.ts | other replies keep model text | L3-H12 | `FIRED: 'L3-H12' failed with the defect reinstated. The guard is real.` |
| h3 | saved list appended on success | nexus-write-shared.ts | list not appended | L3-H14 | `FIRED: 'L3-H14' failed with the defect reinstated. The guard is real.` |
| h4 | write recorded in flight | huddle.functions.ts | push removed | L3-D11f | `FIRED: 'L3-D11f' failed with the defect reinstated. The guard is real.` |
| h5 | write results in buildResumeState | huddle.functions.ts | field removed | L3-D11c | `FIRED: 'L3-D11c' failed with the defect reinstated. The guard is real.` |
| h6 | re-seeded on resume | huddle.functions.ts | starts empty | L3-D11d | `FIRED: 'L3-D11d' failed with the defect reinstated. The guard is real.` |
| h7 | final result is presented | huddle.functions.ts | raw `replies` | L3-D10w (final result) | `FIRED: 'L3-D10w every exit is presented: the final result' failed with the defect reinstated. The guard is real.` |
| h8 | in-flight = unknown | nexus-write-shared.ts | in-flight reported saved | L3-H17 | `FIRED: 'L3-H17' failed with the defect reinstated. The guard is real.` |
| v1 | voice buffers while pending | nexus-write-shared.ts | buffering disabled | L3-V1 | `FIRED: 'L3-V1' failed with the defect reinstated. The guard is real.` |
| v2 | failure delivers ONLY the message | nexus-write-shared.ts | raw text prepended | L3-V2 | `FIRED: 'L3-V2' failed with the defect reinstated. The guard is real.` |
| v3 | silence after a failed delivery | nexus-write-shared.ts | suppression removed | L3-V3 | `FIRED: 'L3-V3' failed with the defect reinstated. The guard is real.` |
| v4 | flush at response.done | nexus-write-shared.ts | flush returns null | L3-V12 | `FIRED: 'L3-V12' failed with the defect reinstated. The guard is real.` |
| v5 | reset deferred until delivery | nexus-write-shared.ts | reset always clears | L3-V7 | `FIRED: 'L3-V7' failed with the defect reinstated. The guard is real.` |
| v6 | hook calls flush | useVoiceCallRealtimeSpeak.ts | flush call removed | L3-V22 | `FIRED: 'L3-V22' failed with the defect reinstated. The guard is real.` |
| v7 | hook "whole" branch | useVoiceCallRealtimeSpeak.ts | branch disabled | L3-V20 | `FIRED: 'L3-V20' failed with the defect reinstated. The guard is real.` |

First run: r2 against L3-D6e returned `UNDETERMINED: the suite FAILED (rc=1) but no recognised failure marker named
'L3-D6e'` -- with the course-list source removed, the GROUP leader of the MGT-782-only asks is still Elle/Iris
through origin/main's pre-existing theme scoring, so L3-D6e does not move; the 1:1 keep decision does.
Re-targeted at L3-D6f (row above, FIRED). **35 run, 35 FIRED, 0 INERT, 0 NOT-APPLIED.** Every run printed
`restored: … matches HEAD` and `tree clean: … passes again on the restored tree`.

h4-h7, r6, v6, v7 are SOURCE assertions (the call sites live in an 8k-line server function and a React hook that
cannot run offline); the behaviour behind each is proved by the pure tests h1-h3/h8, r1-r5, v1-v5 fire on.

### The verifier's loop-2 mutation set re-run on loop-3 code (`bash mut-verify-114-2/run-mutations.sh`)

| # | Verdict (verbatim) | Note |
|---|---|---|
| m1 RT-H3 | `FIRED: 'RT-H3' failed with the defect reinstated. The guard is real.` | `enforceNexusWriteHonesty`, now test-only |
| m2 RT-D1 | `NOT-APPLIED: the anchor does not appear in src/features/huddle/lib/nexus/nexus-write.server.ts. NOTHING WAS TESTED.` | the same-day line became `days.has(…)` (D8 written-day key). Re-anchored as **m2b** (`mut-loop3/m2b.*`, test `bun scripts/nexus-write-redteam.test.ts`): `FIRED: 'RT-D1' failed with the defect reinstated. The guard is real.` |
| m5 RT-R1 | `FIRED: 'RT-R1' failed with the defect reinstated. The guard is real.` | |
| m6 FX-V6 | `FIRED: 'FX-V6' failed with the defect reinstated. The guard is real.` | |
| m7 RT-D3 | `FIRED: 'RT-D3' failed with the defect reinstated. The guard is real.` | |
| n1 L2-D2a | `FIRED: 'L2-D2a' failed with the defect reinstated. The guard is real.` | |
| n2 L2-D1h | `FIRED: 'L2-D1h' failed with the defect reinstated. The guard is real.` | |
| n3 L2-D3a N14 | `NOT-APPLIED: the anchor does not appear in src/features/huddle/lib/nexus/nexus-write-shared.ts. NOTHING WAS TESTED.` | expected: the WRITE_TALK sentence filter it mutates is DELETED by D10; the replacement guards are h1/h2 (FIRED) |
| n4 L2-D4a | `FIRED: 'L2-D4a' failed with the defect reinstated. The guard is real.` | |
| n5 L2-D5b | `NOT-APPLIED: the anchor does not appear in src/features/huddle/data/agents.ts. NOTHING WAS TESTED.` | the strong list changed (D6). Re-anchored as **n5b** (`mut-loop3/n5b.*`, test `bun scripts/nexus-write-loop2.test.ts`): `FIRED: 'L2-D5b' failed with the defect reinstated. The guard is real.` |

## Residuals (not fixed, and why)

- **H15 -- a hallucinated save with NO write call this turn** ("I've added your Research Proposal to Nexus." and
  nothing was called) is shown unchanged. Catching it would need reading the model's prose for save claims --
  exactly the word-list mechanism the owner ruled out. The structural backstop: EVERY real write now carries a
  code-built `Saved in Nexus:` list or `Nexus write status:` message, so a save claim WITHOUT one was not a write.
  (A UI badge for code-built blocks would make that signal unmissable -- not built; out of scope.)
- **V-b / text before the call** -- text the model emits BEFORE the function call in the same response is streamed
  (voice) or shown transiently (1:1 text, replaced by the final presented reply) before the call exists. Holding
  all voice text until `response.done` would cost every voice reply its streaming latency. Unchanged since loop 1.
- **Over-strip, by the owner's rule:** in a failed-write turn every other agent's reply is held back, including an
  unrelated answer; code-built attachments (artifact chips, widgets) stay. A duplicate counts as "did not persist"
  (nothing new was written), so it also takes the failure-message path.
- **D7 accepted cost:** deny-anywhere still refuses some real deliverables (the verifier's over-rejection list, plus
  e.g. "Cohort analysis paper", "Weekend reflection paper"), refused WITH a reason, nothing written.
- **D6 accepted cost:** a veto beats even a real course code ("book the flight for my MGT-782 paper deadline" is not
  routed as coursework). A cold start routes its first turn on weak signals if Nexus does not answer within ~1.5 s
  (the read completes in the background). The cache is per server process (single-owner deployment:
  NEXUS_OWNER_ID is server config). Client-side code (if any routes locally) has no course list -> weak only.
- **D8:** Nexus has no per-course time-zone column today, so every course is America/New_York; the per-turn claim
  key (computed before the course is resolved) uses the written date or the ET day.
- **Presentation index shift:** when a clean writer has NO reply of its own, its list is appended as a new reply at
  the end; a reply from a later chunk can shift it one slot (the client upserts by index; it self-corrects on the
  next poll).
- **An update whose stored row cannot be read** is labelled by its id (no title/course in the list line).
- Unchanged from earlier loops: F2-10/F2-14 "shared with F1" (cross-repo, by construction), W3 across server
  instances, MST/MT and "Eastern Standard Time" refused as ambiguous (recoverable), LLM-router path not measurable
  offline.

## Results

`bash scripts/run-nexus-fix-suites.sh` on the final commit:

| Suite | Result |
|---|---|
| scripts/nexus-write-redteam.test.ts | 39 passed, 0 failed (unchanged) |
| scripts/router-redteam.test.ts | 12 passed, 0 failed (course-list fixture injected; assertions unchanged) |
| scripts/nexus-write-tool.test.ts | 115 passed, 0 failed (F2-35 source check changed; fixture injected) |
| scripts/router-winners.test.ts | 39 passed, 0 failed (fixture injected; assertions unchanged) |
| scripts/nexus-read-tools.test.ts | 190 passed, 0 failed |
| scripts/cross-app-turn-gate.test.ts | 92 passed, 0 failed (G7/G8 green: no public route or `Input` schema change) |
| scripts/voice-toolset-hidden.test.ts | 36 passed, 0 failed |
| scripts/nexus-write-fix.test.ts | 51 passed, 0 failed (FX-G6, FX-V7 changed; fixture injected) |
| scripts/nexus-write-loop2.test.ts | 185 passed, 0 failed (L2-D1g, L2-D3a/b/c/e/f/g/h/i/j, L2-V4/V7/V9/V12 changed; fixture injected) |
| scripts/nexus-write-loop3.test.ts (new) | 315 passed, 0 failed |
| `npx tsc --noEmit -p .` | clean (exit 0) |
| scripts/barge-route.test.ts (not in the runner; a routing consumer) | 10 passed, 0 failed (same as origin/main) |

Mutations: 35 new -> 35 FIRED. Verifier's m1-m7/n1-n5 re-run: 7 FIRED, 3 NOT-APPLIED (targets replaced by
design), 2 of those re-anchored (m2b, n5b) -> FIRED.

## Blast radius

| File | Change | Feeds verifier claims |
|---|---|---|
| src/features/huddle/lib/nexus/nexus-write.server.ts | `canonicalTitle` + canonical kind rules + extended deny vocab (D7); stored-row read on UPDATE, unchanged title not re-judged, stored title/course on update results (item 6); `courseZoneOf`, `writtenDay`, course-zone dedup + labels, claim key, ISO ignores the model zone (D8); the course list refreshes the routing cache. The single outbound write call (`nexusWriteFetch`, one `fetch(`) is untouched; the new reads go through `nexusGet` (server owner set last). | C1 (F2-11/12/13/14/20), C2, C5 (unchanged: the verifier's probe C5 block re-run -- one owner, whitelisted body), C9 |
| src/features/huddle/lib/nexus/nexus-write-shared.ts | `presentNexusWriteTurn`, `nexusWriteFailureMessage`, `nexusWriteSavedList`, `nexusWriteStatusLine`, fixed closing / held-back lines, `nexusWriteInFlightOutcome`, single-reply `nexusWriteGuardedReply`; WRITE_TALK filter deleted; `enforceNexusWriteHonesty` test-only; speech gate rewritten (buffer / deliver once / flush / deferred reset) | C1 (F2-35), C3, C9 |
| src/features/huddle/lib/huddle.functions.ts | course list primed before routing; per-agent guard removed from the reply assembly; `presentedReplies()` at every exit (1:1 stream, chunk stream/saves, final result, prior, memory); write recorded in flight then replaced; `nexusWriteUses` in the resume state + re-seeded outcomes. `Input` schema unchanged. | C1 (F2-31/35), C3, C4 |
| src/features/huddle/hooks/useVoiceCallRealtimeSpeak.ts | speaks `out.speak` / persists `out.full`; whole vs append; `flush()` at response.done | C1 (F2-35), C3 |
| src/features/huddle/lib/capabilities.ts | vetoes first; `strongSources` via `CONTEXT_SOURCES` | C1 (F2-41..45), C4 |
| src/features/huddle/data/agents.ts | capability DATA: strong = syllabus/syllabi + `nexus-courses` + Nexus-as-app; generic code regex deleted; degree/teacher words weak; vetoes + `$TICKER` | C1 (F2-41..45), C4 |
| src/features/huddle/lib/nexus/course-context.ts (new), course-context.server.ts (new) | the owner's course list cache (pure) + bounded primer through `nexusGet("courses")` | C4; C6 (read-only: a GET through the read module, no new method/body/header) |
| scripts/*.test.ts, scripts/run-nexus-fix-suites.sh, mut-loop3/ | new suite, fixture injection, documented assertion changes, mutation set + routing probe | C7, C8 |

Not touched: `nexus.server.ts` (C6), `routing.ts`, `lib/voice/*` (the voice tool executor), the public routes and the
`Input` schema (cross-app gate G7/G8).
