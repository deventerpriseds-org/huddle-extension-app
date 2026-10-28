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
