<!--
WHAT:          Independent verification (loop 4) of claude_task-proposals @ 2cf5fa8d: re-check of loop-3 confirmed
               items, full re-derivation of loop-3 defects D1-D6/M1/M2, and full-depth check of the new
               file-staleness alert (correspondence.staleAlerts) and scripts/proposals-preview.ts.
WHY:           Tier 1 (model output stored as proposals; live bell + live email screens touched).
SUPERSEDES:    docs/qc-evidence/VERIFY-correspondence-proposals-3.md (origin/claude_verify-correspondence-3)
SUPERSEDED-BY: nothing -- current
EVIDENCE:      this file; probe scripts scripts/verify3-*.ts (loop 3) and scripts/verify4-*.ts (this loop)
-->

# VERIFY correspondence-proposals, loop 4

Started 2026-11-13 14:28 UTC. Budget 90 min. Isolated worktree; no live system touched; synthetic `.example` data.

## Claim 0: full suite re-run at 2cf5fa8d

| suite | result |
|---|---|
| task-proposals | 198 passed, 0 failed |
| redteam-correspondence | 70 passed, 0 failed |
| correspondence-ingest | 149 passed, 0 failed |
| onedrive-feed | all passed |
| inbound-email | 72 passed, 0 failed |
| cross-app-turn-gate | 92 passed, 0 failed |
| feed-staleness | 66 passed, 0 failed |
| attention | all passed |
| `npx tsc --noEmit -p .` | exit 0, no output |

Matches the implementer's numbers exactly.

## Claim 1: loop-3 repro inputs re-run at head (scripts/verify3-*.ts, unchanged)

| loop-3 item | loop-3 result | head result |
|---|---|---|
| M1 `teams`/`sent` `{"enabled":"false"}`, `{"enabled":0}` | enabled:true | **enabled:false** (both keys); `{}`/`true` still on; `"on"`, `1`, `"true"` off |
| D1 V1 stray `</span>` | `""` | "Please approve the budget by Friday.\n Thanks" |
| D1 V2 `title="a hidden gem"` | ask cut | full text |
| D1 V5 `<font size>`, V6 class, V7 max-height alone, V13 visibility:visible child, V19 unclosed `<p>` in td | `""` | ask kept in all five |
| D1 negatives H7-H10, H13-H15 | hidden | still hidden |
| D1 H1-H6, H11, H12, H16 | kept (hidden text leaks) | still kept -- unchanged, documented as out of scope |
| D2 N1, N2, N3, N4, N7, N8, N9 | cut | **all kept in full**; controls N5 (Outlook header) and N6 (Gmail attribution) still cut |
| D3 image-only / emoji-only / Giphy owner reply | skipped, chat stays OWED | kept; decision **answered** |
| D3 whitespace-only code block | -- | still `empty` (skipped) |
| D4 19:30-EST rerun | false DROP on next UTC day | unioned into 2026-11-12, `drop:false` |
| F4 a-d (invented detail) | c, d ACCEPTED | all four rejected |
| F5a "Redo the deck you sent" | ACCEPTED | rejected `task_not_grounded` |
| F5b "Send the budget review" from "Thanks for sending..." | ACCEPTED | still ACCEPTED (implementer documents as not addressed) |
| F7 a-e, h | ACCEPTED | all `evidence_negated` |
| F7f negation on the previous line | ACCEPTED | still ACCEPTED (documented: newline is a boundary by design) |
| M2 F10 `"3"`, F11a `"may"` as dueText | kept | dueText null |
| F3, F11b/c, F12, F13 | closed | still closed |
| sanitize S0-S5 vs main | S3 differs (correct) | identical result |

## Claim 2: D6 present AND tested at head

`proposals.ts:251` `return tw.every((w) => ev.has(w)) ? ...` is in the tree. `mutate.sh` with that line reverted to
the strict-majority rule (`tw.filter(...).length * 2 > tw.length`): **FIRED (control EQUIVALENT), exit 0** on
`D6 a title that adds`. CONFIRMED present and guarded.

## Claim 3: NEW spellings beyond loop 3 (`scripts/verify4-probes.ts`, `scripts/verify4-browser-truth.mjs`)

Every D1/D2 row ran on this branch AND on origin/main's copy of the same file. D1 ground truth is a real Chromium
(`/opt/pw-browsers/chromium-1243`, `page.setContent`, `document.body.innerText`), not a reading of the spec.

