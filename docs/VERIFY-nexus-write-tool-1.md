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

Calibration (probe-intent.ts / probe-lane2.ts): the 1:1 hand-off directive and follow-up DM are
intent-gated (`classifyTurnIntent === "perform"`). "should I apply to NEXUS before my trip…",
"my semester tuition payment is due…", "review the course of action…", "I'm teaching a training class…"
classify `perform` → the directive + follow-up DM fire. The NVDA and fasting questions classify `query`
(no directive). But the perform phrasing "write up an investment thesis for NVDA" in a 1:1 with Finn →
`laneOwnerFor` = iris-chase (score 0); origin/main = null. Same for "apply to NEXUS for me before my
Toronto trip" with Troy.

## C6 — read tools stay read-only (VERIFIED)

`git diff origin/main...HEAD -- nexus.server.ts`: 4 hunks add `export` to `nexusOwner`, `nexusBase`,
`TIMEOUT_MS`, `nexusGet`, plus a comment block. `nexusFetch`'s body is untouched; its only `fetch(` is
`fetch(url.toString(), { signal: controller.signal })` (nexus.server.ts:128). The only other `fetch(` in
lib/nexus is nexus-write.server.ts:490. `bun mut-verify-114/probe-read.ts`: `nexusReadTools()` = 12 tools,
`NEXUS_TOOL_NAMES` = 12; executing all 12 against a fake fetch made 16 calls, **0** with any init key
other than `signal` (no method/body/headers; the UAT and JOURNEY tokens were set in env and never sent).
**C6: CONFIRMED.**

## C1 — Feature 2 ACs (+ RESOLUTIONS: W1 auth, owner = Huddle's server-held NEXUS_OWNER_ID)

Probes: probe-exec.ts, probe-ac.ts, probe-read.ts, probe-routing.ts, probe-honesty.ts (all in mut-verify-114/).

