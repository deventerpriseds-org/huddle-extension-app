# VERIFY-correspondence-proposals-9

WHAT:       Independent verifier loop 9 for `claude_task-proposals` @ `1c0171d7` vs `origin/main` (`ab6c87a0`).
WHY:        Loop 8 (`claude_verify-correspondence-proposals-8` @ `4857ac27`) refuted claim 1d (quote-aware tag regex
            dropped visible text after an apostrophe in an unquoted attribute) and observed 1e (parse5 quadratic on
            deep block nesting). Commit 1c0171d7 claims to fix both. This loop re-derives them, re-checks loop 8's
            confirmed probes, and covers claims 2-4 that loop 8 did not reach.
SUPERSEDES: nothing (VERIFY-correspondence-proposals-8.md stays as the loop-8 record). SUPERSEDED-BY: nothing -- current.
EVIDENCE:   probe scripts `scripts/verify9-*` on this branch; loop 5-8 probes copied unchanged from the loop-8 branch.

Verifier started 2026-11-15 17:36 UTC. Budget 2 h of active time. All fixtures synthetic. No live systems touched.

## Results (appended per claim as each lands)

- Claim 0 (suites): CONFIRMED
- Claim 1 (1d + 1e fixes, loop-8 re-check): REFUTED (1d: `=`+quote shapes drop a visible ask; 1e: guard bypassable, 62 KB -> 7 s)
- Claim 2 (bell "Teams chats" removed): CONFIRMED in code; UI not browser-verified (MERGE-PENDING-UAT)
- Claim 3 (forwarded.ts + preview scripts): (a)(b)(c) CONFIRMED; (d) PARTLY (OWA appendonsend + CRLF forwards read as null; 11 subject misses) -- preview only
- Claim 4 (merge readiness, flags off): PARTLY REFUTED (line-474 regex; build_checklist `proposals` param model-visible; 2 dormant non-flag paths)

## Claim 0: every suite at 1c0171d7 -- CONFIRMED

Ran EVERY `scripts/*.test.ts` (106 files) with `bun <file>` (PG 16 binaries on PATH for the self-hosting SQL suites).
96 exit 0. The 10 non-zero files, each re-checked:

| file | on branch | why | on origin/main (ab6c87a0, `git archive`) |
|---|---|---|---|
| autowork-lane-starvation / memory-context / raw-create-dedup / timeout-no-rerun | "Cannot use beforeEach()/describe outside of the test runner" | they are `bun test` files | `bun test`: 26/0, 11/0, 30/0, 12/0 on branch |
| focus | 24/1 (F22 voice call to Iris) | pre-existing | identical 24/1 |
| memory-mode | 2/4 | pre-existing | identical 2/4 |
| model-policy | diff 3 sol-ceiling FAIL | pre-existing | identical |
| start-on-approval | 49/50 (coursework) | pre-existing | identical 49/50 |
| fireflies-minutes | 3 FAILED (G3/G5/G8) | pre-existing (as loop 8 found) | identical 3 FAILED |
| confirm-reask-db | refuses without `LOCAL_PG_ADMIN_URL`; with a local PG 16 URL: 1 failure AC-27 | pre-existing | identical AC-27 failure |

The correspondence/html suites the implementer listed, observed here: html-visible-loop5 29/0, onedrive-feed-truth 11/0,
inbound-email 72/0, needs-you 77/0, redteam-correspondence 77/0, task-proposals 199/0, correspondence-ingest 149/0,
proposals-preview 15/0, feed-staleness 98/0, forwarded 17/0, meeting-triage 69/0, attention + attention-focus all
passed. SQL: task-proposals-sql 45/0, correspondence-ledger-sql 50/0, feed-staleness-sql 23/0, meeting-triage-sql 34/0,
meeting-triage-server 7/0, fireflies-queue-sql all passed. Others of note: cross-app-turn-gate 92/0, onedrive-feed all
passed, inbox-read 68/0, email-self-send 73/0.

`npx tsc --noEmit`: exit 0, 0 lines. `npm run build`: exit 0.
No suite fails on the branch that passes on main.

## Claim 1: loop-8 1d + 1e fixes -- REFUTED (both fixes are incomplete; narrower, but the same two defects remain)