### D1 (live work-email screen, no flag) -- REFUTED on three new shapes

| id | HTML | Chromium shows | branch | main |
|---|---|---|---|---|
| W1 | `<p><span style="display:none">preheader text<p>Please approve the budget by Friday?</p>` | "Please approve the budget by Friday?" | **`""`** | kept |
| W2 | `<p><span style="display:none">pre<ul><li>Can you sign the NDA today?</li></ul>` | "Can you sign the NDA today?" | **`""`** | kept |
| W3 | `<ul><li><span style="display:none">x<li>Can you call the vendor?</li></ul>` | "Can you call the vendor?" | **`""`** | kept |
| W4 | `<!--[if mso]><p>Can you sign the NDA?</p><![endif]--><div style="mso-hide:all">Can you sign the NDA?</div>` | "Can you sign the NDA?" | **`""`** | kept (twice) |
| W7 | `<div title=' style="display:none"'>Can you approve the PO?</div>` | "Can you approve the PO?" | **`""`** | kept |
| W1b | as W1 but `<b style="display:none">` (a formatting element, which the parser re-opens) | `""` | `""` | kept |

Causes:
- W1-W3: `startTagEnds` (`onedrive-feed.ts:459`) knows only the hidden element's OWN implied ends. When a hidden
  inline element sits unclosed inside a `<p>` / `<li>`, the browser's "close a p element" / next `<li>` pops it with
  its parent; `elementEnd` (`:485`) does not see the parent, walks to the end of the document, and drops everything.
  This is the V1 class reached through an implied (not explicit) parent close.
- W4: `HIDDEN_STYLE` (`:406`) treats `mso-hide:all` as hidden everywhere, and `:596` removes every `<!-- -->`
  comment including the `[if mso]` copy. `mso-hide:all` hides only in Outlook desktop; the mso copy shows only in
  Outlook desktop. Each reader sees the text once; the converter keeps neither. (Common in bulletproof-button
  markup; rarer in person-to-person mail.)
- W7: `styleOf` (`:418`) finds ` style="..."` inside another attribute's quoted value. Exotic.

Held (correctly hidden or kept): aria-hidden / data-hidden kept (W5, W6); void tags inside a hidden div (W8);
Outlook `<o:p>` (W9); hidden `<h2>` ended by `<h3>` (W10); stray `</div>` (W11); `opacity:0` sibling (W12); upper-case
`HIDDEN` attr (W13), `display :none` (W14), font-size:0 + `<b>` (W16) hidden; unclosed hidden `<td>` then `<tr>`
(W17); table inside hidden div (W18). `display:/*x*/none` (W15) is kept (leak direction, as H1-H16).

### D2 (`newTextOnly`, live main-mailbox + work-feed screen) -- REFUTED on the two-line join

| id | body | branch | main | asks? branch / main |
|---|---|---|---|---|
| X1 | `Status below.` / `On Nov 12 the auditor sent these questions and Pat` / `also wrote:` / `Can you send the ledger by Monday?` | `"Status below."` | full | **false** / true |
| X2 | `On 3 occasions the client` / `complained, and today she wrote:` / `Can you call her back?` | `""` | full | **false** / true |

Cause: `inbound-email.ts:123`. The digit guard admits any hard-wrapped English line that starts "On" and carries a
digit when the next line ends "wrote:"; joined, it matches main's own English rule `^\s*On .+wrote:\s*$` (`:97`).
Consequence: same as loop-3 N3 -- the email is screened as "no ask" (not announced, no owed row, no proposal).
Narrower than N3 (needs a digit), but still English content main kept. Plain-text mail is hard-wrapped at ~72
chars, which is what produces this shape.

Held: X3 (German opener + English verb) identical to main; X4/X5 identical to main. X6-X9 (`De :`/`Da:`/`De:` +
`Date`/`Data`) are the deliberate F9 non-English cuts; X9 (Spanish `De:` + English `Date:`) is cut through the
French pair -- a real mixed-locale header, so acceptable.

### D3 (Teams empty skip) -- PARTIAL residue

Kept: sticker `<img>`, upper-case `<IMG>`, a text-type body holding only an emoji. Still skipped as `empty`:
`<customemoji ...></customemoji>` and `<video>`. `hasNonTextContent` (`teams-log.ts:111`) matches `<(?:img|emoji)\b`,
so `<customemoji` misses. Whether Graph writes custom emoji as `<customemoji>` is my recollection of the Graph
chatMessage docs, NOT checked against a live payload (inference, medium confidence). Before 3f6bb5fb such a message
was kept and settled the chat.

