<!--
WHAT:          Independent verification, loop 2, of branch claude_actions-accuracy (head 905a9360).
WHY:           Owner report 2026-11-17 (Actions view: sender reversed, hallucinated asks, no AI-misread reason,
               label lines as rows, cut-off text, duplicate Teams ask). Loop 1 was killed by an interrupt with no verdicts.
SUPERSEDES:    VERIFY-actions-accuracy-1 (never written: loop 1 recorded nothing).
SUPERSEDED-BY: nothing -- current.
EVIDENCE:      commands and outputs inline; repro script scratch-only; synthetic data only (public repo).
-->

# VERIFY: actions-accuracy, loop 2

Verifier, independent. Started 2026-11-17 04:45 UTC. Branch under test `origin/claude_actions-accuracy` 905a9360.

## C0 -- Suite re-run, tsc, build

Command: `bun scripts/<name>.test.ts` for each; `npx tsc --noEmit -p .`; `npx vite build`.

| suite | builder | observed |
|---|---|---|
| actions-accuracy | 25 | 25 passed, 0 failed |
| actions-view | 90 | 90 passed, 0 failed |
| actions-view-server | 28 | 28 passed, 0 failed |
| report-from-ledger | 103 | 103 passed, 0 failed |
| correspondence-ingest | 186 | 186 passed, 0 failed |
| meeting-triage / -sql / -server | 69/34/7 | 69 / 34 / 7 passed, 0 failed |
| task-proposals / -sql | 199/45 | 199 / 45 passed, 0 failed |
| tsc | clean | rc=0 |
| build | clean | rc=0 |

Verdict C0: CONFIRMED.

## Repro scripts

Scratch only (not committed): `repro.ts` and `repro2.ts`, run with `bun`, importing the branch's modules directly.
All names and ids invented. Output lines quoted below verbatim.

## C1 -- Owner recognition (Tier 1)

| test | observed | verdict |
|---|---|---|
| A1 owner id only on ANOTHER chat's older row | `["Pat Example:OTHER","Ellis, Von:OWNER"]`, settled `true` | CONFIRMED |
| A2 name fallback, ownerNames `["Von Ellis"]` | `Ellis, Vonda:false, Von Ellisson:false, Ellis, Von (Contractor):false, Ellis Von:false, VON  ELLIS:true, Ellis, Von:true` | CONFIRMED: no near-namesake is taken |
| A2b app sender named as owner | `[]` | CONFIRMED |
| A2c exact-name namesake once any id is known | `["owner-guid-1"]` only | CONFIRMED |
| A3 DEFAULT owner names with no `correspondence.ownerNames` | `effectiveOwnerNames` for a `von.ellis@` login -> `["Von"]`; with that list `"Ellis, Von"` -> **false**, a sender named exactly `"Von"` -> **true** | see D-3 |
| A4 one row with a WRONG `ownerUserId` | that sender becomes OWNER in **every** chat: `["Sam Other:OWNER"]`, latestOther `null` | see D-4 (risk; not live today, probe says 1 distinct id) |
| A5 uninvolved rule, group chat, rows lack `ownerUserId` | `fromOwner=null`: before `cant_tell_owner_unknown`, after the same. `fromOwner=false`: before `cant_tell_owner_unknown`, after **`uninvolved`** (hidden) | see D-5 |

Verdict C1: CONFIRMED for the live shape (ids exist on older rows; every recent row has `fromOwner` null, so A5 does
not change live hiding). Defects/risks D-3, D-4, D-5 below.

## C1b -- STALE VERDICTS ARE NOT RE-JUDGED (outside the stated radius)

