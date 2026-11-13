<!--
WHAT:          Independent verification (loop 3) of branch claude_task-proposals @ 8a336404 against
               docs/ac/AC-correspondence-checklist.md, the red-team findings F1-F19/S1-S5, the flag
               contract, the live work-email path (htmlToText / newTextOnly) and the real Teams/Sent/emails shapes.
WHY:           Tier 1 (model output stored as proposals). Loops 1-2 never reached a verdict.
SUPERSEDES:    nothing (loops 1-2 left only a header: origin/claude_verify-correspondence-1 4edb6fd8)
SUPERSEDED-BY: nothing -- current
EVIDENCE:      this file; probe scripts under scripts/verify3-*.ts on this branch
-->

# VERIFY correspondence-proposals, loop 3

Started 2026-11-13 12:16 UTC. Budget 90 min. Isolated worktree; no live system touched.

## Claim 0: suite re-run (head 8a336404)

| suite | result |
|---|---|
| task-proposals | 174 passed, 0 failed |
| redteam-correspondence | 52 passed, 0 failed |
| correspondence-ingest | 149 passed, 0 failed |
| onedrive-feed | all passed |
| inbound-email | 72 passed, 0 failed |
| cross-app-turn-gate | 92 passed, 0 failed |
| fireflies-minutes | 3 FAILED (implementer says pre-existing on main; re-checked below) |

Head moved mid-run to 870c74c3 (3f6bb5fb Teams empty-skip + capture coverage). Merged into this branch; all probes
below ran at 870c74c3. Probe script: `scripts/verify3-probes.ts` (`bun scripts/verify3-probes.ts`). Main-branch
comparisons ran the origin/main copies of `onedrive-feed.ts` / `inbound-email.ts` on the same inputs.

## Claim (c): everything OFF without teams/sent/correspondence keys -- CONFIRMED, one minor

- Live-shape config (no new keys) -> `runIngestPass` returns `{ran:false, reason:"ingest_off"}` with **0 calls** on a
  throwing spy. `activeProcessors` -> 0.
- `teams` / `sent` = absent, false, "true", 0, null, [], [{}], "on", 1 -> `enabled:false` (all 9). `{}` and `true` -> on.
- `correspondence` = any of those, or `{}` -> ingest/bell/proposals all false; each flag is on ONLY for literal `true`.
- MINOR M1: `"teams": {"enabled":"false"}` and `{"enabled":0}` -> **enabled:true** (same for `sent`). Cause:
  `onedrive-feed.ts:139` `o.enabled !== false` (the shared `file()` rule, AC-1.1 asks for the same rule). An object
  the owner wrote to switch it OFF turns it ON. Low likelihood; reachable by a hand-edited app setting.

## Claim (d): live work-email path -- REFUTED (visible text lost; new vs main)

Every row below: branch output vs origin/main output for the SAME HTML. `htmlToText` feeds `mapFeedMessage.bodyText`
(`onedrive-feed.ts:564`), i.e. the live Iris work-email screen, with no flag.

| id | input (abridged) | branch | main | cause |
|---|---|---|---|---|
| V1 | `<p><span style="display:none">pre</p><p>Please approve the budget by Friday.</p><p>Thanks</span></p>` (stray close, Outlook-style) | `""` | ask kept | `elementEnd` same-name scan `onedrive-feed.ts:418-424` matches the stray `</span>`; a browser closes the span at `</p>` |
| V19 | `<table><tr><td><p style="display:none">pre<td>Can you sign today?</td></tr></table>` | `""` | ask kept | unclosed `<p>` fallback `:425-432` ends at `</tr>`, swallowing the next cell (a `<td>` start closes the p in a browser) |
| V2 | `<a title="a hidden gem">Read the proposal</a> and tell me if you agree?` | `"and tell me if you agree?"` | full | `hiddenKind` `:403` regex `\shidden(\s|=|\/?>)` matches the word inside ANY attribute value |
| V5 | `<td style="font-size:0"><font size="3">Could you sign the NDA today?</font></td>` | `""` | kept | `SIZED_STYLE` `:396` only reads inline CSS; legacy `<font size>` re-sizing ignored |
| V6 | font-size:0 wrapper, child sized by a `<style>` class | `""` | kept | same; class-based sizing invisible to the converter |
| V7 | `<div style="max-height:0">Can you send the deck?</div>` (no overflow:hidden; text renders) | `""` | kept | `HIDDEN_STYLE` `:393` treats max-height:0 alone as hidden |
| V13 | `visibility:hidden` parent with `visibility:visible` child | `""` | kept | CSS lets the child show; converter drops it (rare) |