### D4 (Eastern capture day) -- CONFIRMED

DST end (03:00Z Nov 1 = Oct 31 23:00 EDT; 23:00Z Nov 1 = 18:00 EST) -> `2026-10-31` and `2026-11-01`; DST start
06:30Z/07:30Z on 2026-03-08 -> one day. 12 timed + 3 untimed lines -> note "3 line(s) with no capture time". An
epoch-number `capturedAt` is "unknown" (the flow writes ISO; counted in the note).

### D5 (negation) -- PARTIAL

Refused: "Do not, repeat, do not send", "asked us not to send", "hold off on sending", curly `don’t`, "Stop
sending", "shouldn't", "No need to", "cannot". Affirmative controls accepted ("To avoid delays, send", "Don't forget
to send", "If it is not signed, send"). **Accepted (new spelling): "Nobody should send the contract to the client
today."** -> proposal "Send the contract to the client". `proposals.ts:326` `NEGATION` has no "nobody"/"no one".

### D6 (title grounding) -- PARTIAL

Refused: added adverb, swapped object, added name. **Accepted: title "Do not send the deck to finance" from evidence
"send the deck to finance"** -- "do"/"not" are stopwords (`proposals.ts:204` `STOP`), so a title that INVERTS the
evidence is fully grounded. Low likelihood (the model is told to use the text's own words) but it is the exact
class D6 exists for: an added word that changes the meaning.

### M1 / M2 -- CONFIRMED

M1: re-checked above (claim 1). M2: "Friday-ish", "the 14th", "mon", "next time", "may 3" -> dueText null;
"Nov 14" -> 2026-11-14; "this week" -> dueText kept, date null.

## Claim 4: file-staleness alert (`correspondence.staleAlerts`) -- full depth

Probes: `scripts/verify4-staleness-probes.ts` (pure) and `scripts/verify4-staleness-sql.ts` (the REAL
`raiseFeedAttention` / `clearFeedAttention` / `listOpenAttention` / `settleAttentionForHuddle` SQL on a throwaway
local PostgreSQL 16, driven through the real `applyFeedStaleness`).

### 4a Working-hours math -- CONFIRMED

| case | result |
|---|---|
| Fri 17:00 EDT -> Mon 09:00 EST (across DST end) | 2 h |
| Fri 17:00 EST -> Mon 09:00 EDT (across DST start) | 2 h |
| Sat noon -> Sun noon / Tue 18:00 -> Wed 08:00 / reversed | 0 / 0 / 0 |
| Mon 07:00 -> Mon 19:00; Mon 00:00 -> next Mon 00:00 | 10; 50 |
| the real incident: Wed 11/11 09:02 ET -> Fri 11/13 10:00 ET | 20.97 h -> "hasn't updated since Wed 9:02 AM (2 working days)" |
| exactly 6.00 h | fresh (rule is strictly MORE than N) |
| Fri 15:00 -> Mon 10:00 (5 h) / Mon 11:01 (6h01) | fresh / stale |
| lastModified in the future / NaN | fresh / unreadable |
| 2-year gap | bounded walk (400 days) -> 2850 h, still stale; label under-counts (cosmetic) |

Teams 18:00 + 60 min, weekdays only: Mon 18:59 with Fri 18:05 file -> fresh; Mon 19:00 -> stale; Mon 18:30 file at
19:00 -> fresh; Sat 10:00 with Fri 18:05 -> fresh, with Fri 17:00 -> stale (Friday missed); Mon 10:00 with Fri
18:05 -> fresh (weekend not due); DST-end Monday 19:00 EST: 18:10 file fresh, 17:30 file stale; DST-start due
instant 2026-03-09 18:00 EDT = 22:00Z. A flow that writes at 17:58 is stale every evening (by the rule as approved).
Not modelled (owner-acceptable, noted): US holidays count as working days.

### 4b One row per file, auto-clear, Iris -- CONFIRMED

Row id `attn-feed-<file>-<hash(owner lower-cased, trimmed)>`; same id for `Owner@EDS.example ` and
`owner@eds.example`. Same episode across checks writes once (`raised` 1,0,0 over three checks; the text refreshes
only when the label changes). A fresh file settles the row `replied`. Talking to Iris (`settleAttentionForHuddle`
on `dm-iris-chase`) settles 0 rows and the feed row stays `owed`. The implementer's SQL suite (S1-S13) also green.

### 4c Dismiss semantics -- REFUTED (transient read failure)

| step (real SQL) | row status | episode |
|---|---|---|
| stale raise | owed | `stale:2026-11-11T14:02:00.000Z` |
| owner Dismiss | dismissed | same |
| ONE check where the metadata GET fails (timeout / 5xx / 429 => `unreadable`) | **owed** | `unreadable` |
| next check, same stale file | **owed** | `stale:2026-11-11T14:02:00.000Z` |

So one transient Graph failure un-dismisses an alert the owner dismissed, and it stays open as the same stale
alert. Cause: `feed-staleness.ts` `decideFeedStaleness` maps every non-404 failure (incl. timeout,
`onedrive-feed.server.ts` `readFeedFileMeta` catch) to `unreadable`, a different episode; `raiseFeedAttention`
(`email-replies.server.ts:459-462`) reopens a dismissed row on any different episode and refreshes an open row to
the next one.

Related, same cause: on a FRESH file, one transient failure raises "Work email file can't be read from OneDrive"
(counted in the badge) until the next check (>= 10 min) clears it (V2a/V2b). The approved rule is about a file
that "hasn't changed in N working hours"; a single failed read is not that. Severity: minor-to-moderate (bell
badge flicker, no phone push -- no push path reads `chat.email_replies`).

### 4d Ordering -- MINOR

`listOpenAttention` (`email-replies.server.ts:342`) orders by `coalesce(received_at, created_at) DESC LIMIT 50`,
and a stale row's `received_at` is the file's OLD lastModified. With 50 open items newer than that, the feed row
is not returned at all (V3: `{"n":50,"feedListed":false}`). Unlikely for one owner, but it is the alert that
says the inputs stopped.

### 4e Flag OFF = zero effect -- CONFIRMED (one wording correction)

- `staleAlerts`: only literal `true` enables (`"true"`, 1, "yes", null, `{}` -> off). `staleHours`: 0/-3/"abc"/null
  -> 6, "8" -> 8, 8.9 -> 8, 500 -> 200.
- `runFeedStalenessCheck(cfgOff, spy)` -> null with **0** calls to readMeta/store/now/log; null cfg likewise.
- `ingest.server.ts` returns the untouched ingest promise before even importing the module when the flag is off.
- Files checked: only configured ones (default config -> `["email"]`; teams/sent opt-in).
- "existing drive metadata request byte-identical": `fetchDriveFile` selects `id,eTag,size` and is pinned by H8. That
  is identical to the PRE-staleness branch. Versus **origin/main** it is NOT byte-identical: main sends
  `?$select=eTag,size` (the `id,` came with the 2026-11-12 Teams commit) and now forces `method:"GET"`. Both are
  harmless for Graph; stated so the claim is not over-read.
- Logs: one line, file names + states + counts (`[feed-staleness] email=stale sent=unreadable teams=stale raised=3
  cleared=0`); the failure path logs only `e.name`. CONFIRMED.

### 4f Bell UI for existing users (radius challenge)

- `feed` is a SYSTEM kind, not in `ATTENTION_KINDS`: the "What counts" list is unchanged by this feature; feed rows
  are always listed and counted when present. With the flag off none exist.
- Independent of the earlier `chat` change (loop-3 item, still true at head): every existing user sees a new
  "Teams chats" checkbox; `DEFAULT_URGENT_KINDS` gains `chat`; `resolveStoredUrgentKinds` adds `chat` to a stored
  list that predates it; the next Settings save stores `-chat` when left off. No chat rows exist while ingest is off,
  so the visible change is the checkbox only.
- A feed row's click opens Iris's chat (`dm-iris-chase`); talking there does not clear it (4b). Badge uses
  `badgeCount` (excludes only uncertain chat rows).
- UI rendering itself NOT TESTABLE OFFLINE (needs the deployed SPA).

## Claim 5: `scripts/proposals-preview.ts` -- CONFIRMED confined, two notes

- `PREVIEW_ACCEPT_UNMARKED` appears only in this script (grep over `src/` and `scripts/`: no other hit). Both
  leniencies rewrite the script's OWN copy (`{...JSON.parse(e.text), complete:true}`; adds `synthetic:false` to a
  local string) and then call the unchanged live validators/parsers. The live `readFeed` still calls
  `validateEmailSnapshot` on the raw JSON and `parseTeamsLog` still skips unmarked lines (E-real-line-no-synthetic:
  `synthetic_mismatch:1`).
