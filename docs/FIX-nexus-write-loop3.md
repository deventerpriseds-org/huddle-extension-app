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
