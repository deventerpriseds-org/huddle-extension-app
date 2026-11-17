<!--
WHAT:          Independent verification, loop 2, of PR #259 (claude_actions-view, head 50063519): Modules launcher +
               Actions view. Claim verdicts with the command run and the output seen.
WHY:           Tier 1 change (model output becomes items on the owner's list). Loop 1 was killed by a container
               restart after writing only its header, so every claim is re-derived here.
SUPERSEDES:    docs/qc-evidence/VERIFY-actions-view-1.md (header only, no verdicts).
SUPERSEDED-BY: nothing -- current.
EVIDENCE:      this file; probe scripts quoted inline; branch claude_verify-actions-view-1.
-->

# VERIFY: actions-view, loop 2

Verifier worktree, detached at `origin/claude_verify-actions-view-1` (20623da3 = PR head 50063519 + the loop-1
header; `git diff --stat 50063519 HEAD` shows only `VERIFY-actions-view-1.md`). No push to main, no merge, no
workflow dispatch, no live DB touched. Started 2026-11-16 23:29 UTC, budget 90 min.

## 0. Suite re-run (all on PR head code)

Command: `bun scripts/<suite>.test.ts` for each, sequentially, logs in the verifier scratchpad.

| suite | result | builder claimed |
|---|---|---|
| actions-view | 62 passed, 0 failed | 62/62 |
| correspondence-ledger-sql (real PG 16) | 79 passed, 0 failed | 79/79 |
| task-proposals | 199 passed, 0 failed | 199 |
| task-proposals-sql | 45 passed, 0 failed | 45 |
| meeting-triage | 69 passed, 0 failed | 69 |
| meeting-triage-sql | 34 passed, 0 failed | 34 |
| meeting-triage-server | 7 passed, 0 failed | 7 |
| attention / attention-focus | all passed (16 / 27 PASS lines) | all |
| needs-you | 77 passed, 0 failed | 77 |
| correspondence-ingest | 186 passed, 0 failed | 186 |
| onedrive-feed | all passed (61) | 0 FAIL |
| report-from-ledger | 39 passed, 0 failed | 39 |
| feed-staleness / feed-staleness-sql | 98 / 23 passed | 98 |
| redteam-correspondence | 77 passed (not in builder list) | -- |
| onedrive-feed-truth | 11 passed (not in builder list) | -- |
| fireflies-queue-sql | all passed, 14 (not in builder list) | -- |
| fireflies-minutes | 72 PASS, 3 FAILED: G3, G5, G8 | "red as on main" (baseline checked in section 9) |

**CONFIRMED** (counts match the BUILD log exactly).

## Verdicts (appended as each check completes)

### 1. Quote guard (Tier 1) -- `action-classify.ts` `quoteIsVerbatim` / `admitActionVerdict`

Probe: `bun probes/quote.ts` (imports the PR's module directly; 21 spellings). Output:

```
Q1 exact span: verbatim=true admit=open
Q2 newline inside quote vs space in msg: verbatim=true admit=open
Q3 tab/NBSP variants: verbatim=true admit=open
Q4 smart quotes in quote, straight in msg: verbatim=true admit=open
Q5 case difference: verbatim=true admit=open
Q6 empty quote: verbatim=false admit=not_checked
Q7 whitespace-only quote: verbatim=false admit=not_checked
Q8 quote = whole message: verbatim=true admit=open
Q9 7 chars: verbatim=false admit=not_checked
Q10 8 chars with trailing space (trimmed->7): verbatim=false admit=not_checked
Q11 'ab cd' padded: verbatim=false admit=not_checked
Q12 NFC quote vs NFD message: verbatim=false admit=not_checked
Q13 zero-width space inside msg word: verbatim=false admit=not_checked
Q14 ellipsis char vs three dots: verbatim=false admit=not_checked
Q15 quote spans two OTHER messages (Teams join): verbatim=true admit=open
Q16 quote that only matches inside an HTML tag: verbatim=true admit=open
Q17 quote mid-word substring: verbatim=true admit=open
Q18 non-breaking hyphen U+2011 vs -: verbatim=false admit=not_checked
Q19 em dash vs hyphen: verbatim=true admit=open
Q20 null quote: verbatim=false admit=not_checked
Q21 email: quote spanning latest-OTHER body and its forwarded part: true
```

Reading:
- Empty / whitespace / null / under-8 -> never open: **CONFIRMED** (AC-E-3).
- Whitespace, newline, NBSP, tab, smart quotes, case: fold and admit, as AC-E-2 specifies ("after whitespace and
  typographic-quote folding"). Case-folding is not named in AC-E-2 but only widens matching over the same letters;
  not a safety issue. **CONFIRMED**.
- Whole message as quote: admitted (it IS verbatim). Not a defect per AC-E-2.
- HTML-only match (Q16): the guard itself would admit, BUT the haystack never holds markup: email `bodyText` is the
  `htmlToText` visible text (`source-item.ts:44,216`) and Teams text is stripped in `teams-log.ts` before storage.
  Not reachable from stored data. Signature text IS part of the visible body, so a quote taken from a signature is
  admitted (no AC excludes signatures). Observation, not a defect.
- Unicode normalisation (Q12 NFD/NFC), zero-width chars (Q13), `…` vs `...` (Q14), U+2011 (Q18): all FAIL CLOSED
  (not_checked, counted "not checked yet"). Safe direction, recall loss only. **LOW (recall)**: `canonQuote` has
  no `.normalize("NFC")` and does not drop U+200B..U+200D / U+FEFF; a real verbatim quote from a message whose
  body carries a decomposed accent or a zero-width joiner is never shown.
- **DEFECT D1 (MEDIUM, Tier 1 guard gap)** -- Q15 / Q21: a quote that exists in NO single message is admitted when
  it straddles a message boundary. `teamsQuoteHaystack` (`action-classify.ts:152-154`) joins every OTHER message
  with `\n`, and `canonQuote` folds `\n` to a space, so "see you there please send the deck" (end of OTHER msg A +
  start of OTHER msg C, with an OWNER message B between them) is admitted `open`. Same for email
  (`emailQuoteHaystack`, :148-151): latest-OTHER body + forwarded part. AC-E-2 says the quote must be found "in an
  OTHER message" and the Teams instructions say "copied VERBATIM from one OTHER message". Minimal repro:
  `quoteIsVerbatim("see you there please send the deck", teamsQuoteHaystack({messages:[{speaker:"OTHER",text:"ok see you there"},{speaker:"OWNER",text:"x"},{speaker:"OTHER",text:"please send the deck"}]}))` -> `true`.
  Fix direction (not prescribed): test each OTHER message (and the forward) separately.

Verdict claim 1 (quote guard): **REFUTED in part** -- the 8-char floor, empty / null / short / non-verbatim cases
hold; cross-message stitched quotes pass (D1).

### 2. Daily and per-pass caps (`actions.server.ts:101-167`, `pipeline.ts:116-182`)

Probe: `bun probes/caps.ts` drives the PR's `runClassify` with the SERVER's own cap formula
(`used` = stored verdicts with `at >= localMidnight`, `left = min(6, dailyCap - used)`, lines 129-130). Output:

```
A. model failing (e.g. 429 / 15s timeout that still bills), dailyCap=5, 10 passes in one day:
   total model calls = 50 (cap 5); stored verdicts today = 0
B. two concurrent passes (two instances: per-process guard only), cap 5, used 3:
   instance1 left=2 calls=2; instance2 left=2 calls=2; stored today now 5 (cap 5)
C. America/New_York 2026-03-08 / 2026-11-01 / 04:59:59Z / 05:00:00Z -> correct local 00:00
   America/Santiago 2026-09-06 -> local 2026-09-05 23:00 ; America/Havana 2026-03-08 -> local 2026-03-07 23:00
   Lord_Howe, Kolkata, Kiritimati -> correct local 00:00
```

- Per-pass cap of 6 and the 20 s start budget: `left = min(CLASSIFY_PER_PASS, ...)`. `runClassify` stops at
  `res.calls >= callsLeft` and counts the rest as `overCap`. **CONFIRMED** (code, plus probe B: left=2 gave 2 calls).
- Within ONE process, two heartbeats share the in-flight promise (`if (classifying) return classifying`, line 113)
  and the 10-minute throttle. **CONFIRMED** by reading the code.
- **DEFECT D2 (MEDIUM, cost; AC-H-3 "at most N model calls per owner per day")**. The daily cap counts STORED
  verdicts, not model calls (`callsToday`, lines 69-76). None of these is counted, because none stores anything:
  a call that throws (a timeout at 15 s, where `Promise.race` does not abort the HTTP request, so the provider
  still bills it), a `propose` failure, or a `storeVerdict` failure. Probe A: cap 5, model failing, 10 passes ->
  **50 model calls, 0 counted**. The worst case is the throughput ceiling of 6 per 10 minutes, which is 864 a day
  whatever the cap is. The BUILD log's "the hard ceiling is the daily cap (150)" does not hold when calls fail.
- **DEFECT D3 (LOW, cost; race)**. Across instances there is no lease: `lastClassifyMs` and `classifying` are
  module variables. Two instances read the same `used` and `judged`, both get `left`, and both call the model for
  the SAME first threads. Probe B: cap 5, used 3 -> 4 calls, so 7 for the day against a cap of 5, and the
  duplicate pair classified the same two chats. The ingest pass itself is safe across instances through the ledger
  claim; this step is not.
- Midnight rollover: the day boundary is `localMidnightMs(now, tz)`, recomputed each pass. New York DST days and the
  04:59:59Z / 05:00:00Z boundary are exact. **CONFIRMED.** INFO: in zones whose DST change happens AT midnight
  (Santiago, Havana), the "day" starts at 23:00 the evening before, so one extra hour is counted. The owner's zone
  is New York, but `resolveActionsSettings` accepts any IANA zone.

Verdict claim 2: **REFUTED** for the daily cap as a hard ceiling (D2) and for concurrency across instances (D3).
The per-pass cap and in-process concurrency are CONFIRMED.

### 3. Uninvolved chats never reach the AI; channels hidden like groups; ONE rule

- `pipeline.ts:69-73` `threadUnits`: chats in `plan.teams.hiddenUninvolved` become units only when
  `!s.hideUninvolvedChats`. When the switch is ON, they never become units, so `runClassify` cannot send them to the
  model. Suite tests E-1 and S-15 pass.
- Channels: `report-from-ledger.ts:134` maps `thread.tacv2` to `channel`, and `:171` covers channel along with
  group and meeting. Suite test S-4 passes.
- One implementation: `chatInvolvement` is defined only in `report-from-ledger.ts:167`. `grep -rn chatInvolvement
  src scripts` finds no second definition. `scripts/action-scan-steps.ts` takes the plan from the same module and
  imports `quoteIsVerbatim` from `action-classify.ts` (lines 23-38).
- **Mutation M2** (my own): `if (!s.hideUninvolvedChats) for` -> `if (true) for` in `pipeline.ts`, run with
  `mutate.sh ... "bun scripts/actions-view.test.ts" "E-1 one call per in-window thread"`. Result: **FIRED (control
  EQUIVALENT)**, exit 0, file restored to HEAD.

Verdict claim 3: **CONFIRMED**.

### 4. Decided items stay hidden; a newer message brings an item back; Wrong? hides one version; Undo

- Decided items: `selectActionItems` lists only proposal states `proposed` / `untriaged` (`actions.ts:245,302`).
  **CONFIRMED** (code, plus the BUILD's m7 and suite test F-1).
- Wrong? hides only its own version: `correctionHides` compares `itemKey`. Probe `probes/correction.ts`: after
  Wrong? on A, A is hidden and B is not. On A's newer version (new key), `hides=false`, so it is judged again.
  Undo (`withdrawnAt`) shows it again. **Mutation M3** (my own): `!c.withdrawnAt && c.itemKey ===
  currentItemKey` -> `!c.withdrawnAt` in `actions.ts`, pattern `G-4 GUARD: hides the SAME version only`. Result:
  **FIRED (control EQUIVALENT)**, exit 0, restored.
- **DEFECT D4 (MEDIUM, Tier 1: a correction un-hides another item)**. `owner_correction` is ONE value per
  proposal, but one proposal can back two threads: store `upsertOnce` step 2 attaches a second source with the same
  `norm_title` to the active proposal (`proposals-store.server.ts` "already ACTIVE from another source: attach").
  Probe output:
  ```
  after Wrong? on A: hides A = true  hides B = false
  after Wrong? on B: hides A = false  hides B = true
  Undo (on B): hides A = false  hides B = false
  ```
  Repro: two chats both ask "Complete the training" -> one proposal. Press Wrong? on chat A, then Wrong? on chat B:
  chat A comes BACK into the list, although nothing about A changed. Undo on B does not restore A's correction.
- **OBSERVATION O1 (newer message after Dismiss)**. If the newer message gets the same to-do wording, then
  `proposeFromSource` finds the dismissed proposal (F15, "a dismissal suppresses the same to-do from ANY source").
  It returns `suppressed`, which Actions maps to `{onBoard:true}` (`actions.server.ts:148`). The item then drops
  out of the list without being counted anywhere: not in notChecked and not in hidden. After **Done**, the same
  follow-up creates a new proposal and IS listed. So "a newer message brings it back" holds after Done and does
  not hold after Dismiss when the wording is the same. This is consistent with the existing F15 decision, so it is
  not a defect against the ACs, but it is invisible to the owner. UNPROVEN against a real store (code read only).
- OBSERVATION O2 (LOW): the classification key is thread key + latest message id, with no content hash. An EDITED
  latest message (ledger `content_hash` change, `ledger.server.ts:224-240`) keeps the old verdict and its old
  quote, which may no longer appear in the edited text.

Verdict claim 4: decided-hidden and same-version Wrong?/Undo **CONFIRMED**. "Hides only that version" is
**REFUTED** when two threads share one proposal (D4). The newer-message claim is **UNPROVEN** (O1).

### 5. Mark processed keeps the stored verdict (`ledger.server.ts:355-362`)

The diff keeps `result_ids->'action'` through `markProcessed`. `correspondence-ledger-sql` (real PostgreSQL 16)
gives 79/79, including AI-9. `grep "result_ids\s*="` across `src`: the only writers are this UPDATE and
`storeVerdict` (`||` merge), and the column is `NOT NULL DEFAULT '{}'` (line 79), so the `||` never meets a NULL.
Mutation m10 (the builder's) was not re-run. **CONFIRMED.**

### 6. Bell: Done / Dismiss in Actions settles only the matching bell row

`proposals.server.ts`: the settle runs only when `fromActions && r.ok && !r.alreadyDone`, with the targets from
`bellTargetsFor(r.row.sources)`. `settleBellRows` (`email-replies.server.ts`) matches by owner,
`status IN ('owed','drafted')`, and the email `graph_message_id` or Teams chat `conversation_id`. Suite test H-1
passes. Caveat that comes from D4's mechanism: a proposal with refs from two threads settles BOTH threads' bell
rows. A Teams settle is per CHAT, not per message. **CONFIRMED** for the single-source case. The multi-source
case is by design of the refs (not covered by an AC).

### 7. The `correspondence.proposals` flag bypass applies only to the Actions row buttons

**DEFECT D5 (LOW, flag bypass)**. `from: "actions"` is a client-supplied zod enum
(`proposals.functions.ts`, `from: z.enum(["actions"]).optional()`). The server never checks that the proposal is
one that backs an Actions row. Any signed-in owner call to `actOnProposalFn` with `from:"actions"` can approve,
complete, dismiss, edit or triage ANY of their own proposals while `correspondence.proposals` and
`meetingTriage` are OFF (only the ingest must be on). Ownership is still enforced by `callerOwners`, so no
cross-user exposure. Verdict: **REFUTED** as stated ("only the Actions row buttons" is a client convention, not a
server rule).

### 8. Security

- Server functions: `getActionsPage`, `saveActionsSettings` and `correctActionItem` go through `ownedScope`. A
  caller who is not the configured owner gets `off` or `Sign-in required.`. `correctActionItem` selects and updates
  `chat.task_proposals WHERE id = $2 AND owner_email = ANY($1)`, so another user's proposal id gives "That item
  isn't in your list." (code read). `PropId` is regex-validated. **CONFIRMED** by reading the code; not run
  against a DB.
- **DEFECT D6 (LOW)**. `correctActionItem` derives the ledger row it writes from the CLIENT's `itemKey`
  (`actions.server.ts:320-322`), not from the proposal. The owner can therefore stamp `owner_correction` on any of
  his own email or Teams ledger rows. It is owner-scoped, so there is no cross-user write.
- Logs: `git diff origin/main...50063519 -- src | grep console.` gives three lines, all counts or `e.name` only
  (`actions.server.ts:155-160`, `actions.functions.ts:23`). **CONFIRMED.**
- Hard-coded addresses: an email-address regex over every added line under `src` finds 0 hits. **CONFIRMED.**

### 9. Build, typecheck, baseline

- `npx tsc --noEmit`: exit 0. `npm run build`: exit 0 (nitro "You can deploy this build"). The tree is clean
  afterwards.
- Baseline: `git archive origin/main` (046ec493) unpacked, then `bun scripts/fireflies-minutes.test.ts` gives
  `FAIL G3`, `FAIL G5`, `FAIL G8`, `3 FAILED`, the same three as on the PR head. **CONFIRMED** (these failures
  exist before the PR).

### 10. Mutation proofs run by this verifier (mutate.sh, all with control)

| id | file | mutation | test pattern | result |
|---|---|---|---|---|
| M1 | action-classify.ts | drop `q.length >= MIN_QUOTE_CHARS && ` | `A-4 GUARD: quote under 8 characters` | FIRED (control EQUIVALENT), exit 0 |
| M2 | pipeline.ts | `if (!s.hideUninvolvedChats) for` -> `if (true) for` | `E-1 one call per in-window thread` | FIRED (control EQUIVALENT), exit 0 |
| M3 | actions.ts | correctionHides drops the itemKey test | `G-4 GUARD: hides the SAME version only` | FIRED (control EQUIVALENT), exit 0 |

(M1's first attempt used the pattern `FAIL A-4` and returned UNDETERMINED, exit 4, because the pattern was wrong.
It was re-run with the test name.) The builder's other 8 mutations (m3-m9, m11) were NOT re-run.

### NOT REACHED (budget cut to 25 min by the coordinator)

- The per-AC sweep of all 96 ACs in `AC-actions-view-modules.md`. Only the Tier 1 items above were derived.
- The E-U spelling table, row by row. Only S-4 (channel) and the switch were checked, through the suite and M2.
- UI: `ModulesLauncher.tsx`, `ActionsView.tsx`, `Rail.tsx`, `ViewSwitcher.tsx`, `HuddleApp.tsx` (tokens and raw
  colours; Priorities and Schedule reachable from Modules on desktop and phone). No browser run was made, so every
  UI claim is UI-UNVERIFIED.
- Re-running the builder's mutations m3-m11.