- It is run only by `proposals-preview.yml` on origin/main, `workflow_dispatch` only, with a `ref` input. Not on
  this branch; nothing runs it on merge.
- Printed: HTTP statuses, counts, reason names, the timestamped OneDrive path, model name. CONFIRMED counts-only on
  the normal path.
- Note 1: an uncaught `JSON.parse` on a non-JSON file prints V8's message, which quotes the first ~10 characters of
  the content (`Unexpected token 'S', "Secret mer"... is not valid JSON`, measured with node). Only when a feed
  file is not JSON at all.
- Note 2: the header says "sends nothing", but `PREVIEW_EMAIL=1` calls Graph `sendMail` to the owner and the script
  always PUTs a Markdown file to `/automation/Huddle Preview/`. Both are owner-requested; the header is stale.

## Claim 6: SQL suites, fireflies, independent mutations

- Local PostgreSQL 16: `feed-staleness-sql` 13/0, `task-proposals-sql` 45/0, `correspondence-ledger-sql` 50/0,
  `fireflies-queue-sql` all passed.
- `fireflies-minutes`: 64 PASS, 3 FAIL (G3, G5, G8) on this branch. **Ground-truthed this loop:** the same suite
  on a detached origin/main worktree (d55f2f72) gives the identical 64 PASS / G3, G5, G8 FAIL. Pre-existing, not this
  branch (loop 3 had only inferred it). The branch's only fireflies change is `export` on `fetchTranscript`.
