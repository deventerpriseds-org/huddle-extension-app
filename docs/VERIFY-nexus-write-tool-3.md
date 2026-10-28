# VERIFY nexus-write-tool, loop 3 — independent re-verification of huddle PR #114 (head ebd805b)

<!--
WHAT:          Independent, offline re-verification of PR #114 (branch claude_nexus-write-tool-fixed,
               head ebd805b) after the loop-3 fix pass: per-claim verdicts C1..C9 with observed evidence,
               every defect classified BLOCKING / NON-BLOCKING with realistic likelihood.
WHY:           Loop 2 (docs/VERIFY-nexus-write-tool-2.md) returned REFUTED (D6 routing, D7 raw-title kind
               filter, D8 model-zone dedup, D9 voice spoke while a write was pending, D10 honesty vocab,
               D11 resume state). The fixer (docs/FIX-nexus-write-loop3.md) reports all fixed with
               structural designs; this pass re-derives every claim. FINAL loop before the owner decides.
SUPERSEDES:    nothing. FOLLOWS docs/VERIFY-nexus-write-tool-2.md (branch claude_verify-nexus-write-tool-2).
SUPERSEDED-BY: nothing -- current.
EVIDENCE:      this file; probes + mutation anchors in mut-verify-114-3/ on branch
               claude_verify-nexus-write-tool-3. Offline only: fetch mocked, no live Nexus/Huddle,
               no DB or board writes.
-->

Started 2026-10-28 19:18 UTC (budget 60 min, ends 20:18). Worktree branch `verify-nexus-write-tool-3` from
`origin/claude_nexus-write-tool-fixed` @ `ebd805b`. Written as the work goes.

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
| script RC | 0 |

`npx tsc --noEmit -p .` -> exit 0, no output. Every number matches the fixer's Results table. **C7: CONFIRMED.**

## C2 — owner rules (D7 canonical kind filter, D8 course-zone dedup, item 6)

Probes: loop-2's `bun mut-verify-114-2/probe-exec.ts` re-run on ebd805b (re-derivation), then the new
`bun mut-verify-114-3/probe-exec.ts` (fake fetch; output saved in `mut-verify-114-3/probe-exec.out`).

**Loop-2 inputs, re-derived:** all 15 D7 spellings ("Residency4", "Residency_4", "ResidencyIV", full-width,
"Office-hours", U+FB03 ligature, NBSP, double space, soft hyphen, Residence weekend, Weekend intensive, Doctoral
consortium, Academic conference, Cohort gathering, On-campus residency) -> `meeting/session`. Both D8 inputs
(Z + Asia/Tokyo, plain + Europe/London) -> duplicate, 0 POSTs. Every loop-2 C2 "ok" row unchanged (ET/DST math,
batch repeats, claim keys equal, EST-in-July, EDT-in-December). **D7 and D8 as reported: fixed.**

**New attacks on the canonicaliser (titles that ARE meetings; want non-null):**