### 1a/1b. Loop-8 confirmed probes re-run at 1c0171d7 -- still hold

| probe | result |
|---|---|
| `verify8-chromium-rows` loop-5 / loop-6 / implementer truth | 88 / 130 / 81 rows, regression drops **0 / 0 / 0**, every ask flip vs main goes Chromium's way (flips-where-branch!=chromium 0 / 0 / 0) |
| `verify8-chromium-rows` loop-8 set | 71 rows, regression drops 0, 1 flip against Chromium = `fontzero-attribution` (font-size:0, the deliberate invisible family) |
| `verify8-screen-probes` | 63 rows, 11 ask flips, 1 against Chromium (`fontzero-attribution`); the 2 rows dropping words main + Chromium show are `recon-i-fontzero` and `fontzero-attribution` -- both font-size:0. `apostrophe-unquoted-attr` no longer drops (fixed). |
| `verify8-quote-probes` | 8/8 same-ask, incl. `q-mailto-apostrophe-unquoted`, `q-attr-name-apostrophe` |
| `verify7-screen-probes` / `verify6-screen-probes` | rows=39 differ=0 flips=0 / rows=8 differ=0 |

### 1d. REFUTED: `=` followed by a quote still opens a run where the browser does not

The new rule (`onedrive-feed.ts:474`, `/<[a-zA-Z\/!?](?:[^>"'=]|=\s*"[^"]*"|=\s*'[^']*'|=)*>/`) opens a quoted run after ANY `=`.
The HTML tokenizer opens a quoted value only in the "before attribute value" state -- right after an attribute NAME and
its `=`. An `=` that starts an attribute name, follows a closed quoted value, is a second `=`, or sits in the tag name
is an ordinary character there, and the tag ends at the first `>`.

Loop-9 shapes, built independently (`scripts/verify9-shapes.mjs`, 28 rows; Chromium-recorded by
`scripts/verify9-chromium-record.mjs` -> `scripts/verify9-chromium-truth.json`; compared by
`bun scripts/verify9-quote-probes.ts`): **rows dropping a word main AND Chromium show = 6, ask flips vs main = 2, both
against Chromium.**

| shape (synthetic) | branch | main | Chromium |
|---|---|---|---|
| `after-quoted-value-eq-ask`: `<p><b class="hi"='x>Can you approve the budget? it's due</b></p>` | `""` **asks=false** | full ask, asks=true | full ask, asks=true |
| `double-eq-ask`: `<div><span title=='x>Can you approve the budget? it's urgent</span></div>` | `""` **asks=false** | full ask | full ask |
| `double-eq-sq`: `<span title=='x>Dana's note:</span> Can you ...` | drops "Dana's note:" | keeps | keeps |
| `attr-name-starts-eq`: `<b class="hi" ='x>Lee's list</b> ...` | drops "Lee's list" | keeps | keeps |
| `after-quoted-value-eq`: `<b class="hi"='x>Lee's list</b> ...` | drops "Lee's list" | keeps | keeps |
| `tag-name-eq`: `<b='x>Lee's list</b> ...` | drops "Lee's list" | keeps | keeps |

Controls the fix gets right (all three agree, or branch = Chromium): apostrophe/quote inside an unquoted value or name,
backtick values, unquoted `style=font-family:'Segoe UI'`, `onclick=alert('x')`, `&quot;` in a value, `<br/'>`, Outlook
`MsoNormal` + `style='...\"Calibri\"...'`, Gmail `dir="ltr"`, `mailto:o'neil` inside a dq value, unquoted URL query
`?a=1&b=2`, `= 'a > b'` / `=\n"a > b"` / `=\t'a > b'` (branch = Chromium, main shows a `b'>` residue). Two `=`+quote
shapes inside an unquoted value (`href=...?id='q4>`) happened NOT to drop only because `</p>` had already been
rewritten to a newline, so the run found no closing `>`.

Reach: needs an `=` immediately (or after whitespace) before a quote where no attribute name precedes it -- malformed
markup no mainstream client writes. But it is the same defect class loop 8 refuted (a regex guessing the tokenizer
drops a whole visible ask main and Chromium show, on the live screen with every flag off), so per the owner's rule it
is a REFUTE.