- My own `mutate.sh` runs (beyond the implementer's 15): Teams grace removed (`due <= nowMs`) -> **FIRED (control
  EQUIVALENT)** on C3; weekday skip removed from `workingMsBetween` -> **FIRED (control EQUIVALENT)** on A1.
- Branch state: origin/main is 19 commits ahead of `claude_task-proposals` (ledger and preview-workflow commits);
  this report covers 2cf5fa8d only.

## What changes in the LIVE app on merge with every flag OFF

| # | change | evidence |
|---|---|---|
| 1 | Work-email HTML -> text (`htmlToText`): hidden text removed (wanted), more entities decoded (wanted); **visible text dropped** in W1/W2/W3/W4/W7 shapes | claim 3, Chromium-checked |
| 2 | `newTextOnly` (EDS main mailbox AND work feed): non-English quote headers cut (intended F9); **English content cut** in the X1/X2 two-line shape -> email screened "no ask" | claim 3 |
| 3 | Bell settings: new "Teams chats" checkbox for everyone; `chat` in defaults; stored lists gain `chat`; next save writes `-chat` when left off | claim 4f |
| 4 | Bell list items render `link` ("Open in Teams") and badge uses `badgeCount` -- no visible effect without chat rows | code read |
| 5 | `settleAttentionForHuddle` excludes `chat`/`feed` -- no effect without such rows | code read |
| 6 | `chat.email_replies` gains nullable `needs_context`, `source_link` columns at the next bootstrap (live DDL, additive) | code read `email-replies.server.ts:58-59` |
| 7 | Drive metadata request `?$select=eTag,size` -> `?$select=id,eTag,size`, `method:"GET"` forced | claim 4e |
| 8 | Heartbeat dynamically imports the ingest and proposals modules every tick; both return before any Graph/DB work | loop 3 6.1 + claim 4e |
| 9 | `build_checklist` tool schema gains `proposals` (returns `not_enabled` when off); turn payload optional `checklist` | loop 3, code present at head (`tools.ts:99`, `huddle.functions.ts:7468`) |
| 10 | Work-email (feed) owed rows: settle from sent.json only when `sent` is configured (opt-in) -> unchanged with it off | code read `loadFeedSent` |

## Per-AC verdicts (head 2cf5fa8d)

Basis: S = suite re-run green this loop; P = my probe this loop; R = code read; L3 = loop-3 basis re-checked by suite.

