# VERIFY nexus-write-tool, loop 1 — independent verification of huddle PR #114

<!--
WHAT:          Independent, offline verification of PR #114 (branch claude_nexus-write-tool-fixed,
               head e881be0): the Nexus write tool `write_nexus_assignments`, its honesty guard, and
               the Elle/Iris prime routing. Per-claim verdicts C1..C9 with observed evidence.
WHY:           Tier-1 change (admits model output into a stored Nexus row, decides who answers). The
               red-team + fix pass self-reports 33/34 mutations FIRED; this pass re-measures from scratch.
SUPERSEDES:    nothing.
SUPERSEDED-BY: nothing -- current.
EVIDENCE:      this file; probe scripts + mutation anchors in mut-verify-114/ on branch
               claude_verify-nexus-write-tool-1. Offline only: fetch mocked, no live Nexus/Huddle,
               no DB or board writes.
-->

Started 2026-10-28 17:42 UTC. Verifier worktree, branch `verify-nexus-write-tool-1` from
`origin/claude_nexus-write-tool-fixed` @ `e881be0`. Baseline for routing: `git archive origin/main`
extracted to a scratch tree (origin/main at fetch time).

## C7 — suite claims (VERIFIED)

`npm ci --ignore-scripts` → exit 0. `bash scripts/run-nexus-fix-suites.sh` (all 8 suite files present):

| Suite | Observed |
|---|---|
| nexus-write-redteam | exit 0, 39 passed, 0 failed |
| router-redteam | exit 0, 12 passed, 0 failed |
| nexus-write-tool | exit 0, 115 passed, 0 failed |
| router-winners | exit 0, 39 passed, 0 failed |
| nexus-read-tools | exit 0, 190 passed, 0 failed |
| cross-app-turn-gate | exit 0, 92 passed, 0 failed |
| voice-toolset-hidden | exit 0, 36 passed, 0 failed |
| nexus-write-fix | exit 0, 50 passed, 0 failed |
| script overall | EXIT 0 |
| `npx tsc --noEmit -p .` | exit 0, zero output |

Counts match docs/FIX-nexus-write-redteam.md "Results" exactly. **C7: CONFIRMED.**

## C5 — the model cannot steer owner / URL / table / auth headers (VERIFIED)

Probe: `bun mut-verify-114/probe-exec.ts` (fake fetch records every outbound call). Tool args carried
top-level `owner`, `user_id`, `email`, `url`, `headers{X-UAT-Token}`, `table`, and per item `owner`,
`user_id`, `userId`, `email`, `program_id`, `id`, `course_id`, `canvas_meta`, `output_format`,
`sheet_row_number`, `status:"deleted"`, `type:"quiz"`, `nested.owner`. Observed outbound POST:

```
url     https://nexus.test/api/d1/assignments?owner=owner-uuid-1111   (owner params: ["owner-uuid-1111"])
headers {"content-type":"application/json","x-uat-token":"srv-token","x-agent-tool":"write_nexus_assignments","x-agent-ref":"probe"}
body    {"course_id":"c782","title":"Case Brief 7","type":"assignment","status":"active","due_date":"2026-11-13T04:59:59Z","program_id":"p-dba"}
```

Every model-supplied identity/scope key was dropped; `course_id`/`program_id` came from the resolved
course row; `type`/`status` forced. An injected `assignment_id: "aafbf80f&owner=evil&id=6616bef3"` was
URL-encoded into ONE `id` value; `owner` stayed single and server-held. Nexus side (read from the
working tree of /home/user/nexus-hub `api/src/functions/d1.ts:1251-1270`, not re-fetched): PATCH binds
`id` as `$n`, so no operator injection. Path is a literal `/api/d1/assignments`; method is POST|PATCH
only; no DELETE in the file. All GETs carry the server owner. **C5: CONFIRMED.**

## C2 — owner rules

Probe: `bun mut-verify-114/probe-exec.ts`.