**Minimal fix (measured): delete line 474** -- tag handling is then byte-for-byte main's `<[^>]+>`. I applied it
temporarily (restored after; not committed) and re-ran: `verify9-quote-probes` drops 0 / flips 0; `verify8-chromium-rows`
regression drops 0 on all four sets, flips against Chromium only `fontzero-attribution`; `verify7-screen-probes` 39/0;
onedrive-feed-truth 11/0, inbound-email 72/0, redteam-correspondence 77/0, needs-you 77/0, correspondence-ingest 149/0.
Cost: `html-visible-loop5` fails 4 assertions that pin the GT-in-alt improvement (`LOOP5 no row drops a word` reports
`GT-in-alt-phantom-hidden` "missing Can" -- the text becomes `">Can you sign...`, main's own residue glued to the word,
not a drop; `exact 83/88`; the two `LOOP8 control` GT-in-alt rows). Those assertions pin a behaviour main does not have
and the owner did not list as approved; they would be updated to main's residue. Every alternative regex re-derives the
tokenizer one shape at a time, which is how loops 5, 8 and 9 each found a new drop.

### 1e. REFUTED: the depth guard is an estimate the input controls; two shapes still reach the slow parse

`bun scripts/verify9-depth.ts` (branch htmlToText vs main):

| input (synthetic) | len | estimatedDepth | parser | branch ms | main ms |
|---|---|---|---|---|---|
| div / table-tr-td / blockquote / ul-li / b, x1999 closed or unclosed | 6-50 KB | 1998-1999 | runs | 6-22 | 0-2 |
| same x2001 | 6-50 KB | 2001 | skipped | 0-3 | 0-2 |
| `<b id=bN>` x1999 unclosed | 23 KB | 1999 | runs | 157 | 0 |
| **`"<div></i>".repeat(40000)`** (stray end tags) | 360 KB | **1** | runs | **7748** | 4 |
| `"<div></x>".repeat(40000)` + closes | 600 KB | 1 | runs | 7735 | 5 |
| `"<blockquote></span>".repeat(40000)` | 760 KB | 1 | runs | 5415 | 2 |
| **1990 distinct unclosed `<b id=..>` then `<p>y</p>` x5000** | **62 KB** | 1991 | runs | **7107** | 1 |
| 1500 distinct `<b>` then `<p>` x10000 | 97 KB | 1501 | runs | 11987 | 1 |
| 20000 distinct `<b id=..></i>` then `<p>` x200 | 330 KB | 2 | runs | **31893** | 2 |

Two mechanisms: (1) `estimatedDepth` subtracts one for EVERY end tag, including stray ones the browser ignores, so
`<div></i>` x40k reads as depth 1 while the real tree is 40k deep -- exactly loop 8's 5-8 s cost, guard bypassed;
(2) formatting-element reconstruction: N distinct open `<b>` (Noah's Ark only merges identical ones) are rebuilt in every
later paragraph, N x M elements, with the estimate below the limit and no stray tag needed (62 KB -> 7 s).
Main is 0-5 ms on all of them. Every live work-email read re-maps every snapshot record, so one hostile body costs that on
every read, flags OFF. Hostile sender only; no real client writes these.

**Minimal fix (prototyped, `bun scripts/verify9-guard-proto.ts`, not wired into src/):** bound parse5 by what it actually
BUILDS -- a tree adapter over `defaultTreeAdapter` that tracks real depth in `appendChild`/`insertBefore` and counts
`createElement`, throwing past depth 2000 or `4 x start-tag count + 2000` elements; visibleHtml's existing `catch` then
returns the html unchanged (main's text). Measured: all six hostile inputs stop in **16-138 ms** (guard:depth or
guard:nodes); **0 of 398** corpus rows (loop 5/6/8/9 + implementer truth) trip it, so no output changes; a 180 KB
Outlook-style table report parses unguarded in 23 ms. `estimatedDepth` can stay as a cheap pre-check or go.

### 1e (second question). Can a realistic email cross the limit, and is that acceptable?
`estimatedDepth` over-counts unclosed `<p>`/`<li>`/`<td>`/`<tr>`/`<option>`, XHTML-style `<div/>`, and tags inside
comments (VML `<v:fill .../>`, `<o:AllowPNG/>` count as opens). A long generated report or newsletter with ~2000 unclosed
cells/paragraphs could cross it. Then visibleHtml returns the html unchanged: hidden text, comments and `<head>` text
are shown exactly as on main (htmlToText on the branch has no comment / head stripping of its own; main had none either).
The remaining differences on that path are only entity decoding (approved) and the line-474 regex (1d). With line 474
removed, an over-limit email reads exactly like main -- acceptable under the owner's rule (keep-more, main's behaviour);
it only loses the approved hidden-text cut for that one email.