| AC | verdict | basis |
|---|---|---|
| 1.1 | CONFIRMED (M1 fixed) | S + P |
| 1.2 | CONFIRMED offline; DB row NOT TESTABLE OFFLINE | S + R |
| 1.3-1.13 | CONFIRMED (1.8 tail-read design, 1.13 GET forced) | S + L3 |
| 2.1-2.6 | CONFIRMED offline | S |
| 2.7 | CONFIRMED on main's inbound-email suite (72/0); see 6.4 for the X1/X2 regression | S + P |
| 3.1-3.10 | CONFIRMED offline (SQL 50/0) | S |
| 4.1-4.13 | CONFIRMED offline; UI parts NOT TESTABLE OFFLINE | S |
| 4.5 / 4.13 (owner replies) | CONFIRMED for image/emoji/Giphy/sticker; PARTIAL: `<customemoji>`-only reply still skipped (Graph shape is my inference) | P |
| 4.7 | PARTIAL: superseded by owner option A | R |
| 5.1, 5.2 | CONFIRMED | S + P (sanitize identical) |
| 5.3-5.5, 5.7-5.13, 5.15-5.17, 5.21-5.23 | CONFIRMED offline (SQL 45/0); UI/DB parts NOT TESTABLE OFFLINE | S |
| 5.6, 5.24 | NOT TESTABLE OFFLINE (UI) | -- |
| 5.14 | CONFIRMED | L3 |
| 5.18 | CONFIRMED | S |
| 5.19 | PARTIAL: D5 "Nobody should send ..." accepted; D6 "Do not send the deck" accepted from "send the deck"; F5b and F7f still accepted (documented) | P |
| 5.20 | CONFIRMED (M2 fixed) | P |
| 6.1, 6.3 | CONFIRMED (0 calls, flag matrix incl. staleAlerts) | S + P |
| 6.2 | NOT BUILT | R |
| 6.4 | **REFUTED**: with every flag OFF the work-email screen drops visible text (W1-W4, W7) and the main-mailbox screen cuts English content (X1, X2) that main keeps | P (vs main, Chromium) |
| 6.5 | CONFIRMED: fireflies-minutes failures are identical on origin/main | S (both trees) |
| 6.6 | NOT BUILT | R |
| 6.7 | CONFIRMED (92/0) | S |
| 6.8 | NOT TESTABLE OFFLINE | -- |
| 7.1, 7.2 | CONFIRMED | S |
| 7.3 | CONFIRMED by code read (dry-run extended, counts/yes-no only); not run against the real file | R |
| 7.4 | NOT TESTABLE OFFLINE | -- |
| 8.1, 8.2 | CONFIRMED | S |
| 8.3 | PARTIAL: staleness log and preview print counts; a non-JSON feed file makes the preview's uncaught `JSON.parse` print ~10 content chars | P + R |
| STALE (owner-approved alert): working-hours math, Teams rule, one row per file, auto-clear, Iris does not clear, flag OFF zero effect, counts-only logs | CONFIRMED | P + real SQL |
| STALE dismiss semantics | **REFUTED**: one transient read failure un-dismisses a dismissed alert; on a fresh file it raises a "can't be read" item | real SQL V1/V2 |
| STALE ordering | MINOR: hidden by LIMIT 50 behind 50 newer open items | real SQL V3 |
| proposals-preview leniencies | CONFIRMED confined to the script | R + grep |

## Verdict: FIX FIRST

Blocking for merge (live, flags OFF -- AC-6.4):
1. `onedrive-feed.ts:459/485` W1-W3: unclosed hidden inline element inside `<p>`/`<li>` drops the visible ask.
2. `onedrive-feed.ts:406` + `:596` W4: `mso-hide:all` copy and the `[if mso]` copy both removed.
3. `inbound-email.ts:123` X1/X2: two-line join cuts hard-wrapped English lines starting "On <digit>...".
(W7 is exotic; fix optional.)

Before switching `staleAlerts` on (not merge-blocking: flag off = no rows):
4. `feed-staleness.ts` / `email-replies.server.ts:459-462`: a transient `unreadable` must not reopen a dismissed
   episode or raise an item on a fresh file (e.g. require N consecutive failures, or keep the previous episode).
5. `email-replies.server.ts:342`: feed rows can fall outside `LIMIT 50`.

Before switching `proposals` on: D5 "nobody"/"no one" negators; D6 a negating title ("Do not ...") is grounded
because "do"/"not" are stopwords.

UI-UNVERIFIED (needs a browser run on the deployed app, not done -- no live systems): "Teams chats" checkbox for
existing users, feed/chat rows render in the bell, "Open in Teams" link, proposal rows (5.6, 5.24).