Held: MJML column (V4), mso conditionals (V8/V9), unclosed td/tr (V10), preheader (V17), `<div .../>` (V18), opacity
0.5 (V14), entities (V16). V12 (unclosed blockquote drops everything after) is MAIN behaviour, not new.

Hidden text still KEPT (F8 is partially closed): white-on-white `color:#fff;font-size:1px` (H1), `font-size:1px`
(H2), `position:absolute;left:-9999px` (H3), `width:0;height:0;overflow:hidden` (H4), `height:0;overflow:hidden`
(H16), head `<style>` class `display:none` (H5), font-size:0 wrapper child at `1em` (H6), `text-indent:-9999px`
(H11), `transform:scale(0)` (H12). Each yields "Can you buy gift cards?" as source text. Held: display:none any
spelling (H7, H13), `hidden` attr (H8), nested (H9), unclosed at end (H10), comments (H14), max-height+overflow (H15).

`newTextOnly` (F9) cuts REAL ENGLISH content that main kept (live main-mailbox screen, `inbound-email.ts:79,91,93`):

| id | input | branch | main |
|---|---|---|---|
| N1 | `Quick update.` / `On Friday the auditor wrote back with these questions:` / `1. Can you send the ledger by Monday?` | `"Quick update."` | full |
| N3 | `On Friday after the board meeting,` / `the vendor wrote back with three questions:` / `Can you approve the change order?` | `""` | full |
| N2 | `Am I right about what legal wrote:` / `Can you check clause 3 before we sign?` | `""` | full |
| N7 | `Den lighting: the electrician wrote:` / `Can you pick a fixture by Thursday?` | `""` | full |
| N8 | `El Paso office update - Maria wrote the following:` / `Can you approve the lease?` | `""` | full |
| N4 | `Request details` / `From: Marketing` / `Data: Q3 revenue by region` / `Can you pull this by Friday?` | `"Request details"` | full |

Cause: `ATTRIBUTION` (`:79`) accepts `wrote` followed by up to 80 non-colon chars before the colon (N1, N8), and
the English-colliding words Am/El/Den/On as openers; the two-line join (`:93`) turns any line starting "On " plus a
next line ending "wrote ...:" into an attribution (N3); `HDR_SENT` includes `Data` (N4). Consequence: the ask is
removed before `asksSomething` (`inbound-email.ts:116`, used for BOTH the EDS main mailbox and the work feed) -> unless
the subject itself asks, the email is screened as "no ask": not announced, no owed row. Also feeds proposals
(`proposals.ts:82,92`), so the to-do is never proposed either.

## Claim (e): real production file shapes -- CONFIRMED for parsing/paths/contracts; two defects in 3f6bb5fb

- Default Teams path `/automation/Teams Chats/teams-chats.jsonl` (space) -> `enabled:true` via `teams:true` and via
  an explicit object; `drivePath` encodes per segment -> `/automation/Teams%20Chats/teams-chats.jsonl`
  (`onedrive-feed.server.ts:91-95`). CONFIRMED (path rule + encoding; no live Graph call made).
- Today's real line (source "teams", status "Pending", capturedAt, NO synthetic key) -> 0 kept,
  `synthetic_mismatch:1` (deliberate). CONFIRMED.
- Full Graph message shape with `synthetic:false`: user sender kept (`fromOwner` matched case-insensitively against
  an upper-case configured id), `systemEventMessage` -> `not_a_message`, `deletedDateTime` -> `deleted`,
  `lastEditedDateTime` kept, `{application:{...}, user:null}` -> `isApp:true`, `{application:null, device:null,
  user:{...}}` -> user. Thread decision "answered". CONFIRMED.
- `sent.json` per `docs/integrations/power-automate-huddle-sources.md` (envelope `feed_type:"sent_snapshot"`,
  `snapshot.value`) -> validates; `sentDateTime` and fallback `receivedDateTime` both mapped; record without
  `conversationId` skipped. A top-level `value` (no `snapshot` wrapper) -> `bad_records` (the doc says
  `snapshot.value`, so consistent). CONFIRMED.
- Real `emails.json` record shape (`from` string, `body` string + `isHtml`) -> `mapFeedMessage` id
  `feed:<mailbox>:<id>`, `conversationId` carried, body converted; `sentReplySettles` true for a LATER sent in the
  same conversation, false for an earlier one, works with `received_at` as a Date. CONFIRMED.

### 3f6bb5fb `empty` skip -- REFUTED: it drops real owner replies

`teams-log.ts:204` skips a message whose text is empty after `htmlToText` and whose `attachments` is empty.