| Input | Result | Why |
|---|---|---|
| "Rеsidency 4: …" (Cyrillic е U+0435) | `null` (accepted) | NFKC does not fold cross-script homoglyphs |
| "Οffice hours: …" (Greek Ο U+039F) | `null` | same |
| "ResidencyFour: …" | `null` | glued spelled-out numeral not split (only digits/roman) |
| "Residancy 4: …" (syllabus typo) | `null` | vocabulary |
| "Residential week 2: …" (UK programmes' word for a residency) | `null` | vocabulary |
| "Mtg 4: …", "Town hall: …", "Virtual huddle: …", "Res. 4: …", "R E S I D E N C Y 4: …" | `null` | vocabulary / abbreviation |
| "Synchronous meetup", "Live Zoom", "Residency four", "On-campus intensive (Res. 4)", "In-residence" | `meeting/session` | ok |

These are a word list's edges, not a canonicalisation hole: every spelling of the owner's two named words
("Residency", "Office hours") that an extractor produces from Latin text is now refused. A wrong row would be
written for the inputs above (BLOCKING by the brief's definition) but each needs a homoglyph, a typo, a UK term
or an abbreviation in the source syllabus -- **low likelihood** with a real model, and every accepted title is
shown verbatim in the code-built `Saved in Nexus:` list (the owner's stated backstop).

**Over-rejection of real deliverables (refused WITH a reason, nothing written; owner-accepted class):**
"Cohort analysis paper", "Weekend reflection paper", "Conference paper submission" -> meeting/session;
"Final project: summit pricing case", "Case study: Ritz-Carlton retreat strategy" -> event;
**"Research proposal (Session 3 deliverable)"** and **"Peer review of Class 2 proposals"** -> meeting/session.
The last two are the realistic ones: syllabi organised by "Session N"/"Class N" are common, and a model that
keeps the session label in the title gets a refusal. NON-BLOCKING (recoverable; the model can retry without
the label), **moderate likelihood**.

**item 6 (UPDATE with the stored title):** stored "Residency participation" + new date -> updated, PATCH body
`{"due_date":…}` only; same title with a trailing period -> treated as unchanged, updated; renaming a deliverable
to "Residency 4 kickoff" -> refused, 0 writes; a Cyrillic look-alike of the stored title -> judged as new and
refused (safe direction). Unknown id -> PATCH 404 -> `not_found`, persisted false. OK.

**D8 written-day rule -- judged.** The rule is a UNION: a plain date is a duplicate if EITHER its written date OR
its instant's course-zone day equals the stored row's course-zone day. Observed:

| Input (stored: Research Proposal Oct 30 ET; Discussion Post Nov 2 ET) | Result |
|---|---|
| Discussion Post plain 11-02 | duplicate (written day) -- correct |
| Discussion Post plain 11-01 + `America/Los_Angeles` (instant = Nov 2 02:59 ET) | **duplicate** of the Nov 2 post |
| Research Proposal plain 10-29 + `Pacific/Pago_Pago` (instant = Oct 30 06:59 ET) | **duplicate** of the Oct 30 row |
| Discussion Post plain 11-03 + `Pacific/Kiritimati` (instant = Nov 3 04:59 ET) | inserted, stored `2026-11-03T09:59:59Z` (4:59 AM ET) |
| Research Proposal 10-30 + due_time 23:59 + Asia/Tokyo | duplicate |
| Research Proposal `2026-10-31T00:30:00-04:00` | inserted (Oct 31 ET) -- correct |

Judgement: the written-day key is sound (it is the literal date text, never the model's zone) and it closes a
real regression. The cost is that a far-from-ET `time_zone` on a plain date can make a deliverable the owner
wrote for day N a "duplicate" of a row on day N+1 (the instant check in course zone is also applied). That is
consistent with the owner's rule as stated (the course-zone day of the instant IS N+1), the result is a refusal
that names the stored date (code-built "Already in Nexus … due Mon, Nov 2"), and it needs the model to attach a
non-ET zone to a syllabus date -- NON-BLOCKING, low likelihood. The insert case (Kiritimati) stores a 4:59 AM ET
due time: the model's zone still shifts the stored INSTANT of a plain date; pre-existing since loop 1, outside D8.

**C2: CONFIRMED** for the owner's rules as specified (both named meeting words refused in every canonical
spelling; dedup day = course zone; stored title not re-judged). Residual vocabulary gaps (above) are the
accepted word-list edge with the saved-list backstop.

## C3 — honesty (structural; text + voice)

**Text path (presenter `presentNexusWriteTurn`).** Loop-2 H1–H13 + H16/H17 are pinned by the fixer's L3-H*
(green in C7) and spot-checked here: a failed/duplicate/unknown write replaces EVERY reply of the turn with
code-built text; no model sentence survives (T2 in `probe-voice.out`: duplicate -> writer slot = status
message, teammate slot = `(Held back: …)`). Wiring read from source on ebd805b: `presentedReplies()` at the 1:1
stream (huddle.functions.ts:4969, behind the stream hold), the prior shown to later agents (:6845), the final
result (:6946), every chunk save (:7078, :7229, :7238); `replies` stays raw in `buildResumeState` and
`turnNexusWriteUses` is persisted (`nexusWriteUses`, :6941) and re-seeded (:2155-2169). The away push reads
`result.replies[0]` = presented (:7718). A write that THROWS on the text path leaves its in-flight `unknown`
record in place (writeUse is only overwritten after `await pending`, :4449-4459), so the turn shows "Unknown —
check Nexus".

Residuals, measured:
- **H15 / T1** (no write call, or a teammate who made none, claims a save): passes unchanged --
  `[elle: "Added it. Saved in Nexus: • Research Proposal …", iris: "I also added your Case Brief 7 to Nexus."]`.
  The fixer's design argument (no code-built list = not a write) holds only if the owner reads it that way; it IS
  a false claim shown to the owner. Likelihood with a real model: **low-moderate** (a model that thinks it saved
  without calling the tool is a known LLM failure; a teammate claiming a different item in a group turn is rarer).
- **H14 / V6** (clean write, reply over-claims "all five"): shown/spoken, followed by the one-item list. Low.
- Push body is `replies[0]` cut at 140 chars, so on a clean write the push can carry the model's claim without
  the list (cosmetic; the list is in the thread).

**Voice path (`createNexusWriteSpeechGate` driven as the hook drives it, `bun mut-verify-114-3/probe-voice.ts`):**
Loop-2 V-a / V-c fixed (fixer's L3-V1..V19 green; nothing is voiced while a write is pending). New orders:

| # | Order | Observed | Class |
|---|---|---|---|
| V1 | executor THROWS on the voice path -> realtime-tools.server.ts:847-848 returns `{"error":…,"tool":…}` (no `ok:false`, no `results`) as a SUCCESSFUL tool output | `holding=false` (deltas streamed raw), finalize -> `full = "<model text>\n\nSaved in Nexus:"`, `speak = "Saved in Nexus:"` (empty list). A model "Done — it's in Nexus" would be spoken, followed by a code-built "Saved in Nexus:" header. | latent; would be BLOCKING if reached, but **not reachable from any input I could build** -- 14 malformed-argument and garbage-row fuzz cases never made `executeNexusWriteTool` throw (probe-exec.out, THROW section). Needs an unexpected runtime exception. Very low. |
| V2 | TYPED entry (`sendText`, hook :606-614) after a failed write: `sendText` never calls `gate.reset()` | every later reply in the call: `{full:"",speak:"",mode:"none"}`, `holding=true`, `flush()=null` -- **the agent goes silent and its replies are neither captioned nor persisted for the rest of the typed session** | NON-BLOCKING (over-suppression). Typed entry is the UAT/impersonation path and a composer fallback; low-moderate. |
| V3 | user hangs up while a write is pending: the result's `.then` returns at hook :545 (`genRef` changed / dc closed) BEFORE `noteToolOutput`; the gate is one `useRef` per hook mount (:107) and neither `cleanup()` (:281) nor connect (:340-350) recreates it | in the NEXT call on the same MeetingBar: `holding=true`, greeting finalize -> nothing, flush -> null, and **even after the user speaks** (`reset()` only sets `resetRequested` while `pending>0`) every reply is buffered forever -- **voice is mute until a page reload** | NON-BLOCKING by the brief's definition (no wrong row, no false claim) but a hard availability failure. Needs a hang-up inside the write's ~1–15 s window -- low, permanent when it happens. |
| V4 | failed write delivered, user hangs up without speaking, starts a new call | new call's replies silent (`failed()` still true) until the first spoken utterance resets | NON-BLOCKING, low-moderate. |
| V5 | after a failed write the user speaks and `transcription.completed` arrives after the reply's `text.done` (OpenAI transcription is async to the response) | that first reply is swallowed; the next is normal | NON-BLOCKING; the ordering is inference (not measurable offline). |
| V7 | success delivered, then a second write in the same exchange fails | failure message lists BOTH (Saved + Not saved) -- truthful | ok |
| V-b | text before the call in the same response | streamed (fixer's residual). A real model says "Let me add that" before a call, not "Done" -- low. | NON-BLOCKING |

**C3: CONFIRMED for the claims as scoped** (no model sentence survives a non-persisted write on text; voice says
nothing while a write is pending and then only the code-built message; success appends the code-built list;
resume state carries the results). Honesty residuals that can still reach the owner as false text: H15/T1
(no-call claim, by design) and V1 (latent, unreachable from inputs tried). V2/V3/V4 are lifecycle defects of the
new voice gate (silence, not false claims).

## C4 — routing: strong context = the owner's REAL course list (vs origin/main 3c728d4)

Baseline: `git archive origin/main src scripts` (3c728d4) extracted to the scratchpad with the same node_modules;
every probe run on both trees. Course list injected as Nexus holds it (nexus-hub docs: `MGT-782-W1 (202711)`,
`MGT-701-W1-Becoming an Applied Researcher (202712)`, `MGT-702-W1 (202711)`, `EMBA694`).

**Re-derived:** the fixer's own probe (`bun mut-loop3/probe-routing.ts <tree> d6`) on both trees -- all 24 loop-2
D6 asks: group leader and `laneOwnerFor` IDENTICAL to origin/main, `primeLaneDecision` null on every one
(`mut-verify-114-3/fixer-d6.*.out`). Coursework mode (21 asks): group led by Elle/Iris, Elle and Iris keep,
Finn hands to Elle/Iris -- 21/21 (`fixer-cw.pr.out`). **D6 as reported: fixed.**

**Cache / timeout / fallback (`bun mut-verify-114-3/probe-primer.ts`, fake fetch):** cold start with a 2.5 s
Nexus -> `"unavailable"` after 1504 ms (bounded), routing that turn on weak signals; the read completes in the
background and the next call is `"fresh"` in 0 ms; another owner's course row (`FIN-999`, user_id other) is NOT
context; 503 -> unavailable, 0 refetches inside the 60 s back-off; the request is
`GET /api/d1/courses?owner=<server owner>` with init `{signal}` only. TTL: a match at TTL+1 ms is false. Codes
are matched as whole tokens (`XMGT-782`, `MGT-782A`, `MGT782paper` -> false); a full-width `ＭＧＴ－７８２` is NOT
matched (the code matcher runs on the raw text, the name matcher on NFKC) -- falls back to weak signals, harmless.

**NEW lane steals -- a real course code (or a weak teacher word) + any trigger word ("due", "deadline", "paper",
"exam", "proposal", "essay") makes the ask "coursework" unless one of the listed veto words appears; the veto
list covers travel/money/markets/fitness/household nouns but not email, calendar, reminders, dining, car rental,
lodging, budget, deposit, payment, textbook, running** (`bun mut-verify-114-3/probe-routing.ts <tree>`,
`probe-routing-weak.ts`; outputs `probe-routing*.{pr,main}.out`). All `intent: perform`, so in a 1:1 the
addressed agent is told to defer AND a deterministic follow-up DM goes to Elle/Iris (huddle.functions.ts
:6808-6814, BEFORE and INSTEAD OF the LLM owner resolver origin/main uses):

| Ask (1:1 with) | origin/main group / 1:1 | PR group / 1:1 |
|---|---|---|
| "email my professor that my MGT-782 paper will be a day late" (Cam) | **cam-post** / no hand-off | **iris** / -> iris + DM |
| "email my professor that my paper will be a day late" (Cam; weak only, cold cache) | **cam-post** / no hand-off | **iris** / -> iris + DM |
| "pick a restaurant for dinner after my MGT-782 exam" (Charleston) | **charleston** / no hand-off | **iris** / -> iris + DM |
| "pick a restaurant for dinner with my professor after the exam" (Charleston; weak) | **charleston** / none | **elle** / -> elle + DM |
| "budget for the MGT-701 residency costs, the deposit is due Monday" (Finn) | **finn** / none | **iris** / -> iris + DM |
| "the EMBA694 textbook payment is due Friday, can I afford it" (Finn) | elle / none | elle / -> elle + DM |
| "rent a car for the MGT-701 residency weekend, it's due back Sunday" (Troy) | **ezra** / none | **iris** / -> iris + DM |
| "find me lodging near campus for the MGT-782 residency, deadline to book is Friday" (Troy) | elle / none | elle / -> elle + DM |
| "I need an Airbnb in Toronto for the EMBA694 residency, the deadline to book is Friday" (Troy) | elle / lane elle (directive only) | elle / -> elle + DM |
| "block two hours on my calendar Thursday for the MGT-782 paper" (Eli) | iris / none | iris / -> iris + DM |
| "block two hours on my calendar Thursday for my research paper deadline" (Eli; weak) | elle / none | elle / -> elle + DM |
| "remind me tomorrow at 9 that the MGT-782 paper is due" (Eli) | iris / none | iris / -> iris + DM |
| "plan my runs around the MGT-782 exam week" (Flex) | iris / none | iris / -> iris + DM |
| "draft an email to my MGT-782 group about the proposal deadline" (Cam) | elle / none | elle / -> elle + DM |

Bold = the group leader itself moved from the lane owner to Elle/Iris (deterministic router; the LLM router is not
measurable offline). Every row's 1:1 changed from "the addressed agent answers (LLM resolver may follow up)" to a
deterministic hand-off + follow-up DM. Controls: "add the MGT-701 research proposal due Dec 1 to Nexus" (Troy ->
Iris, correct). Over-veto (the fixer's "veto beats a real course code" residual, measured): "the MGT 782 paper on
real options is due Friday" -> `primeLaneDecision` null even from Elle (veto word "options"), and "my EMBA694
operations case for the client is due Dec 4" -> null ("client"); both fall back to origin/main's routing (group
still Iris/Elle) -- NON-BLOCKING, low-moderate (paper topics naming options/clients/stocks are common in a DBA).

This is the same failure shape as loop 2's D6, moved: the course list fixed WHICH tokens count as a course, but
the capability still treats "names a course + says due/paper/exam" as "add it to Nexus", and the only guard is a
veto WORD LIST. **D12 (new): BLOCKING** (another agent's lane taken, deterministically, with a DM to Elle/Iris).
**Realistic likelihood: moderate-high** -- the owner is a DBA student whose other asks (email the professor,
block study time, a reminder, dinner after an exam, residency travel/budget) naturally name the course and a
deadline; no adversarial spelling is needed, and the cold-cache/weak path ("my professor", "my instructor")
produces the same hand-offs with no course code at all.

**C4: REFUTED** (D12; F2-45 NOT MET on these inputs). The loop-2 D6 inputs themselves are fixed.

## C5 — the model cannot steer owner / URL / table / auth headers (CONFIRMED)

Re-run on ebd805b: loop-1 `bun mut-verify-114/probe-exec.ts` C5 block -- POST url
`https://nexus.test/api/d1/assignments?owner=owner-uuid-1111` (one owner), headers `{content-type, x-uat-token:
srv-token, x-agent-tool, x-agent-ref}`, body `{course_id,title,type,status,due_date,program_id}`; injected
`assignment_id "aafbf80f&owner=evil&id=6616bef3"` -> ONE encoded `id`, owner stays single; every GET carries the
server owner; 26 items -> batch_too_large, 0 writes. Loop-2 `mut-verify-114-2/probe-exec.ts` C5 block: zone /
course / JSON-ish title injections -> 0 POSTs or whitelisted body, owners `[["owner-uuid-1111"]]`. NEW loop-3 path
(the UPDATE's stored-row read): `assignment_id "aafbf80f&owner=evil"` + `owner`/`user_id: "evil"` -> GET
`filters=[["id","aafbf80f&owner=evil"]]` (one JSON value), owner params `[GET:[owner-uuid-1111], PATCH:
[owner-uuid-1111]]`, not_found. The primer's GET carries the server owner and init `{signal}` only. The write
module still has exactly one `fetch(` (nexus-write.server.ts:563).

## C6 — read tools stay read-only (CONFIRMED)

`git diff origin/main...HEAD -- nexus.server.ts`: only `export` added to `nexusOwner`, `nexusBase`, `TIMEOUT_MS`,
`nexusGet` plus comments; no loop-3 change (`git diff 6b11bae HEAD -- nexus.server.ts` empty). Only `fetch(` in it
is :128 `fetch(url.toString(), { signal })`. The NEW `course-context.server.ts` reads only through `nexusGet("courses")`
(source: its sole import from ./nexus.server is `nexusGet, nexusOwner, nexusReadConfigured`; probe-primer: one GET,
init keys `["signal"]`); `course-context.ts` is pure (no imports). `bun mut-verify-114/probe-read.ts`: 12 read
tools = 12 NEXUS_TOOL_NAMES; 16 fetches, 0 with any init key other than `signal`.

## C8 — mutations (mutate.sh; anchors/replacements are FILES in `mut-verify-114-3/`, written from exact source text
by `mut-verify-114-3/make-anchors.py`, each checked to occur once; runner `bash mut-verify-114-3/run-mutations.sh`;
test cmd `bun scripts/nexus-write-loop3.test.ts`)

Verifier-chosen mutations of 7 of the 35 loop-3 guards (own anchors, not the fixer's mut-loop3 files):

| # | Guard | File | Mutation | Must fail | mutate.sh verbatim |
|---|---|---|---|---|---|
| p1 | other replies held back on a failed write | nexus-write-shared.ts | teammates keep `r.text` | L3-H12 | `FIRED: 'L3-H12' failed with the defect reinstated. The guard is real.` |
| p2 | voice buffers while a write is pending | nexus-write-shared.ts | pending branch returns the raw text `whole` | L3-V1 | `FIRED: 'L3-V1' failed with the defect reinstated. The guard is real.` |
| p3 | letter→digit split in `canonicalTitle` | nexus-write.server.ts | only digit→letter split kept | L3-D7a | `FIRED: 'L3-D7a' failed with the defect reinstated. The guard is real.` |
| p4 | dedup day = course zone | nexus-write.server.ts | `zone: "Asia/Tokyo"` passed to findDuplicate | L3-D8 | `FIRED: 'L3-D8' failed with the defect reinstated. The guard is real.` |
| p5 | write uses re-seeded on resume | huddle.functions.ts | `turnNexusWriteUses = []` | L3-D11d | `FIRED: 'L3-D11d' failed with the defect reinstated. The guard is real.` |
| p6 | hook flushes at response.done | useVoiceCallRealtimeSpeak.ts | `flushed = null` | L3-V22 | `FIRED: 'L3-V22' failed with the defect reinstated. The guard is real.` |
| p7 | vetoes evaluated (first) | capabilities.ts | veto line deleted | L3-D6 | `FIRED: 'L3-D6' failed with the defect reinstated. The guard is real.` |

Loop-1/2 set re-run (`bash mut-verify-114-2/run-mutations.sh m1 m2 m5 m6 m7 n1 n2 n4`): m1 RT-H3, m5 RT-R1, m6 FX-V6,
m7 RT-D3, n1 L2-D2a, n2 L2-D1h, n4 L2-D4a -> each `FIRED: '<id>' failed with the defect reinstated. The guard is
real.`; m2 -> `NOT-APPLIED: the anchor does not appear in src/features/huddle/lib/nexus/nexus-write.server.ts.
NOTHING WAS TESTED.` (its line was replaced by the D8 written-day key; the fixer's re-anchored m2b covers it). Every
applied run printed `restored: … matches HEAD` and `tree clean: … passes again on the restored tree`; `git status
--short` empty afterwards. **14 FIRED, 0 INERT, 1 NOT-APPLIED (expected). p5/p6 are SOURCE assertions (the
fixer says so too): they prove the call site exists, not its runtime behaviour.**

**Changed assertions -- judged:**
- L2-D1g (`zone` for an ISO instant LA -> New_York): legitimate -- encodes the owner's D8 replacement rule.
- L2-D3a/b/h (exact expected = the full code-built message), L2-D3c and L2-V9 (exact text + list), L2-V4 (speak ===
  full === message, mode whole): **stronger** than loop 2.
- L2-D3e/f/g/i went from exact equality to `.includes(<bullet>)`: individually WEAKER (an implementation that kept
  the model text next to the bullet would pass them), but the same failure-replaces-all behaviour is pinned by
  exact-equality rows L2-D3a (16 inputs), L3-H1, L3-H16 (duplicate), L3-H17 (in flight). Not a coverage loss.
- L2-V7, L2-V12, FX-V7, FX-G6, F2-35 source regexes: renames to the new call sites; FX-V7/L2-V12 now also require
  `void speak(out.speak …)` and `persist(… out.full)` -- same or stronger.
- Fixture injection (`setNexusCourseContext([MGT-782, MGT-702 "Strategic Management"])`) added to router-winners,
  router-redteam, nexus-write-tool/-fix/-loop2: legitimate (the course list is now data). Note the fixture's
  2-word name "Strategic Management" makes a NAME match possible in tests; the real Nexus names
  (`MGT-701-W1-Becoming an Applied Researcher (202712)`) almost never appear whole in an ask, so in production the
  code matcher carries all of it.

**C8: CONFIRMED** (the loop-3 guards are real for the inputs they test). None of them covers D12 or the voice
lifecycle (V2/V3/V4): those are inputs, not guards.

## C1 — Feature 2 ACs (re-derived on ebd805b; AC text from nexus-hub docs/cross-app-agent/AC-syllabus-deliverables-write-tool.md)

Probes re-run: loop-1 `probe-ac.ts`, `probe-exec.ts`, `probe-read.ts`; loop-2 `probe-exec.ts`; this loop's
`probe-exec.ts`, `probe-voice.ts`, `probe-routing*.ts`, `probe-primer.ts`, `probe-f211.ts`.

| AC | Verdict | Evidence (this loop) |
|---|---|---|
| F2-01/02/03, F2-06, F2-20/21, F2-38, F2-40, F2-50 (live part) | NOT TESTABLE OFFLINE | Nexus-side / LLM / live; unchanged Huddle side. |
| F2-04/05/07 | MET (Huddle side) | C5: one server owner on every request, literal path, whitelisted body, new stored-row read included. |
| F2-08 | MET (Huddle side) | PATCH 404 -> not_found, persisted false (probe-exec item 6 "update unknown id"). |
| F2-09 | PARTIAL | headers sent; preimage Nexus-side. |
| F2-10 | behaviour MET; "one predicate shared with F1" NOT MET by construction (cross-repo, unchanged) | null/""/TBD undated; ET/EST/E.S.T. resolve. |
| F2-11 | MET | fixture "Residency 4 – present ideas and insights from the readings" (en dash and hyphen) -> meeting/session; all 15 loop-2 spellings refused; residual vocabulary edges in C2 (homoglyph/typo/UK "residential"). |
| F2-12 | MET | `due_date:null` update -> rejected/undated, 0 writes. |
| F2-13 | MET | 10-30 -> 03:59Z; 12-09 -> 12-10T04:59Z; 03-07 -> 03-08T04:59Z; `-07:00`/`+0530` honoured. |
| F2-14 | MET (incl. loop-2 D8 inputs); "same function as F1" NOT MET by construction | "Research Paper Proposal" -> duplicate aafbf80f; Tokyo/London -> duplicate. |
| F2-15 | MET | timeout-after-commit -> unknown; retry -> duplicate; rows = 1. |
| F2-16..19 | MET | MGT-782 / mgt 782 / MGT782 / mgt-782 / "MGT-782-W1 (202711)" -> c782; MGT-999 not found; TST-701 ambiguous. |
| F2-22/23 | MET | type/status forced; [dated, undated, dated] -> inserted/rejected/inserted; 26 -> batch_too_large. |
| F2-30/31/32/33 | MET | 1+12 / 0/0 / 0/0 / 0 write+12 read; voice-toolset-hidden 36/0; cross-app-turn-gate 92/0. |
| F2-34/36 | MET | 200/400/500/throw/no-id/timeout mapped; telemetry ok flags correct. |
| F2-35 | MET (offline part) | a non-persisted write replaces every reply with the code-built message (L3-H1, probe T2); voice speaks nothing while pending, then only the message. Outside its letter: H15/T1 (no write call), V1 (latent throw shape). |
| F2-37 | MET | C6. |
| F2-41/42/43 | MET | 21/21 coursework asks: group Elle/Iris, Elle/Iris keep in 1:1; Finn -> Iris for "add my MGT-782 research paper due Dec 9". |
| **F2-45** | **NOT MET** | "Fitness, finance and travel asks still route to Flex, Finn and Troy as before": "budget for the MGT-701 residency costs, the deposit is due Monday" group **finn -> iris**; in a 1:1 Finn hands it (and "the EMBA694 textbook payment is due Friday, can I afford it") to Elle/Iris with a follow-up DM; Troy hands residency lodging/Airbnb/car asks to Elle/Iris; Cam (email), Charleston (dinner), Eli (calendar/reminder), Flex (runs) likewise (C4 D12). Board asks still -> Iris (ok). |
| F2-46 | MET vs baseline for its fixtures | unchanged. |

**C1: REFUTED** (F2-45 NOT MET on D12 inputs; F2-10/F2-14 "shared with F1" NOT MET by construction, unchanged
since loop 1 and outside this repo).

## C9 — new adversarial inputs aimed at the loop-3 designs (verifier's own; none in FIX-loop3 / L3 tests)

| Design attacked | Inputs | Wrong results |
|---|---|---|
| canonicaliser | 15 meeting spellings + 11 deliverables + F2-11 fixture | 8 meetings accepted (homoglyph x2, "ResidencyFour", typo, "Residential week", "Mtg", "Town hall", "Res. 4", spaced letters, "Virtual huddle"); 7 deliverables refused incl. "Research proposal (Session 3 deliverable)" |
| stored-title update (item 6) | 5 | none |
| course-zone dedup / written day | 7 | 2 far-zone plain dates treated as next-ET-day duplicates (consistent with the stated rule) |
| executor throw surface | 14 malformed args / garbage Nexus rows | none threw; `items` as an object -> no_items |
| replace-all-replies / saved list | T1 teammate claim on a clean write, T2 duplicate | T1 shown unchanged (H15 class) |
| voice buffer orders + lifecycle | V1 throw shape, V2 typed entry, V3 hang-up mid-write, V4 new call after failure, V5 late transcription, V6 over-claim, V7 second write fails | V1 latent false header; V2/V3/V4/V5 silence (V3 permanent until reload) |
| course-list routing | 17 course-code other-lane asks + 7 weak-only + 8 cache cases + primer bound/back-off/owner filter | **13 deterministic lane steals (D12)**; full-width code not matched (harmless) |
| resume state | p5 mutation + source read | none |

**C9: REFUTED** (D12).

## Defects, ranked by realistic likelihood with a real model

| # | Defect | Class | Likelihood (real LLM / real owner) | Repro |
|---|---|---|---|---|
| **D12** | Asks for OTHER lanes that name one of the owner's real courses (or "my professor/instructor") plus a deadline word are captured as coursework: deterministic 1:1 hand-off + follow-up DM to Elle/Iris; group leader moves from Finn/Cam/Charleston/Ezra to Iris/Elle in the deterministic router | **BLOCKING** (lane stolen) | **moderate-high** -- ordinary phrasing ("email my professor that my MGT-782 paper will be late", "budget for the MGT-701 residency, deposit due Monday", "dinner after my MGT-782 exam"); needs no LLM at all (deterministic path) | `bun mut-verify-114-3/probe-routing.ts <tree>`, `probe-routing-weak.ts <tree>` |
| H15/T1 | a save claim with no write call (own or teammate) is shown unchanged | BLOCKING by the brief's definition (false claim shown); owner-accepted design residual (no word list) | low-moderate (hallucinated tool use) | `bun mut-verify-114-3/probe-voice.ts` (T1) |
| V3 | hang-up during a pending write leaves the voice gate `pending>0` forever; every later call on that MeetingBar is mute until page reload | NON-BLOCKING (no false claim) but severe availability | low (needs hang-up in the write window), permanent when hit | `probe-voice.ts` V3; hook :107, :281, :545 |
| V2 | typed entry never resets the gate: after one failed write the rest of a typed voice session is silent and unpersisted | NON-BLOCKING | low-moderate (UAT/typed path) | `probe-voice.ts` V2; hook :606-614 |
| V4/V5 | first reply of a new call / of a new utterance after a failure is swallowed | NON-BLOCKING | moderate for V4 (new call greeting after a failed write), V5 ordering is inference | `probe-voice.ts` V4/V5 |
| D7-gap | homoglyph / typo / "Residential week" / "Mtg" / "Res. 4" meeting titles accepted | BLOCKING by definition (wrong row) with the owner's saved-list backstop | low (needs that spelling in the syllabus and the extractor keeping it) | `bun mut-verify-114-3/probe-exec.ts` |
| D7-over | "Research proposal (Session 3 deliverable)", "Peer review of Class 2 proposals", "Conference paper submission" refused | NON-BLOCKING (refused with reason) | moderate (session-organised syllabi) | same |
| V1 | an executor THROW on the voice path yields `{error,tool}` -> gate treats it as success: raw text streamed + empty "Saved in Nexus:" header | latent; BLOCKING if reached | very low (no input found that throws) | `probe-voice.ts` V1 |
| D8-far | a plain date with a far-from-ET `time_zone` is a "duplicate" of the next ET day's row | NON-BLOCKING (refusal naming the stored date) | low | `probe-exec.ts` D8 |
| H14/V6 | clean write, reply over-claims ("all five") | NON-BLOCKING-ish (list shows the truth) | low | `probe-voice.ts` V6 |
| over-veto | course paper topics with "options"/"client"/"stocks" not routed as coursework | NON-BLOCKING (baseline routing) | low-moderate | `probe-routing.ts` |

Fixer's stated residuals, measured: H15 (real, above); V-b (real, low; "Done" before a call is unlikely);
"Cohort analysis paper" refused (real, NON-BLOCKING); veto beats a real course code (real, NON-BLOCKING, baseline
routing); cold-start weak-only routing (real -- and the weak path steals lanes too, see D12 weak rows, so a cold
cache is not a safe fallback).

## Verdict

| Claim | Verdict |
|---|---|
| C1 F2 ACs | REFUTED (F2-45 NOT MET via D12; F2-10/14 shared-with-F1 NOT MET by construction) |
| C2 owner rules | CONFIRMED (D7/D8 fixed as specified; vocabulary edges are the accepted word-list class) |
| C3 honesty | CONFIRMED as scoped (structural replace-all on text; voice buffer); residuals H15 (by design), V1 (latent); voice lifecycle defects V2/V3/V4 are silence, not false claims |
| C4 routing | REFUTED (D12: course-code / professor + deadline word captures email, dining, finance, travel, calendar, fitness asks) |
| C5 identity/url/headers | CONFIRMED |
| C6 read-only | CONFIRMED |
| C7 suites + tsc | CONFIRMED (exact counts) |
| C8 mutations | CONFIRMED (14 FIRED, 0 INERT, 1 expected NOT-APPLIED) |
| C9 new adversarial | REFUTED (D12) |

**Overall: REFUTED.** Every loop-2 defect (D6–D11) is fixed as reported and its guard is real. The write path
itself (what is written, where, as whom, and what the owner is told about it) holds on every input tried. The one
BLOCKING defect with realistic likelihood is **D12**: the routing redesign still decides "coursework" from
course-name/teacher words plus a deadline word, guarded only by a veto WORD LIST, so ordinary asks to Cam, Finn,
Troy, Charleston, Eli and Flex that mention a course or a professor are deterministically handed to Elle/Iris with
a follow-up DM. Highest-impact NON-BLOCKING: V3 (voice permanently mute after a hang-up mid-write).
