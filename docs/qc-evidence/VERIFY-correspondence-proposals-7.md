<!--
WHAT:          Independent verification (loop 7) of claude_task-proposals @ 3b3f0c42: loop-6 refuted items re-derived,
               part A (AI conversation judge) and part B (meeting triage) derived in full, the two merges checked,
               and the flags-OFF live-change table rebuilt.
WHY:           Tier 1 (model output decides what is flagged and is stored as proposals; live work-email screen touched).
SUPERSEDES:    docs/qc-evidence/VERIFY-correspondence-proposals-6.md (origin/claude_verify-correspondence-proposals-6 @ 9afa8eb6)
SUPERSEDED-BY: nothing -- current
EVIDENCE:      this file; probe scripts scripts/verify7-*.ts (this loop), scripts/verify6-*.ts copied from loop 6
-->

# VERIFY correspondence-proposals, loop 7

Started 2026-11-14 03:32 UTC, budget 3 h (ends 06:32 UTC). Isolated worktree; branch
`claude_verify-correspondence-proposals-7` started from the target **3b3f0c42** (no src change; additions are this
file and probe scripts). origin/main at start: 7ba8f7a4. No live system touched; synthetic `.example` data only.

## Claim 0: full suite re-run at 3b3f0c42 -- CONFIRMED

| suite | implementer | observed |
|---|---|---|
| needs-you | 77/0 | 77/0 |
| meeting-triage | 69/0 | 69/0 |
| meeting-triage-server | 7/0 | 7/0 |
| meeting-triage-sql (local PG 16) | 34/0 | 34/0 |
| proposals-preview | 15/0 | 15/0 |
| task-proposals | 199/0 | 199/0 |
| redteam-correspondence | 77/0 | 77/0 (exit 0) |
| inbound-email | 72/0 | 72/0 |
| correspondence-ingest | 149/0 | 149/0 |
| feed-staleness | 98/0 | 98/0 |
| html-visible-loop5 | 16/0 | 16/0 |
| onedrive-feed-truth | 11/0 | 11/0 |
| cross-app-turn-gate | 92/0 | 92/0 |
| onedrive-feed / attention / attention-focus / confirm-ask-context / artifact-preview | -- | all passed / all passed / all passed / 21/21 / 28/0 |
| feed-staleness-sql / task-proposals-sql / correspondence-ledger-sql / fireflies-queue-sql | -- | 23/0 / 45/0 / 50/0 / all passed |
| fireflies-minutes | G3/G5/G8 fail on base | G3, G5, G8 FAIL -- **the same three fail on origin/main 7ba8f7a4** (run from a `git archive` of main) |
| `npx tsc --noEmit` | -- | exit 0, no output |
| `npm run build` | -- | exit 0 |

Bundle spot check: `parse5` is only in `.output/server/_libs/parse5.mjs` (+ the server onedrive-feed chunk); `grep parse5
.output/public` = nothing. The judge prompt (`conversation_judgement`, "You judge ONE email") is only in the server
chunk. **Observation (pre-existing pattern, non-blocking):** `proposals-store.server.ts` and `proposals.server.ts`
are emitted as client chunks too (`.output/public/assets/proposals-store.server-*.js` holds the bootstrap DDL; no
secret -- `{}.AZURE_PG_URL` is empty). 41 `*.server-*` chunks are in `public/assets`, so this is how the app's build
already treats every server module, not something this branch introduced.

## Loop-6 fix pass (637b2d90 and parents): tests only ADDED

`git diff ddc7b55d 637b2d90 -- scripts` removes no test line (feed-staleness +25, html-visible-loop5 +10, redteam +2).

## Claim 1: implied end tags no longer flip the live ask decision -- FIXED for implied tags; RESIDUAL class REFUTED

`scripts/verify6-screen-probes.ts` (loop-6 rows, main = byte copies of 7ba8f7a4's `onedrive-feed.ts` /
`inbound-email.ts`, diffed equal): **8/8 rows now identical to main** (loop 6: 5 of 8 flipped).

New malformed shapes, `scripts/verify7-screen-probes.ts` (39 rows; live decision = `asksSomething({bodyText:
htmlToText(html)})`, plus `newTextOnly` line structure): **11 ask-decision flips vs main, both directions.**
The fix re-emits only tags the source wrote, but it re-emits them as a bare `<name>` / `</name>`, while main's
`htmlToText` regex (`<br\s*\/?>|<\/(p|div|li|tr|h\d)>`) matched only the exact spellings, and the parser drops stray end
tags that main still turned into line breaks:

