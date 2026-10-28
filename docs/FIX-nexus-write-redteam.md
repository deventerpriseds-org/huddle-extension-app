# Fix pass: red-team findings W1..W21 against `write_nexus_assignments`

<!--
WHAT:          The fix log for the 21 WRONG findings in docs/REDTEAM-nexus-write-tool.md: per finding,
               fixed / not fixed + why, the test that pins it, and the mutation verdict that proves the
               new guard is load-bearing.
WHY:           The red-team pass (Tier-1 pre-pass) left 51 failing tests (39 tool + 12 routing) against
               builder commit 507e13b. This pass makes them pass without weakening them.
SUPERSEDES:    nothing. RESPONDS TO docs/REDTEAM-nexus-write-tool.md (findings) and builds on
               docs/BUILD-nexus-write-tool.md (builder's log).
SUPERSEDED-BY: nothing -- current.
EVIDENCE:      branch fix/nexus-write-redteam from ad88b5d; `bash scripts/run-nexus-fix-suites.sh`
               (counts in Results); mutation runs via /usr/local/bin/mutate.sh with anchors and
               replacements written to files (34 runs, verdicts verbatim below). Offline only: fetch
               mocked, no live Nexus/Huddle, no DB or board writes.
-->

Status words: **fixed** = the red-team test passes and the mechanism is in code, proved by a mutation;
**not fixed** = with the reason. No red-team test was edited or weakened; none was judged wrong.

## Per-finding status

| W | Finding | Status | Fix (where) | Test(s) | Mutation (mutate.sh verbatim) |
|---|---|---|---|---|---|
| W1 | recurring same-title deliverables collapse onto the first | fixed | `findDuplicate` rule 1 = same title AND same LOCAL day (course zone); a recurring insert carries a note naming the other dates | RT-D1, FX-D3 | M05 `FIRED: 'RT-D1' failed with the defect reinstated. The guard is real.` |
| W2 | same-day word-subset over-match | fixed | rule 2 also requires the same HEAD noun, the same numbers, and >=2 words in the shorter title | RT-D2a/b/c, FX-D2 | M06 `FIRED: 'RT-D2a' …`; M07 `FIRED: 'FX-D2' …` |
| W3 | concurrent near-identical inserts | fixed (one instance) | `withWriteLock` serialises every write call in the process; per-turn claim key = normalised (course, title, local day) per item, sorted, hashed (`nexusWriteClaimKey`) | RT-D3, FX-C1..C5, FX-G7 | M08 `FIRED: 'RT-D3' …`; M09 `FIRED: 'FX-C2' …`; M10 `FIRED: 'FX-C5' …`; M11 `FIRED: 'FX-C1' …`; M12 first `INERT: 'FX-G7' still PASSED with its defect reinstated.` -> test tightened -> `FIRED: 'FX-G7' …` |
| W4 | a session with an incidental deliverable noun is filed | fixed | `classifyNonDeliverable`: the title HEAD (before `:` / spaced dash / `(`) decides; a head ending in a session word or "session word + about/for/on" is a session | RT-K1, FX-K1 | M15 `FIRED: 'RT-K1 "Residency 4: present your research proposal"' …` |
| W5 | meeting vocabulary gaps | fixed | MEETING_WORD + colloquium, class, appointments, advising, guest speaker, study group, live/coaching/conference/… calls | RT-K2 | M16 `FIRED: 'RT-K2 "Doctoral colloquium 2"' …` |
| W6 | holiday / admin gaps | fixed | ADMIN_DATE (all named breaks, reading/study week, last day to withdraw/drop, grades due/posted, census, commencement) + HOLIDAY names (refused unless a deliverable noun names the thing) | RT-K3 | M17 `FIRED: 'RT-K3 "Thanksgiving" is' …` |
| W7 | an undated stored row swallows the owner's date | fixed | `findDuplicate` returns `storedUndated`; the item says the stored row has NO due date and offers the update; `outcome` asks "want me to add it?" | RT-D4, FX-D4/D5 | M13 `FIRED: 'RT-D4' …` |
| W8 | a stray denial word launders a false save | fixed | `enforceNexusWriteHonesty` rewritten: clause-level, a denial counts only as a NEGATED SAVE and only acknowledges the item(s) it names | RT-H1, RT-H2, FX-H1 | M02 `FIRED: 'RT-H1' …`; M03 `FIRED: 'FX-H1' …` |
| W9 | `EST` stores an Eastern deadline an hour late | fixed | `resolveZone`: EST/EDT/ET/Eastern -> America/New_York (CT and PT families likewise); MST/MT refused as ambiguous (Arizona vs Denver) | RT-T1, FX-T1/T2 | M19 `FIRED: 'RT-T1' …` |
| W10 | mixed batch: a true denial about B carries a false claim about A | fixed | a claim clause that NAMES an item whose own `persisted` !== true is false whatever else the reply says -> whole reply replaced by the per-item statement | RT-H3, FX-H2 | M01 `FIRED: 'RT-H3' …` |
| W11 | success phrasings outside CLAIM_RE were appended-to | fixed | CLAIM_RE covers "is (now) in Nexus", "it's in", "put … into", "went through", ✅ etc.; any false claim replaces, never decorates | RT-H4, RT-H4b | M04 `FIRED: 'RT-H4 ' …` |
| W12 | readings filed as assignments | fixed | READING -> `"reading"` refusal unless graded work is named ("Reading response 3", "Reading quiz" still pass) | RT-K4, FX-K1/K2 | M18 `FIRED: 'RT-K4' …` |
| W13 | DST-gap time moved EARLIER | fixed | `zonedLocalToUtcMs` resolves a nonexistent time FORWARD (02:30 -> 03:30 EDT, 07:30Z); overlap keeps the first occurrence; the item carries `time_shifted: true` | RT-T2, FX-T3..T5 | M20 `FIRED: 'RT-T2' …` |
| W14 | non-Latin titles never dedup | fixed | `dedupTitle` is Unicode-aware (`\p{L}\p{N}`, NFKC); `normTitle` left byte-identical to Nexus's | RT-D5 | M14 `FIRED: 'RT-D5' …` |
| W15 | a ref normalising to "" matches a ""-coded course | fixed | `resolveCourse` returns `course_required` for a reference with nothing comparable | RT-C1 | M21 `FIRED: 'RT-C1' …` |
| W16 | fractional points dropped silently | fixed | REFUSED, not rounded (a weight is not points; builder's F2-22 also forbids sending 20.5): item keeps saving, gets `points_note`, and `outcome` says "Points not saved … whole number" | RT-P1, FX-P1 | M22 `FIRED: 'RT-P1' …` |
| W17 | group: the suppressed teammate's reply was unguarded | fixed | huddle.functions.ts: the first write's outcome promise is kept by claim key; a suppressed call records `(…, firstOk, firstDetail)` and returns THAT result; reply assembly also passes teammates' writes, so a teammate's claim NAMING a writer's failed item is dropped and the truth appended | RT-H5, FX-G1..G8 | M23 `FIRED: 'RT-H5' …`; M24 `FIRED: 'FX-G6' …`; M25 `FIRED: 'FX-G1 ' …` |
| W18 | voice had no runtime honesty | fixed | `createNexusWriteSpeechGate` (pure, nexus-write-shared.ts) + useVoiceCallRealtimeSpeak.ts: a write with an unsaved item arms the gate; while armed the reply is buffered, not streamed, and on `text.done` the CHECKED text (`enforceNexusWriteHonesty(raw, gate.uses)`) is spoken, captioned and persisted; reset on the next user utterance. The executor also returns `outcome`, a truthful summary the model can say as-is | RT-H6, FX-V1..V8 | M26 `FIRED: 'FX-V6' …`; M27 `FIRED: 'FX-V2' …`; M28 `FIRED: 'FX-V7' …`; M34 (deleting only the import line) `INERT: 'RT-H6' still PASSED with its defect reinstated.` -- see note |
| W19 | non-coursework asks stolen by Elle/Iris (group) | fixed | agents.ts DATA: `requiresContext` on the shared capability (strong: syllabus, EMBA/MBA/DBA, professor, research paper, case analysis, … ; strong pattern "to/in/into Nexus", "Nexus assignment"; weak: class/course/semester/school, course-code pattern, "my … assignments", paper/essay + due-date/deadline cue; vetoes: flight, seat, client, quarterly, tax, toilet, card, kid, grocery, …). capabilities.ts: trigger AND context. Builder's extra Elle themes reverted to the 4809e2e baseline. Router LLM prompt: one generic sentence ("sharing a word with the label is not enough") | RT-R1 (7), FX-R1 | M29 `FIRED: 'RT-R1 "change my seat assignment on the flight to Denver" is not routed by the coursework prime rule' …`; M31 `FIRED: 'FX-R1 "my kid's school project is due Friday"' …`; M33 `FIRED: 'RT-R1 "my tax papers are due April 15"' …` |
| W20 | 1:1 hand-off out of the agent's own lane + follow-up DM | fixed | same context gate: `primeLaneDecision` returns null without coursework context, so `laneOwnerFor` and the 1:1 owner follow-up (both read it) keep the ask | RT-R2 (2) | M30 `FIRED: 'RT-R2 1:1 troy-lennox: "change my seat assignment on the flight" stays with troy-lennox' …` |
| W21 | coursework asks outside the trigger list went to Eli | fixed | triggers broadened to assignment-shaped words (paper, essay, case analysis/study, proposal, exam, due, deadline …) -- safe only because context is now required; "case analysis", "professor" are strong context | RT-R3a, RT-R3b (2), FX-R2 | M32 `FIRED: 'RT-R3a' …` |

Note on M34: RT-H6 is a source-presence check (any voice/realtime file mentioning the guard). Deleting
only the import line leaves the call site text in place, so RT-H6 cannot see it; the behaviour is
proved instead by FX-V6 (no streaming while held), FX-V2 (a failed write arms the gate) and FX-V7 (the
checked text is what is spoken) -- all FIRED. RT-H6 is not a wrong test; it is a weak one, and it is
kept as written.

## Design notes (owner rules honoured)

- **Honesty is structural.** The guard reads the per-item results, cuts the reply into clauses, and
  judges each success claim against the `persisted` of the item it names. One denial never excuses
  another item's claim. On any false claim the reply is replaced by `nexusWriteOutcomeStatement`
  (built from the results). Teammate mode only touches sentences that NAME the writer's unsaved item.
- **A suppressed duplicate carries the first outcome** (W17), and a duplicate claimed in an EARLIER
  chunk of a resumed turn reports every item as `persisted:'unknown'` (`nexusWriteUnknownOutcome`) --
  never a fabricated ok.
- **Voice gets the same code check** (W18), at the only place it can run: the client that turns the
  model's text into ElevenLabs speech.
- **Routing is data.** No agent id appears in capabilities.ts or routing.ts; the coursework context
  lives on the capability in agents.ts. Agent prompts untouched (additive-only rule); only the
  generic router-prompt PRIME line gained one sentence.

## Residuals (not fixed, and why)

- **W3 across server instances.** `withWriteLock` serialises writes inside ONE Node process (both
  agents of a group wave run in the same invocation, which is the measured case). Two separate
  Azure instances writing the same item at the same instant are not serialised; that needs a unique
  constraint or an idempotency key on the Nexus side (`content.assignments` has neither).
- **W18 text spoken BEFORE the tool call.** If the voice model says "Adding it now -- done!" in the
  same response, before it emits the function call, that sentence is already voiced; the gate arms
  only when the result arrives. The gate covers every reply that follows the result.
- **W18 across exchanges.** The gate resets at the next user utterance, so a later "yes, it's saved"
  in a new exchange is not checked against an earlier failure.
- **Teammate generic claims.** A teammate's un-named "Done" is treated as about its own work and is
  not checked (by design; checking it would rewrite unrelated replies).
- **W19 on the LLM router path** is not measurable offline; the prompt line was tightened, the
  deterministic path is proved. Measure with the `test-agent-serverfn` harness before claiming it.
- **MST/MT are now refused** (ambiguous). A syllabus from Arizona has to be given as America/Phoenix.
- Pre-existing, unrelated: `scripts/model-policy.test.ts` reports `resolveByDifficulty: 7/8 PASS`
  (it imports only a type from agents.ts; inference, not re-measured on ad88b5d).

## Results

`bash scripts/run-nexus-fix-suites.sh` on the final commit:

| Suite | Result |
|---|---|
| scripts/nexus-write-redteam.test.ts | 39 passed, 0 failed (was 0/39) |
| scripts/router-redteam.test.ts | 12 passed, 0 failed (was 0/12) |
| scripts/nexus-write-tool.test.ts | 115 passed, 0 failed |
| scripts/router-winners.test.ts | 39 passed, 0 failed |
| scripts/nexus-read-tools.test.ts | 190 passed, 0 failed |
| scripts/cross-app-turn-gate.test.ts | 92 passed, 0 failed |
| scripts/voice-toolset-hidden.test.ts | 36 passed, 0 failed |
| scripts/nexus-write-fix.test.ts (new) | 50 passed, 0 failed |
| `npx tsc --noEmit -p .` | clean (exit 0) |

Mutations: 34 runs, 33 FIRED, 1 INERT (M34, explained above; first M12 INERT led to FX-G7 being
tightened, then FIRED). No NOT-APPLIED, PRE-DIRTY or TREE-NOT-CLEAN.