The item key is `teams:<chatId>|<id of the LAST message>` (`pipeline.ts:68`), independent of who is labelled OWNER,
and `buildCandidates` shows a stored verdict whenever `v.key === u.itemKey` (`pipeline.ts:251`). So a verdict stored
by the OLD code (the owner's own sentence judged as an ask) keeps its key after the fix and is still listed.

`bun repro2.ts` (stored verdict shaped exactly as the old code would have stored it for that key):
```
branch itemKey teams:19:a_b@unq.gbl.spaces|19%3Aa_b%40unq.gbl.spaces:m2 | last msg is owner's m2: true | settled true
candidate after fix: {"status":"open","who":"Pat Example","title":"Send the signed form by Friday","quote":"could you send me the signed form by Friday","reason":"Ellis, Von asks you to send the signed form."}
listed teams count: 1
```
After the fix the row is still listed, now attributed to the OTHER person while quoting the owner's own sentence.
Verdict: REFUTED that the deployed fix corrects the rows the owner is already looking at -- each stays until its
chat receives a new message. -> D-1.

## C2 -- settledGuard (Tier 1)

| test | observed | verdict |
|---|---|---|
| B1 other's ask AFTER owner's last | settled `false`; verdict `open`, kind `reply` | CONFIRMED (never dropped) |
| B2 equal timestamps (both insertion orders) | settled `false` both; verdict `open` | CONFIRMED |
| B3 other's time unparseable | settled `false` | CONFIRMED (fails toward showing) |
| edited messages | `at` is `createdDateTime` (`teams-log.ts:296`); an edit keeps its id and time, so ordering is unchanged | CONFIRMED by code read |
| B4 settled: `action` kept / `both` -> `action` / `reply` -> `none` + answeredByReply | as stated | CONFIRMED |
| B5 settled, reason "You haven't replied to Pat yet." | reason `null` | CONFIRMED |
| B5b settled, the TODO says "You have not replied to Pat: send the deck" | todo kept verbatim | D-6 (low) |
| B5c reason "You still need to resubmit the form." | kept (prompt-only, no deterministic guard) | D-6 (low) |
| B5d over-match "You can't reply-all on this list..." | reason nulled (harmless, reason line only) | noted |
| B6 unsettled, "You have not replied yet." | kept (true there) | CONFIRMED |

## C3 -- GROUNDING is additive

`branch.split(GROUNDED).join("") === main` for STEP2_INSTRUCTIONS, STEP3_INSTRUCTIONS, TEAMS_INSTRUCTIONS: `true`
for all three; GROUNDED appears exactly once in each; no other exported string constant differs from origin/main.
Verdict: CONFIRMED.

## C4 -- D1 (quote from ONE message)

Quote spanning two OTHER messages -> `false`; the owner's own sentence -> `false`; a span of one OTHER message -> `true`.
Verdict: CONFIRMED.

## C5 -- Meeting splitter

Input (synthetic): `**Pat Doe**`, `- Pat to send the deck (01:02)`, `Responsible person: Not stated.`, `Timestamp: (01:01-01:32).`,
`- Timing the launch with marketing`, `- Notes from Jane on budget`, `- Owner review of the vendor list`,
`- **Deadline**: submit the grant application by Dec 1`, `- Note: Von to send pricing to the client`, `Timing: Beyond two weeks, inferred`.
```
E items => ["Pat to send the deck","Timing the launch with marketing","Notes from Jane on budget","Owner review of the vendor list"]
E details => [[responsible person, timestamp],[],[],[deadline: submit the grant..., note: Von to send pricing to the client, timing]]
```
- Label-like words WITHOUT a colon stay items: CONFIRMED.
- A genuine bulleted item written `Label: <action>` is swallowed as a detail; `details` is read by nothing outside
  the splitter (grep), so the action disappears from Actions: D-7.
- `Notes:` alone (after a heading) is now a detail, so the next item inherits the PREVIOUS heading
  (`headings: ["Von Ellis","Von Ellis"]` for `Sam to book the room`). Shows more, never hides more: noted.
- meeting-triage suites 69/34/7 green.
Verdict: CONFIRMED with D-7.

## C6 -- Teams de-duplication

| test | kept | verdict |
|---|---|---|
| F1 same sender, different quotes | `["a","b"]` | CONFIRMED |
| F2 same sender, SAME short generic sentence ("Can you take a look at this?") in two different chats | `["b"]` | **REFUTED** -> D-2 |
| F3 different senders, same quote | `["a","b"]` | CONFIRMED |
| F4 shared proposalId, different senders and quotes | `["b"]` | depends on whether two asks can share a proposal; noted |
| F6 no `at` on either | `["a"]` | CONFIRMED (no crash) |

Addendum to F4 (code read, `proposals-store.server.ts:192-206`, OQ-9): a new to-do whose `norm_title` matches an
ACTIVE proposal from another source is ATTACHED to that proposal. So two different Teams asks whose to-do folds to
the same title ("Review the document") share one `proposalId`, and `collapseDuplicateTeamsItems` then lists only one
of them -- the second path into D-2.

## C7 -- UI (code read only; rendered result is MERGE-PENDING-UAT)

- Expand/collapse: one `expanded` state per row; title, meta and summary switch `truncate`/`line-clamp-2` to
  `whitespace-pre-wrap break-words`; a "More"/"Less" button with `aria-expanded`. CONFIRMED by read.
- Wrong? textarea: `useLayoutEffect` on `[text]` sets `height = scrollHeight`, `overflow-hidden`, capped by
  `maxLength={CORRECTION_TEXT_MAX}`. CONFIRMED by read.
- `ai_misread`: added to `CORRECTION_REASONS` + `CORRECTION_LABEL`; the chips are `CORRECTION_REASONS.map`, the send
  goes through the same `correctActionFn` -> `makeCorrection` validator (`actions.ts:255`); no other reason list exists
  in `src` (grep for `not_mine` / `CORRECTION_REASONS`). CONFIRMED by read; R3-2 green.
- Tokens only: grep of the added lines for hex / rgb / hsl / palette classes -> none. CONFIRMED.
- Note: the "More" button is `min-h-6` (24px), below a 44px touch target on a phone (low). It also shows on rows whose
  text is not truncated.
- The builder's UAT checks ACC-3/4/5 (`actions-view-checks.mjs`) exist but were not run (no dispatch allowed here).

## C8 -- Mutation proofs (`mutate.sh`, anchors in files, exit code read)

| # | file | mutation | test | outcome | exit |
|---|---|---|---|---|---|
| M1 | report-from-ledger.ts | `ownerIdsAll = [...configuredOwnerIds]` (per-chat again) | R1-1 | FIRED (control EQUIVALENT) | 0 |
| M2 | action-classify.ts | `if (a.settled && false) return settledGuard(rest)` | R2-1 | FIRED (control EQUIVALENT) | 0 |
| M3 | meeting-triage.ts | `detail = null` (no label detection) | R4-1 | FIRED (control EQUIVALENT) | 0 |
| M4 | pipeline.ts | `q = ""` (no quote key in de-dup) | R6-1 | FIRED (control EQUIVALENT) | 0 |
| M5 | action-classify.ts | `reason = v.reason` (no NOT_REPLIED scrub) | R2-3 | FIRED (control EQUIVALENT) | 0 |

Every run reported the source restored to HEAD and the named test green again. `git status --short` empty afterwards.

## C9 -- Test-merge origin/main

`git merge-base --is-ancestor origin/main origin/claude_actions-accuracy` -> true (0 behind, 5 ahead).
`git merge-tree --write-tree origin/main origin/claude_actions-accuracy` = `b8fbc043...` = the branch's own tree, so
the suites in C0 ran on exactly the merged tree. CONFIRMED.

## Defects

| id | severity | where | what | repro |
|---|---|---|---|---|
| D-1 | **HIGH** | `pipeline.ts:68` (key) + `pipeline.ts:251` (`v.key === u.itemKey`) | Verdicts stored by the old code are not re-judged: the key does not depend on who is OWNER, so every row the owner already sees with a reversed sender stays listed after deploy (now with `who` = the other person and the owner's own sentence as the quote) until that chat gets a new message. | `bun repro2.ts`, C1b |
| D-2 | MEDIUM | `pipeline.ts` `collapseDuplicateTeamsItems` | Two different asks collapse: (a) same sender, same short generic sentence in two different chats ("Can you take a look at this?") -> one row; (b) any two Teams asks sharing a proposal, which the store does by `norm_title` across sources, even with different senders. Breaks "two genuinely different asks from the same sender must never collapse". | repro F2, F4 |
| D-3 | MEDIUM | `report-from-ledger.ts` `ownerTeamsIdsAcross` / `teamsSourceLabel` with `needs-you.ts:124` | With no `correspondence.ownerNames` configured the owner names default to the login's FIRST name (`["Von"]`): the display-name last resort never matches "Ellis, Von" (and would match a sender named just "Von"), and the "Teams group chat" relabel never fires for a chat named "Ellis, Von". Live effect depends on config I could not read. | repro A3 |
| D-4 | MEDIUM (latent) | `ownerTeamsIdsAcross` | The fix now relies on older rows' `ownerUserId`. (a) Stored content is purged after `contentRetentionDays` (default 90, `onedrive-feed.ts:95`); if the flow keeps omitting `ownerUserId`, recognition silently reverts once the Nov 9-13 rows are purged. (b) One row with a wrong `ownerUserId` now relabels that sender as OWNER in every chat (their asks vanish), where before it affected one chat. Not live today (probe: 1 distinct id). Configuring `teams.ownerSenderIds` (already an open owner item) closes both. | repro A4 |
| D-5 | LOW | `chatInvolvement` now gets the global ids | A group chat whose rows carry `fromOwner` false and mention arrays but no `ownerUserId` moves from `cant_tell_owner_unknown` (shown) to `uninvolved` (hidden): more hidden than before. Not live today (all recent `fromOwner` null). The extra hiding is of genuinely uninvolved chats. | repro A5 |
| D-6 | LOW | `action-classify.ts` `settledGuard` | Only `reason` is scrubbed; a `todo` claiming "You have not replied..." is shown, and "you still need to resubmit" has no deterministic guard (prompt only). | repro B5b, B5c |
| D-7 | LOW-MEDIUM | `meeting-triage.ts` `DETAIL_LABEL` | A genuine bulleted item written `Label: action` ("- Note: Von to send pricing to the client", "- **Deadline**: submit the grant application by Dec 1") becomes a detail; `details` is consumed nowhere, so the action is lost. | repro E |

## Verdict

CONFIRMED: C0, C1 (live shape), C2, C3, C4, C5 (with D-7), C7 by read, C8 (5/5 FIRED), C9.
REFUTED: C1b (stale verdicts persist, D-1), C6 F2/F4 (D-2).
UI-UNVERIFIED: expand/collapse, auto-grow textarea, AI-misread chip as rendered.

**FIX FIRST** -- D-1 means the owner's reported rows would not change on deploy, and D-2 breaks a stated criterion.
After those: MERGE-PENDING-UAT (UI claims owe a verify-uat run).