| shape (synthetic; ATT = `On Monday the board wrote:`, ASK = `Can you approve the budget?`) | branch | main |
|---|---|---|
| `Hello<br>ATT<br clear="all">ASK` (also `<br style=..>`, `<BR CLASS=..>`) | **no ask** | ask |
| `<p>Hello</p><p>ATT</p ><p>ASK</p >` (end tag with a space) / `</div\n>` / `</p class="x">` | **no ask** | ask |
| `<table><tr><td>ASK</td></tr><p>ATT</p></table>` (foster parenting moves ATT above the ask; also bare text + `<br>`, `<div>`) | **no ask** | ask |
| `Thanks, will do.</div>On Mon, Nov 10, 2025 at 9:14 AM Dana Kim <dana@corp.example> wrote:</div>Can you send the old ledger?` (stray `</div>`s) | **ask** (old quoted ask kept) | no ask |
| `Noted.</p>From: Dana Kim</p>Sent: Monday</p>Can you send the old ledger?` (stray `</p>`s, From/Sent pair) | **ask** | no ask |

Also observed: a parser-ignored stray end tag now produces NO separator at all, so words glue
(`...wrote:Can you`, `KimSent:`), where main produced a newline. A realistic Gmail reply with `<br clear="all">` before
the signature does NOT flip (row `gmail-reply-real-shape`).

**Judgement:** same class as loop-6 row 1d (English quoted-history line rules now apply, or stop applying, where main's
did not) and not among the three approved changes. Realism is LOW (attribute-carrying `<br>` right after an English
"On ... wrote:" sentence, malformed end tags, stray end tags, `<p>` directly in `<table>`), so the practical blast
radius is small, but the claim "re-emits only tags the source wrote, so line breaks match main" is not true in general.
**Minimal fix direction (proposal):** keep main's text pipeline byte-for-byte and use parse5 ONLY to find the source
offset ranges of hidden elements; cut those ranges out of the ORIGINAL html and run main's `htmlToText` on the rest.
Then the only flags-OFF change is "hidden text is ignored" (+ entities), by construction, including stray tags and
attribute spellings.

## Claim 2: depth guard keeps text past depth 400 -- FIXED; one narrow residual

`scripts/verify7-depth-css-probes.ts`: 405 / 600 nested `<div>`s and 1000 nested `table>tr>td` keep the ask (main too),
2-17 ms. A `display:none` / `visibility:hidden` / `font-size:0` ancestor ABOVE depth 400 still hides text at depth 600
(main shows it -- the approved hidden-text change). Residuals past depth 400 (`flatText` applies no style rules):
(i) a hidden element whose own depth is > 400 is shown (= main, keep direction, fine); (ii) `visibility:visible`
under a `visibility:hidden` ancestor, past depth 400, is DROPPED (browser shows it; main keeps it). (ii) needs > 400
nested elements plus a hidden/visible pair: negligible realism, non-blocking.

## Claim 3: ';' inside a quoted CSS string -- FIXED

Same probe file: `;` inside `'..'`, `".."`, `url(..)`, an escaped quote inside a string, an unterminated quote, and an
unbalanced `(` all keep the ask (no split); a real `display:none` after a closed string, and after a stray `)`, still
hides. `styleDeclarations("font-family:'A;B';display:none")` = `[["font-family","'a;b'"],["display","none"]]`.

## Claim 4: U5 (incomplete sent.json stuck at transient) -- FIXED; one residual

`scripts/verify7-staleness-stuck.ts`: the REAL `runFeedStalenessCheck` with a `refreshRead` that simulates `readFeed`
over a fake drive, against the REAL bell SQL (`raiseFeedAttention` / `clearFeedAttention` / `notePendingFeedAttention`)
on local PostgreSQL 16:

| scenario | observed | urgent announcements |
|---|---|---|
| A: incident, then flow fixed, nobody else reads sent.json | A1 incomplete raised; **A2 refresh -> ok -> fresh, cleared**; A3 fresh, no 2nd refresh | 1 |
| B: dismissed, flow fixed, then the flow STOPS for 4 working days | B2 fresh/cleared; **B3 stale, raised, row owed** (the later outage IS alerted) | 1 urgent + the stale raise |
| C: newer copies still incomplete | C2/C3 incomplete, raised 0 (one refresh per new copy) | 1 |
| D: the refresh read hits a transient error (`readFeed` records `error`), then the reader reads the still-incomplete file | **D2 fresh, CLEARED; D3 incomplete, raised again** | **2** |
| E: refresh returns null (state DB unreadable) | transient, row stays owed | 1 |

`readFeed` (`onedrive-feed.server.ts:207`) records `ok` + `last_good` on success; the extra read does not swallow
ingestion (the ingest pass keys on its own cursor eTag, `ingest-pass.ts:123-135`), and `feedEmailMessages` uses the
snapshot whether changed or not. **Residual D (U1-class double announcement):** any non-incomplete read status
(`error`) ends an incomplete incident via the time path (`feed-staleness.ts:167`). This was already reachable through
the ordinary reader before this fix; the refresh adds one more read per hour during an incident. Behind
`staleAlerts` (OFF), non-blocking; fix direction: a read `error` should not end an incomplete incident.

## Claim 5: nits -- FIXED

`scripts/redteam-correspondence.test.ts` ends `if (fail) process.exit(1);`. The `inbound-email.ts:150` comment now says
`isWrappedAttribution` has no `src/` caller (grep confirms: definition only).