| Rule | Input | Observed | Verdict |
|---|---|---|---|
| ET, DST | 2026-10-30 23:59 (none/EST/ET/E.S.T./US/Eastern) | 2026-10-31T03:59:00Z | ok |
| ET winter | 2026-12-09 23:59 EST | 2026-12-10T04:59:00Z | ok |
| DST eve | 2026-03-07 23:59 ET → 2026-03-08T04:59Z; 03-08 23:59 → 03-09T03:59Z | ok |
| DST gap/overlap | 03-08 02:30 → 07:30Z `timeShifted`; 11-01 01:30 → 05:30Z (first) | ok |
| offset honoured | `…T23:59:00-07:00` → 06:59Z; `+0530` (no colon) → 18:29Z | ok |
| undated | null, "", "TBD" → undated; "Week 5", "Oct 30", "10/30", "2026-02-30" → ambiguous-date | ok |
| MST | refused as ambiguous (documented) | ok |
| meetings | "Residency 4: present your research proposal", "Residency 4 – present ideas…", "Weekly zoom session", "Office hours with Prof. Lee" → meeting/session; 0 POSTs | ok |
| admin/holiday/reading | "Thanksgiving", "Last day to withdraw", "Reading: Porter chapter 4" → refused | ok |
| dedup same day | "Research Proposal" 2026-10-30 12:00 ET vs stored 23:59:59 → duplicate; "research proposal (20%)" EST → duplicate | ok |
| recurring | "Discussion Post" 11-09, 11-16 inserted; 11-02 (stored) duplicate | ok |
| next day | "Research Proposal" 2026-10-31 → inserted (separate) | ok per rule |
| **dedup, Z instant** | **"Research Proposal" `2026-10-30T20:00:00Z` (= Oct 30 16:00 ET, same local day as stored)** | **inserted/true, 1 POST — a second Research Proposal row** | **DEFECT D1** |
| same instant as `-04:00` | `2026-10-30T16:00:00-04:00` | duplicate, 0 POSTs | ok |
| **meeting, punctuation** | **"Residency 4, present your research proposal"; "Residency 4 present your research proposal"; "Residency 4. Present your research proposal"; "Residency 4 / present your research proposal"** | **classify → null (accepted as an assignment)** | **DEFECT D2** |

**D1 (dedup).** `findDuplicate` computes "same local day" in the zone the candidate's date was written
in (`zone: "UTC"` for a `Z` instant, nexus-write.server.ts:248 then :371/:400), not the course zone. The
stored row (2026-10-31T03:59:59Z) is Oct 31 in UTC, the candidate Oct 30 → rule 1 misses; instants are
8 h apart → rule 2 misses → POST. The tool's own schema invites "a full ISO datetime WITH offset", and
`Z` is accepted. Reproduce: `bun mut-verify-114/probe-exec.ts` line "C9: Research Proposal given as a Z
instant". Owner rule "dedup = title + same local day" is violated.

**D2 (meeting rule).** `classifyNonDeliverable` splits the head only on `:`, spaced dash, em dash or `(`
(nexus-write.server.ts:325). With a comma, period, slash or no punctuation the head is the whole title,
which ends in "proposal" (a deliverable noun) → accepted. Same title the owner's rule names, one
punctuation mark different.

Further C9 classification gaps (wrongly ACCEPTED as assignments): "Spring Recess", "Tuition payment due",
"Course evaluations due", "Annual research symposium", "Networking dinner", "Field trip to Ford plant",
"Pre-read: Porter Five Forces (HBR 1979)". Over-rejections (recoverable, reason returned): "Chapter 4
problem set" → reading, "Holiday Inn case study" → administrative, "Spring break reflection paper" →
administrative (while "Thanksgiving reflection essay" is accepted), "Read and respond: chapter 4" → reading.

**C2: REFUTED** (D1, D2; vocabulary gaps non-blocking individually).

## C3 — honesty (text + voice, single + group)