### Radius challenge (claim 1)
`htmlToText` from onedrive-feed.ts is also imported by `src/features/huddle/lib/external-feeds/teams-log.ts:26` (new on
the branch, not in the brief's radius) -- checked under claim 4. `inbox-read.ts` has its OWN `htmlToText` (line 254),
byte-identical to main (diff empty), so the Graph inbox tool is outside the radius.

## Claim 2: bell "What counts" no longer offers "Teams chats"; nothing else changed for the owner -- CONFIRMED in code, UI NOT browser-verified (MERGE-PENDING-UAT)

Read `git diff origin/main...1c0171d7` of `lib/attention/attention.ts`, `attention.functions.ts`, `components/AttentionBell.tsx`,
and the bell's store (`email/email-replies.server.ts`).

| check | observed |
|---|---|
| settings list | `AttentionBell.tsx:157` maps `SETTINGS_KINDS`; `attention.ts:35` = `ATTENTION_KINDS.filter(k => k !== "chat")`; `attention.test.ts` A0 pins `["email","meeting","appointment"]` (attention: all passed). Same three labels as main. |
| badge count | `badgeCount` skips only `uncertain` items; `uncertain` is set only in the `chat` branch of `toAttentionItem` -> identical to `items.length` while no chat row exists |
| empty state | `count === 0` -> `items.length === 0`: identical while no uncertain row exists |
| row layout | the row button is now wrapped in `<div class="min-w-0 flex-1">` with `w-full` on the button; same text, classes and click target for email/meeting/appointment rows. `Open in Teams` renders only when `it.link` (chat rows only). |
| what the bell lists | `bellItems` also passes `feed` rows; `listOpenAttention` sorts `kind='feed'` first. Chat rows are written only by `ingest.server.ts` (needs `correspondence.ingest` + `bell`), feed rows only by `feed-staleness.server.ts` (`correspondence.staleAlerts === true`); flags off => no such row, list identical. |
| stored setting | reading: `resolveStoredUrgentKinds` adds the hidden `chat` kind to a saved list (no chat rows -> no visible effect). Saving: `serializeUrgentKinds` writes the kinds (now including `chat` unless unchecked) and `-chat` for an opt-out; main's `parseUrgentKinds` ignores both, so a later revert reads the setting cleanly. |
| schema | bootstrap adds three nullable columns to `chat.email_replies` (`needs_context`, `source_link`, `feed_pending`, `ADD COLUMN IF NOT EXISTS`); `listOpenAttention` now selects two of them. Additive; a failed ALTER would make the bell read fail (caught -> empty bell), but the app role created the table. |
| settle-in-chat | `settleAttentionForHuddle`: `kind <> 'email'` -> `kind NOT IN ('email','chat','feed')`: same rows while no chat/feed rows exist. |

UI-UNVERIFIED: the rendered settings panel was not seen in a browser. The branch is not deployed, and the existing
`attention-bell-checks.mjs` (verify-uat.yml) never opens the settings panel. Browser check still owed after landing:
open the bell, open "What counts", expect exactly three checkboxes: Emails, Meetings, Appointments & reminders.

## Claim 3: forwarded.ts + preview scripts -- (a) (b) (c) CONFIRMED, (d) PARTLY (preview-only gaps, no live impact)

### 3a. Live path untouched -- CONFIRMED
`grep` for any import of `correspondence/forwarded` across `src/` and `scripts/`: only `scripts/action-scan-steps.ts:16`
and `scripts/forwarded.test.ts:7` (plus comments). Nothing in `src/` imports it. forwarded.ts only CALLS `htmlToText`
and `newTextOnly`; it changes neither. `FORWARD_SUBJECT` is used only in forwarded.ts and action-scan-steps.ts.

### 3b. Never throws, bounded -- CONFIRMED (`bun scripts/verify9-forwarded.ts`, hostile section)
`"re:"` x100k subject 36 ms (null); 100k spaces 2 ms; 2 MB of repeated markers 233 ms; 100k unclosed marker divs 17 ms;
1 MB plain lines 87 ms; 1 MB of From/Sent pairs 4 ms (capped at 6000 chars); number subject / object body / null /
undefined -> null. No throw on any. The output is capped at `max` (6000). Its time is bounded by `htmlToText`, so it
inherits claim 1e's hostile shapes (preview only).

### 3c. Public-log output -- CONFIRMED (one privacy note)
Every `console.*` in `action-scan-steps.ts` (lines 95, 160, 218, 219, 228) and `reply-scan-preview.ts` (29, 58, 154, 190,
199) prints counts, HTTP statuses, the model name, the OneDrive path `/automation/Huddle Preview/...-<stamp>.html` and
(action scan only) `OPEN THE REPORT: <webUrl>`. Per-row text (names, subjects, quotes, reasons) goes only into the HTML
written to OneDrive / emailed. Model failures are counted (`catch { failures++ }`), never printed. Note for the owner:
the repo is PUBLIC, so its Actions logs are world-readable, and a OneDrive for Business `webUrl` is normally a
`https://<tenant>-my.sharepoint.com/personal/<user_name>/...` link, i.e. it carries the work tenant and the owner's name.
The brief allows "the report link"; main's #243 already prints such links from graph-permission-check. Inference
(not observed: no run was made from this session); the owner may prefer the link only in the emailed copy.

### 3d. Spelling table and body shapes -- PARTLY
`FORWARD_SUBJECT = /^\s*(?:(?:re|aw|sv)\s*:\s*)*(?:fw|fwd|tr|wg|rv|doorst)\s*:/i`. 31 subjects (want = a reader calls it
a forward):

| result | subjects |
|---|---|
| correct (13 + 4 negatives) | `FW:`, `Fw:`, `Fwd:`, `FWD:`, `RE: FW:`, `Re: Re: Fwd:`, `TR:`, `WG:`, `AW: WG:`, `RV:`, `Doorst:`, `Fw :`, leading space; negatives `Re:`, `... fw: notes`, `Fwiw:`, `Trial:` |
| missed forwards (11) | **`[EXTERNAL] FW:`** and `EXT: FW:` (corporate external-sender tags are common), `ENC:` (pt), `I:` (it), `VS:` (da/no), `VB:` (sv), `VL:` (fi), `PD:` (pl), `Antw: Fw:` (nl reply prefix), `FW：` (full-width colon), `Re[2]: Fw:` |
| over-matches (3) | `RV: cabin for sale`, `TR: tax return question`, `WG: flat share keys` (abbreviations that collide with es / fr / de prefixes; consequence: only that the preview also reads a forwarded part) |

Body shapes (`forwardedText("FW: REMINDER", body, isHtml)`, want = the forwarded ask is returned):

| shape | result |
|---|---|
| Outlook classic: `<div id="divRplyFwdMsg">` | ask returned |
| **OWA / new Outlook: `<div id="appendonsend"></div><hr><div id="divRplyFwdMsg">`** | **null** -- `RPLY_FWD` matches `appendonsend` first, only that id is renamed, so htmlToText cuts again at `divRplyFwdMsg` (the forward header itself) and nothing is left; the plain-header fallback is not tried when a marker was found |
| prefixed `x_divRplyFwdMsg` (no marker match) -> plain-header fallback | ask returned |
| Gmail `---------- Forwarded message ---------` + From/Date | ask returned |
| plain `From:`/`Sent:` header, no marker | ask returned |
| plain text LF + `-----Original Message-----` | ask returned |
| **plain text CRLF** + `-----Original Message-----` | **null** -- `newTextOnly` strips `\r`, so `text.startsWith(fresh)` in `afterCut` fails |
| plain text with a `>` line before the forward | ask returned |
| plain text `Begin forwarded message:` | ask returned |

Preview-only (the judge's input), so no live behaviour is affected; it under-reads forwards rather than mis-reading.
Minimal fixes: match `divRplyFwdMsg` before `appendonsend` (or rename every marker up to and including the first
`divRplyFwdMsg`), and fall back to `afterCut` when the marker path yields nothing; strip `\r` before `afterCut`;
optionally allow a leading `[...]` tag / `EXT:` and the missing Outlook locale prefixes.

## Claim 4: merge readiness with every flag OFF -- PARTLY REFUTED

`git diff origin/main...1c0171d7` (merge-base `aa29eef5`): 75 files. origin/main's 6 newer commits (`aa29eef5..ab6c87a0`)
touch only `.claude/*.md` and two workflows, so this is the whole `src/` difference on merge.
`git merge-tree --write-tree origin/main 1c0171d7`: one conflict, `.claude/memory.md` (ledger text only).

Every `src/` file read (non-new files diffed hunk by hunk; new files checked for their gate):

| # | change that reaches LIVE behaviour with every `correspondence.*` flag off | where | status |
|---|---|---|---|
| 1 | hidden text / comments / head / script cut from work-email text (visibleHtml) | `onedrive-feed.ts:457-481`, `html-visible.ts` | approved (a) -- but see claim 1d/1e |
| 2 | entities decoded once; raw ` ` -> space; raw typographic quotes folded | `onedrive-feed.ts:446-456, 477-480` | approved (b). The folding of RAW quote characters is not strictly an entity; it cannot move the ask decision (`ASK` and the English cut rules contain no apostrophe) |
| 3 | non-English reply headers / attributions / "Original Message" forms cut | `inbound-email.ts:72-152` | approved (c) |
| 4 | quote-aware tag regex | `onedrive-feed.ts:474` | **NOT approved, drops visible asks (claim 1d)** |
| 5 | "Teams chats" hidden from What counts | `attention.ts:35`, `AttentionBell.tsx:157` | expected |
| 6 | **`build_checklist` tool schema gains a `proposals` boolean** that every agent turn sees; when the model sets it, the result is `{"error":"not_enabled","message":"Task proposals are not switched on. Say so in one line."}` | `tools.ts:99-103` + dispatch `tools.ts:129-139`; Lovable path `huddle.functions.ts:6287`; message `proposals.server.ts:246` | **NOT in the expected list** -- model-visible with flags off; a "show my proposed tasks / to-dos from my email" ask now gets a "not switched on" line instead of main's ordinary checklist. Carried since loop 5 (loop-7 row 4-11), never owner-approved |
| 7 | owed WORK-email rows settle from `sent.json` | `email-replies.server.ts:257-302` | dormant: only when the deploy secret `HUDDLE_ONEDRIVE_FEEDS` carries a `sent` key (separate opt-in, NOT under `correspondence`; `optInFile`, `onedrive-feed.ts:193`). The only in-repo writer of that secret (`onedrive-feed-config.yml:92-103`) emits no `sent` key; owner chose this design (option A, 2026-11-12). Inference: off in prod -- the secret's value cannot be read from here |
| 8 | `sendHuddleMessage` input accepts a `checklist` payload; `ensureChecklistDelivered` attaches it to the target agent's reply (or adds "Hello Sir, here is what's waiting for your review.") | `huddle.functions.ts:306-311, 7225-7227, 7466-7478` | dormant: only a caller that sends `checklist` triggers it (the flagged evening proposals posting); a signed-in client could send one into its own chat (sanitized, no new data reachable) |
| 9 | bootstrap adds 3 nullable columns to `chat.email_replies`; bell SELECT reads 2 of them | `email-replies.server.ts:56-62, 346` | schema-additive, no behaviour change |
| 10 | heartbeat starts two more dynamic imports and awaits them | `scheduler.server.ts:287-296, 317-318, 364-365` | zero work with flags off (`runIngestOnly` returns at `!cfg.correspondence.ingest`; `runProposalsPass` at `!proposalsConfig()`) |
| 11 | `readFeed` I/O moved into `fetchDriveFile` (+ `id` in `$select`, explicit GET, `etag` on the result) | `onedrive-feed.server.ts:97-330` | equivalent: same short-circuit (`state.last_good ? state.etag : null`), same size cap, same error strings |
| 12 | build_checklist reply sanitising moved into `sanitizeChecklistPayload` | `huddle.functions.ts:7153-7160`, `proposals.ts:792-837` | equivalent for rows with no `kind` (same 4 fields, same BACKLOG default, same tag filter, same `more`, undefined when empty) |
| 13 | ChecklistCard reconcile split into proposal / task reads; stream summary splits proposal rows | `HuddleView.tsx:609-690`, `stream-context.ts:92-114` | equivalent with no proposal rows (same single `getBoardTasks`, same summary line) |
| 14 | bell: badgeCount, layout wrapper, feed-first order, hidden `chat` kind in stored settings, settle excludes chat/feed | claim 2 | no visible change with flags off |
| 15 | `fetchTranscript` exported; type-only fields in `seed.ts` / `store.ts`; `mapFeedMessage` optional fields; parse5 (server bundle only: `.output/server/_libs/parse5.mjs`, absent from `.output/public`) | -- | no behaviour change |

So beyond the expected four, row 4 (a defect) and row 6 (a model-visible tool parameter) change live behaviour with
every flag off; rows 7 and 8 are dormant paths that do not depend on a `correspondence.*` flag.

Minimal fixes: row 4 -> claim 1d. Row 6 -> add `proposals` to the tool schema only when `proposalsConfig()` is non-null
(build the tool list per turn), or accept it explicitly. Rows 7/8 -> owner acknowledgement, or gate on `correspondence.*`.

## Regressions checked
The branch is not deployed (prod serves origin/main), so a live golden-path walk would test main, not this branch: NOT
RUN. In-repo regression evidence instead: every suite (claim 0), `npm run build` exit 0, `tsc` exit 0, loop 5-8 probes
(claim 1a/1b).

## Verdict -- FIX FIRST

| claim | result |
|---|---|
| 0 suites | CONFIRMED (no branch-only failure; 10 non-zero files explained, identical on main or `bun test` files) |
| 1d quote regex | **REFUTED** -- `="x"='y`, `=='y`, ` ='y`, `<b='y` swallow a whole visible ask main and Chromium show (2 ask flips, 6 rows drop words) |
| 1e depth guard | **REFUTED** -- stray end tags make `estimatedDepth` read 1 (40k-deep tree, 7.7 s); distinct-formatting reconstruction under the limit (62 KB -> 7.1 s); main 0-5 ms. Hostile sender only |
| 1 (over-limit email reads like main) | acceptable once line 474 is gone |
| 2 bell | CONFIRMED in code; **UI-UNVERIFIED** (settings panel not seen in a browser) |
| 3a/3b/3c forwarded + preview logs | CONFIRMED (privacy note: the action-scan log prints a SharePoint `webUrl`) |
| 3d spelling / body shapes | PARTLY -- OWA `appendonsend` forwards and CRLF plain-text forwards return null; 11 subject misses incl. `[EXTERNAL] FW:`; preview only |
| 4 merge readiness | PARTLY REFUTED -- besides the expected four: line 474 (defect) and the model-visible `build_checklist` `proposals` parameter; two dormant non-flag paths (sent settle, checklist payload input) |

PASS 4 | FAIL 3 (1d, 1e, 4) | PARTLY 1 (3d) | UI-UNVERIFIED 1 (claim 2's settings panel)

### Required before done (minimal fix per refute)
1. **1d**: delete `onedrive-feed.ts:474` (measured: 0 drops / 0 flips on all 398 Chromium-recorded rows + loop-9 shapes;
   update the 4 html-visible-loop5 assertions that pin the GT-in-alt residue to main's residue).
2. **1e**: bound parse5 by what it builds -- tree adapter with real depth (appendChild/insertBefore) and an element budget,
   throw -> visibleHtml's existing catch returns the html (prototype `scripts/verify9-guard-proto.ts`: hostile inputs stop
   in 16-138 ms, 0 of 398 corpus rows trip it).
3. **4 row 6**: offer `proposals` in the `build_checklist` schema only when `proposalsConfig()` is non-null, or get the
   owner's explicit OK for the model-visible parameter.
4. Optional (preview only, 3d): prefer `divRplyFwdMsg` over `appendonsend` + fall back to the plain-header path; strip
   `\r` before `afterCut`.
5. After landing: one browser check of the bell's What counts panel (three checkboxes) -- NOT YET UAT-VERIFIED.