| AC | Verdict | Evidence |
|---|---|---|
| F2-01/02/03 | NOT TESTABLE OFFLINE | Nexus-side token checks; under W1 Huddle calls the existing UAT path. Huddle side: token is server env, never empty on the wire (`nexusWriteConfigured` requires it; F2-30 row). |
| F2-04 | MET (Huddle side) | C5: model `owner`/`user_id`/`userId`/`email`/nested owner dropped; single `owner=` from env. Nexus-side refusal not testable offline. |
| F2-05 | MET as re-read by OQ-10 | owner = `NEXUS_OWNER_ID` set last (`searchParams.set`) on every POST/PATCH/GET (probe-exec). |
| F2-06 | NOT TESTABLE OFFLINE | Nexus route matrix. |
| F2-07 | MET (Huddle side) | no DELETE in nexus-write.server.ts; path literal `/api/d1/assignments`; body = whitelisted keys only (C5 body). |
| F2-08 | NOT TESTABLE OFFLINE | Nexus 404 for a foreign id; Huddle maps 404 → `not_found`, persisted:false (probe-exec PATCH). |
| F2-09 | PARTIAL / NOT TESTABLE OFFLINE | Huddle sends `X-Agent-Tool: write_nexus_assignments` and `X-Agent-Ref` (observed). The preimage `source` value is Nexus-side. |
| F2-10 | NOT MET (as written) | Behaviour MET (null/""/TBD → undated; Week 5/Oct 30 → ambiguous-date). "ONE predicate imported by both F1 and this endpoint; grep finds it once" cannot hold: the predicate is a Huddle-local copy (nexus-write.server.ts:226); F1 lives in nexus-hub. |
| F2-11 | MET | "Residency 4 – present ideas and insights from the readings" → meeting/session, 0 POSTs. (D2 shows nearby spellings that are not refused.) |
| F2-12 | MET | update `due_date:null` → rejected/undated, 0 writes. |
| F2-13 | MET | 10-30 23:59 → 03:59Z; 12-09 → 12-10T04:59Z; 03-07 → 03-08T04:59Z; `-07:00` honoured. |
| F2-14 | MET for the stated fixtures; same-function-as-F1 NOT MET | "Research Proposal (20%)" and "Research Paper Proposal" 10-30 23:59 ET → duplicate, id aafbf80f…; but D1 (Z instant) inserts a duplicate. |
| F2-15 | MET | timeout after commit → `unknown/timeout`; identical retry → duplicate of n1; rows = 1. |
| F2-16 | MET | MGT-782, mgt 782, MGT782, mgt-782, "MGT-782-W1 (202711)" → c782 (5/5). |
| F2-17 | MET | MGT-999 → course_not_found (+ courses list in result). |
| F2-18 | MET | TST-701 vs "TST 701" → course_ambiguous, no write. |
| F2-19 | MET | "Strategic Management" (code NULL) → csm; "Strategy" → course_not_found. |
| F2-20/21 | NOT TESTABLE OFFLINE | Nexus preimage + undo. Huddle sends X-Agent-Tool so the insert is logged (by Nexus contract). |
| F2-22 | MET | POST body `type:assignment,status:active,program_id` from course, no points unless integer. |
| F2-23 | MET | batch [dated, undated, dated] → inserted / rejected-undated / inserted; 26 items → batch_too_large, 0 writes. |
| F2-30 | MET | full → 1 write tool, 12 read; no URL → 0/0; no owner → 0/0; no token → 0 write, 12 read. Voice list uses the same `nexusWriteTools()` (realtime-tools.server.ts:178). |
| F2-31 | MET (source + suites) | text pool huddle.functions.ts:3627-3667; voice list realtime-tools:178; text dispatch :4389; voice dispatch :518-526; voice-toolset-hidden 36/36. |
| F2-32 | MET (source) | `mergedTools` and the voice `raw` list are not agent-gated for this tool. |
| F2-33 | MET | schema properties: assignment_id, course, title, due_date, due_time, time_zone, description, points, priority; `additionalProperties:false`; wire probe C5. |
| F2-34 | MET | 200 → inserted/true; 400/500 → failed/false/http_N; throw → network_error; 200 without id → no_row_id_in_response; timeout → persisted "unknown". |
| F2-35 | NOT MET (offline part) / live part NOT TESTABLE | runtime enforcement exists, but C3 N1–N4/N9 pass a false save claim through unchanged; D4 streams the raw 1:1 text. |
| F2-36 | MET | "Nexus write: 1 inserted, 0 updated" ok:true; "Nexus write FAILED: … not saved: http_500" ok:false; unknown → ok:false. |
| F2-37 | MET | C6. |
| F2-38 | NOT TESTABLE OFFLINE | prompt-level only (tool description); no runtime guard. |
| F2-39 | N/A offline | no live writes made. |
| F2-40 | NOT TESTABLE OFFLINE | LLM router. |
| F2-41 | MET | 10/10 phrasings → Elle/Iris on `routeMessage` (probe-routing). |
| F2-42 | MET | `laneOwnerFor(text, elle/iris)` = null for 10/10 (was eli for the due-date phrasing). |
| F2-43 | MET | 1:1 Finn "add my MGT-782 research paper due Dec 9" → iris-chase. |
| F2-44 | MET | 0 added lines containing `elle-rowan`/`iris-chase` in routing.ts, huddle.functions.ts, nexus.server.ts, capabilities.ts. |
| F2-45 | NOT MET in general | board asks → Iris; run/dining/flight → Flex/Finn/Troy; but D3: a finance ask (tuition payment) and a travel ask (apply to NEXUS before trip) move to Iris. ("assign the grocery run to Iris" → charleston-lewis on BOTH trees: pre-existing, unchanged.) |
| F2-46 | MET vs baseline | "tidy up my calendar adjustments" → eli. "fix the typo in the email draft" → cam-post on origin/main AND PR (the AC's expected eli was never the baseline). |
| F2-50 | NOT TESTABLE OFFLINE | timeout bound = read `TIMEOUT_MS` 15 s (imported) → surfaces as persisted "unknown" (F2-34). |

**C1: REFUTED** — offline-testable ACs are mostly MET, but F2-35 and F2-45 are NOT MET on observed
inputs, F2-10/F2-14's "one shared function with F1" is NOT MET by construction (cross-repo copy), and
F2-14's dedup has hole D1.

## C8 — mutations re-run with mutate.sh (anchors/replacements in mut-verify-114/m1..m7.*)

| # | FIX row | File | Mutation | Test cmd / must-fail | mutate.sh verbatim |
|---|---|---|---|---|---|
| m1 | W10 (M01) | nexus-write-shared.ts | `if (namedOwn.some(unsaved)) ownFalse = true;` → `if (false) …` | nexus-write-redteam / RT-H3 | `FIRED: 'RT-H3' failed with the defect reinstated. The guard is real.` |
| m2 | W1 (M05) | nexus-write.server.ts | same-LOCAL-DAY check → `return rm !== null;` | nexus-write-redteam / RT-D1 | `FIRED: 'RT-D1' failed with the defect reinstated. The guard is real.` |
| m3 | W4 (M15) | nexus-write.server.ts | head-decides-session line removed | nexus-write-redteam / RT-K1 | `FIRED: 'RT-K1' failed with the defect reinstated. The guard is real.` |
| m4 | W9 (M19) | nexus-write.server.ts | `est:` alias removed (falls to fixed-offset IANA "EST") | nexus-write-redteam / RT-T1 | `FIRED: 'RT-T1' failed with the defect reinstated. The guard is real.` |
| m5 | W19 (M29) | capabilities.ts | `return signal && capabilityContextPresent(…)` → `return signal;` | router-redteam / RT-R1 | `FIRED: 'RT-R1' failed with the defect reinstated. The guard is real.` |
| m6 | W18 (M26) | useVoiceCallRealtimeSpeak.ts | holding check removed before `pumpSpeech` | nexus-write-fix / FX-V6 | `FIRED: 'FX-V6' failed with the defect reinstated. The guard is real.` |
| m7 | W3 (M08) | nexus-write.server.ts | `withWriteLock` bypassed | nexus-write-redteam / RT-D3 | `FIRED: 'RT-D3' failed with the defect reinstated. The guard is real.` |

Every run also printed `restored: … matches HEAD` and `tree clean: '<name>' passes again on the
restored tree`; `git status --short` = 0 lines afterwards. 7 FIRED, 0 INERT, 0 NOT-APPLIED.
**C8: CONFIRMED** — the guards are real for the inputs they test. (D1–D4 show inputs they do not test.)

## C9 — new adversarial inputs (verifier's own; none appear in REDTEAM/FIX docs)

48 new inputs run (probe-exec 25 titles + 6 dates + 2 dedup, probe-honesty 13, probe-routing 11 new,
probe-lane2 2). Wrong results, each reproducible with the named probe:

| Defect | Input(s) | Wrong result | Repro |
|---|---|---|---|
| D1 dedup | "Research Proposal" `due_date:"2026-10-30T20:00:00Z"`, course MGT-782, stored row due 2026-10-31T03:59:59Z | inserted a 2nd row (1 POST) | probe-exec.ts |
| D2 meeting | "Residency 4, present your research proposal" / "Residency 4 present your research proposal" / "Residency 4. Present your research proposal" / "Residency 4 / present your research proposal" | accepted as assignments | probe-exec.ts |
| D2b vocab | "Spring Recess", "Tuition payment due", "Course evaluations due", "Annual research symposium", "Networking dinner", "Field trip to Ford plant", "Pre-read: Porter Five Forces (HBR 1979)" | accepted | probe-exec.ts |
| D2c over-reject | "Chapter 4 problem set", "Holiday Inn case study", "Spring break reflection paper", "Read and respond: chapter 4" | refused (recoverable) | probe-exec.ts |
| D3 honesty laundered | N1 "I didn't just add the Research Proposal…", N2 "Not a problem I've saved…", N3 "Never fear I added…", N4 "Not only did I add…", N9 denial about the SAVED item + "the proposal is added" | false save claim returned UNCHANGED (text and voice) | probe-honesty.ts |
| D3b honesty decorated | N5 "squared away", N6 "I've changed … deadline", N7 "Moved …", N8 "✓", N10 "on the books", N11 "is set … scheduled" | false claim kept, truth appended | probe-honesty.ts |
| D4 1:1 streaming | any failed write in a 1:1 text turn with streaming on (default) | raw reply persisted to the durable row before the guard | source: huddle.functions.ts:4909-4928 vs :6588 |
| D5 routing | "should I apply to NEXUS before my trip to Toronto", "what's the investment thesis for buying more NVDA", "my semester tuition payment is due Dec 1, can I afford it", "review the course of action for the merger proposal due Friday", "is there a case study on intermittent fasting results", "I'm teaching a training class at work, slides due Friday"; 1:1 Finn "write up an investment thesis for NVDA", 1:1 Troy "apply to NEXUS for me before my Toronto trip" | captured by Elle/Iris; 1:1 hand-off out of the agent's own lane | probe-routing.ts, probe-lane2.ts |

(D-numbers in this table supersede the D3 label used in the C4 section above: routing over-match is D5.)

**C9: REFUTED** — 30+ wrong results across dedup, classification, honesty and routing.

## Verdict

| Claim | Verdict |
|---|---|
| C1 F2 ACs | REFUTED (F2-35, F2-45 NOT MET; F2-10/14 shared-with-F1 NOT MET by construction; rest MET or NOT TESTABLE OFFLINE) |
| C2 owner rules | REFUTED (D1 duplicate row; D2 "Residency 4, present your research proposal" accepted) |
| C3 honesty | REFUTED (D3 laundering on text+voice, D4 1:1 stream) |
| C4 routing | REFUTED (D5: travel/finance/work asks captured, 1:1 hand-offs out of own lane) |
| C5 identity/url/headers | CONFIRMED |
| C6 read-only | CONFIRMED |
| C7 suites + tsc | CONFIRMED (exact counts match) |
| C8 mutations | CONFIRMED (7/7 FIRED) |
| C9 new adversarial | REFUTED (see table) |

**Overall: REFUTED.** Blocking: D1 (a real duplicate row from a schema-allowed input), D2 (the owner's
named meeting example passes with a comma), D3 (a false save claim passes the runtime guard unchanged,
on both text and voice). D4 and D5 are the same defect classes the fix pass reported closed (W18-style
hold missing on 1:1 text streaming; W19/W20 over-match on unlisted inputs).