Probe: `bun mut-verify-114/probe-honesty.ts` (pure `enforceNexusWriteHonesty` + `createNexusWriteSpeechGate`,
exactly as huddle.functions.ts:6588 and useVoiceCallRealtimeSpeak.ts call them). Item "Research Proposal"
failed with http_500 unless stated.

| # | Reply | Output | Verdict |
|---|---|---|---|
| N1 | "I didn't just add the Research Proposal, I also set it to high priority." | UNCHANGED | **false save passes** |
| N2 | "Not a problem I've saved the Research Proposal for Oct 30." | UNCHANGED | **false save passes** |
| N3 | "Never fear I added the Research Proposal to Nexus." | UNCHANGED | **false save passes** |
| N4 | "Not only did I add the Research Proposal, it's flagged high priority too." | UNCHANGED | **false save passes** |
| N9 | failed "Research Proposal" + saved "Case Brief 2": "Case Brief 2 could not be saved. The proposal is added though." | UNCHANGED | **false save passes** |
| N5 | "…is all squared away for Oct 30." | original kept + truth appended | contradictory reply |
| N6 | update failed: "I've changed the Research Proposal deadline to Nov 2." | original kept + appended | contradictory |
| N7 | "Moved the Research Proposal to Nov 2 for you." | original kept + appended | contradictory |
| N8 | "Research Proposal ✓" (U+2713) | original kept + appended | contradictory |
| N10 | "…is on the books for Oct 30." | original kept + appended | contradictory |
| N11 | "Research Proposal is set — due …, scheduled in Nexus." | original kept + appended | contradictory |
| N12 | control "I've added the Research Proposal to Nexus." | replaced by truth | ok |
| N13 | control honest denial | unchanged | ok |
| N15 | teammate "Elle has added your Research Proposal." | replaced | ok |
| N14 | teammate "Elle took care of it." | unchanged | documented residual |

Voice gate: holding=false before any tool, true after a failed write and after a tool-level error, false
after a clean write; the voice surface speaks N1 unchanged ("I didn't just add the Research Proposal…").

Mechanism (N1–N4): a clause containing a negation within 40 chars of a save verb is classed `denial`,
and `claim = !denial && CLAIM_RE` (nexus-write-shared.ts:124-125), so the claim is never seen, and that
"denial" acknowledges the item. N9: a denial naming no UNSAVED item falls back to acknowledging ALL
unsaved items (`(sentNamed.length ? sentNamed : ownUnsaved)`, :186), so a denial about the SAVED item
launders the failed one, and the unnamed "the proposal is added" is then excused.
N5–N11 contradict FIX doc W11 ("any false claim replaces, never decorates").

**D4 — 1:1 TEXT streaming bypasses the guard (by source reading; not executed).** In a 1:1 with
chunked/durable turns (default on: `data.streamReplies?.oneOnOne ?? true`), `onDelta` writes the RAW
growing reply into the durable row for the client poll (`huddle.functions.ts:4909-4928` →
`turnStore.updateTurnReplies(... {text: full})`), and `callOpenAIResponses` streams every hop including
the one after the tool result (openai-responses.server.ts:125-131, :480). The honesty guard runs only at
reply assembly (huddle.functions.ts:6588). So a 1:1 text reply "I've added your Research Proposal" after
a failed write is shown forming on screen before being replaced. The voice path holds streaming while
armed (W18); the 1:1 text path has no equivalent hold. Confidence: high from the code; not observed live.

**C3: REFUTED** — text and voice share the guard, so N1–N4/N9 fail on both, in 1:1 and group.

## C4 — routing (offline deterministic path, PR head vs origin/main)

Probe: `bun mut-verify-114/probe-routing.ts <tree>` run against this worktree and against a
`git archive origin/main` export (same node_modules). `group` = `routeMessage(...).winners[0]` with all
agents present; `1:1 X` = `laneOwnerFor(text, X)` (null = X keeps it; an id = X hands off AND, via
`primeLaneDecision`, a follow-up DM is enqueued to that id, huddle.functions.ts:6765-6775).