| owner message body (Graph html) | kept? | thread decision for "Pat: Can you send the Q3 deck?" then owner reply |
|---|---|---|
| inline image only (`<img src=".../hostedContents/.../$value">`, attachments `[]`, which is how Graph returns pasted images) | NO (`empty`) | **open** (bell OWED) |
| Teams emoji only (`<emoji id="1f44d_thumbsup" alt="..."></emoji>`) | NO (`empty`) | **open** |
| Giphy (`<img itemtype=".../Giphy">`) | NO | -- |
| literal emoji character `<p>(thumbs up)</p>` | yes | answered |
| mention only `<at id="0">Pat</at>` | yes (text "Pat Example") | -- |
| adaptive card / file (`<attachment>` + attachments[]) | yes | -- |

Before 3f6bb5fb such a message was kept and, being the owner's, settled the chat. Repro:
`bun scripts/verify3-probes.ts | grep E-empty-consequence` -> `{"kept":["10","11"],"decision":"open"}` for both.
Cause: `htmlToText` drops `<img>` and `<emoji>` with their `alt`, then `:204` treats that as empty.

### 3f6bb5fb capture-coverage DROP flag -- PARTIAL (note only; misfires and blind spots)

- Normal 12 vs 12 -> no flag; a rerun on the same UTC day unions -> no flag. OK.
- **Misfire:** a rerun after 19:00 EST (00:30Z) lands on the NEXT UTC day: 12 chats on 11-12, 3 on 11-13 -> `drop:true`,
  note reads "COVERAGE DROP: 3 chat(s) vs 12". Days are UTC dates (`teams-log.ts:151`), the flow runs 18:00 ET.
- **Misfire (conditional):** if the flow writes only chats with activity, a quiet day (12 -> 2) flags; the doc says
  "messages for the day", so that is the likely shape.
- **Blind spot:** lines without `capturedAt`/`capturedUtc` go to "unknown" and are ignored, so a flow regression that
  stops writing `capturedAt` hides any drop (`latest` stays the last dated day, `previous:null`).
- A dated capture with an offset (`19:30-05:00`) is filed under the UTC day (11-13). Consistent, but see misfire.
- It changes no behaviour (status note text only), so severity is note/minor.

## SQL suites (local PostgreSQL 16) and fireflies

- `task-proposals-sql` 45 passed / 0 failed; `correspondence-ledger-sql` 50/0; `fireflies-queue-sql` all passed.
- `fireflies-minutes` 3 FAILED (G3, G5, G8). The branch's only diff under `lib/fireflies/` is adding `export` to
  `fetchTranscript`; the test file is unchanged. Inference (high confidence, not re-run on main): pre-existing.

## Claim (b): red-team findings on the proposal validator, new spellings (`scripts/verify3-proposals-probes.ts`)

| finding | status | new-spelling evidence |
|---|---|---|
| F3 impossible dates | CLOSED | `2026-02-30`, `2026-13-45`, `Feb 30`, `31 April`, `2027-02-29`, `30th of February`, `11/31`, `13/1` -> null, no throw |
| F4 invented detail rides on a shared verb | **OPEN (numbers only fixed)** | evidence "pay the vendor invoice this week" grounds title "Pay the vendor invoice **twice**" and "Pay **all** vendor invoices **from the reserve fund**" -> ACCEPTED. Amounts/account numbers are refused (`task_number_not_grounded`). |
| F5 pleasantry grounds an invented task | **OPEN (only the 8-char spelling fixed)** | source "We loved the deck you sent last week, thanks!", evidence "loved the deck you sent last week", title "Redo the deck you sent" -> ACCEPTED; "Thanks for sending the budget review yesterday" -> "Send the budget review" ACCEPTED |
| F7 negation | **OPEN** | ACCEPTED: "Under no circumstances should you send the contract...", "Never, ever send the contract..." (comma splits the clause), "Please don't, under any circumstances, send the contract...", "Avoid sending...", "Refrain from sending...", "There is no reason to send...". Control "Please do NOT send..." refused. Cause `proposals.ts` `negatesAction` (last clause after `,;:` only, fixed word list). |
| F10 due_text date words only | CLOSED for the date, MINOR display | `due_text:"may"` (modal verb) and `"3"` (a quantity) are KEPT as `dueText` (due date stays null) -- `isDateWords` accepts them; whether `dueText` is shown in the row decides impact |
| F11 month prefixes / negated date | CLOSED | "march the proposal" with due "by Friday" -> Friday; no March |
| F12 assignee | CLOSED on probes | "Dana said to send..." -> null; "send the deck to Dana" -> null |
| F13 look-alikes | CLOSED | ZWSP, fullwidth, Cyrillic e, soft hyphen, word joiner, RLO -> same `titleKey` |

Mitigation worth stating: every accepted row shows the WHOLE enclosing sentence as evidence, and nothing reaches the
board without the owner's Approve. So F4/F5/F7 put a wrong to-do in front of the owner with the contradicting
sentence beside it; they do not create a board task on their own.