| Ask | group main → PR | 1:1 Elle | 1:1 Iris | 1:1 Finn | 1:1 Troy |
|---|---|---|---|---|---|
| add my assignments | iris → iris | null | null | null→iris | null→iris |
| add my MGT-782 assignments from the syllabus | iris → iris | null | null | →iris | →iris |
| put the research paper due Dec 9 on my assignments | iris → iris | null | null | →iris | →iris |
| update the due date on my research paper | **eli → iris** | eli→**null** | eli→**null** | eli→iris | eli→iris |
| change my research proposal deadline to Nov 2 | elle → elle | null | null | →elle | →elle |
| log my DBA deliverables | **ezra → iris** | ezra→**null** | ezra→**null** | ezra→iris | ezra→iris |
| add this syllabus's deadlines to Nexus | elle → elle | null | null | →elle | →elle |
| I have a new paper due next month for MGT-782, add it | iris → iris | null | null | →iris | →iris |
| add my school assignments | elle → elle | null | null | →elle | →elle |
| fix the due date on my strategy paper | **liam → iris** | null | null | →iris | →iris |
| my professor pushed the case analysis to Friday | elle → elle | null | null | →elle | →elle |
| change my seat assignment on the flight | troy → troy | troy | troy | troy | null |
| renew my NEXUS card | iris → iris | null | null | null | null |
| client deliverable due Friday | ezra → ezra | ezra | null | ezra | ezra |
| tax papers are due | iris → iris | null | null | null | null |
| add a task to my board to call the bank | iris → iris | null | null | null | null |
| what's on my board | iris → iris | null | null | null | null |
| fix the typo in the email draft | cam → cam | cam | cam | cam | cam |
| tidy up my calendar adjustments | eli → eli | eli | eli | eli | eli |
| **should I apply to NEXUS before my trip to Toronto** | **troy → iris** | null | null | **null→iris** | **null→iris** |
| **what's the investment thesis for buying more NVDA** | **tess → iris** | null | null | **null→iris** | null→iris |
| **my semester tuition payment is due Dec 1, can I afford it** | **finn → iris** | null | null | **null→iris** | null→iris |
| **review the course of action for the merger proposal due Friday** | **cole → elle** | null | cole→null | null→elle | null→elle |
| **is there a case study on intermittent fasting results** | **cole → iris** | cole→null | cole→null | null→iris | null→iris |
| **I'm teaching a training class at work, slides due Friday** | **flex → iris** | flex→null | flex→null | null→iris | null→iris |
| the deadline for my spin class membership refund is Friday | elle → elle | null | null | →elle | →elle |

Coursework: 11/11 group asks led by Elle/Iris; Elle and Iris keep all 11 in a 1:1. The four
brief-named non-coursework asks match their origin/main baseline in group and 1:1.

**D3 (routing over-match, new inputs).** Six non-coursework asks are captured by the prime rule:
- "should I apply to NEXUS before my trip to Toronto" — `to NEXUS` is a STRONG-context pattern, which
  beats the `trip` veto (capabilities.ts:283: strong is checked before vetoes). Travel → Iris; a 1:1 with
  **Troy hands his own travel ask to Iris** and enqueues a follow-up DM.
- "what's the investment thesis for buying more NVDA" — `thesis` is both a trigger and STRONG context.
  In a **1:1 with Finn, Finn defers his own finance ask to Iris** (follow-up DM).
- "my semester tuition payment is due Dec 1, can I afford it" — `due` trigger + weak `semester`, no veto.
  Finance (baseline Finn) → Iris; 1:1 Finn hands off to Iris.
- "review the course of action for the merger proposal due Friday" — `course` weak context (`ignore`
  only removes "of course"). Work → Elle.
- "is there a case study on intermittent fasting results" — `case study` strong. → Iris.
- "I'm teaching a training class at work, slides due Friday" — `class` weak + `due`. Work → Iris.
This is the W19/W20 class the fix pass reported closed; it is closed for its 9 listed inputs only.

**C4: REFUTED** (D3). The LLM-router path is not measurable offline (documented residual).
