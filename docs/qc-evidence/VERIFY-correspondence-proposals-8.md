# VERIFY-correspondence-proposals-8

WHAT:       Independent verifier loop 8 for `claude_task-proposals` @ `07f5f6d3` vs `origin/main` (`d56e90f8`).
WHY:        Loop 7 (branch `claude_verify-correspondence-proposals-7` @ `46ff73f8`) returned FIX FIRST on claim 1
            (malformed HTML flipped the live ask decision) and the "Teams chats" checkbox. This loop re-derives both
            fixes and reviews `scripts/reply-scan-preview.ts`.
SUPERSEDES: nothing (VERIFY-correspondence-proposals-7.md stays as the loop-7 record). SUPERSEDED-BY: nothing -- current.
EVIDENCE:   probe scripts under `scripts/verify8-*.ts` on this branch; loop-7 probes restored from the loop-7 branch.

Verifier started 2026-11-14 04:42 UTC. Budget 2 h (ends 06:42 UTC). All fixtures synthetic. No live systems touched.

Main copies used for comparison: `scripts/verify5-main/{onedrive-feed,inbound-email}.ts` -- checked byte-identical to
`origin/main` except the one import path line.

## Results (appended per claim as each lands)

## Claim 0: full suite re-run at 07f5f6d3 -- CONFIRMED (reduced depth)

| suite | implementer | observed |
|---|---|---|
| html-visible-loop5 | 20/0 | 20 passed, 0 failed (prints "exact 83/88") |
| onedrive-feed-truth | 11/0 | 11/0 |
| attention / attention-focus | all passed | all passed / all passed |
| truth | 11/0 | 11/0 (= onedrive-feed-truth) |
| task-proposals | 199/0 | 199/0 |
| redteam-correspondence | 77/0 | 77/0 |
| inbound-email | 72/0 | 72/0 |
| needs-you | 77/0 | 77/0 |
| correspondence-ingest | 149/0 | 149/0 |
| proposals-preview | 15/0 | 15/0 |
| feed-staleness | 98/0 | 98/0 |
| meeting-triage / -server / -sql (local PG 16) | 69/0, 7/0, 34/0 | 69/0, 7/0, 34/0 |
| feed-staleness-sql / task-proposals-sql / correspondence-ledger-sql / fireflies-queue-sql | -- | 23/0 / 45/0 / 50/0 / all passed |
| cross-app-turn-gate / onedrive-feed / confirm-ask-context / artifact-preview | -- | 92/0 / all passed / 21/21 / 28/0 |
| fireflies-minutes | -- | G3, G5, G8 FAIL -- identical three FAIL on a `git archive` of origin/main d56e90f8 (pre-existing, not this branch) |
| `npx tsc --noEmit` | -- | exit 0, no output |
| `npm run build` | -- | exit 0 |

Loop-6 and loop-7 shape probes re-run against 07f5f6d3: `verify7-screen-probes` **rows=39 differ=0 ask-decision-flips=0**;
`verify6-screen-probes` **rows=8 differ=0** (was 11/39 flips at 3b3f0c42).

**Clock note.** Wall clock jumped from 04:47 to 14:27 UTC between two tool calls (suite logs stamped 04:46:47, next
commit 14:27:48; host up 13 h, so no reboot). Nothing ran in that gap. The 2-hour budget is counted as ACTIVE time.

## Claim 1: malformed HTML no longer flips Iris's live ask decision -- PARTLY REFUTED (new, narrow regression)

### 1a. Loop-6/7 shapes: CONFIRMED fixed
`verify7-screen-probes` 39/39 identical to main (ask flips 0); `verify6-screen-probes` 8/8 identical.

### 1b. Every previously Chromium-recorded row: CONFIRMED, no regression
`bun scripts/verify8-chromium-rows.ts` (branch htmlToText vs main htmlToText vs Chromium innerText):

| set | rows | words branch drops that main keeps AND Chromium shows | deliberate invisible-family drops | ask flips vs main | flips where branch != Chromium |
|---|---|---|---|---|---|
| loop-5 | 88 | **0** | 2 | 8 | 0 |
| loop-6 | 130 | **0** | 8 | 6 | 0 |
| implementer truth (`html-visible-text-truth.json`) | 81 | **0** | 0 | 3 | 0 |
| loop-8 new shapes | 71 | **2** | 2 | 12 | 2 (1 is the font-size:0 family, see below) |

Every ask flip on the earlier 299 rows goes the way Chromium goes (hidden text, comments, scripts).

### 1c. NEW malformed shapes (63 + 8 quote shapes, `scripts/verify8-shapes.mjs`, Chromium-recorded by
`scripts/verify8-chromium-record.mjs` -> `scripts/verify8-chromium-truth.json`)

Coverage: stray end tags (span, b/i, table, body/html), unclosed tags (hidden span/font/a/div), `<br>` variants
(`<br/>`, `<br\t>`, `<br\n>`, `<BR/ >`, br inside hidden), implied closes (ul, hr, pre, td), quoted `>` (dq, sq,
inside style), quote oddities, hidden element spanning a `<p>` boundary (span, b), reconstructed formatting (b, i,
strong across a table), comments (attribution inside, `<!-->`, `--!>`, `<!---->`, reply-div inside, script inside,
`>` inside, unterminated, `[if mso]`, downlevel-revealed `<![if !mso]>`), CDATA, processing instruction, entities in
hidden text (`&lt;b&gt;`, `&amp;lt;`, an entity split by a hidden span), hidden / font-size:0 attribution, CRLF, CR-only,
NUL, astral, BOM, raw-text elements (unclosed script / style, textarea, title, xmp), inherited visibility, `hidden`,
depth 500 (hidden ancestor, visible ask), reply-div inside a hidden element, realistic Word/Outlook markup.

`bun scripts/verify8-screen-probes.ts`: rows=63 differ=37 ask-flips=12; **every flip except two matches Chromium**:
- 10 flips where branch = Chromium: hidden span/a/b/div swallowing the ask or attribution, comment holding a reply-div
  or `<script>` (main cut everything after), unclosed `<script>`, depth-500 hidden ancestor, CRLF-separated hidden
  attribution. All are the approved "hidden text ignored" family.
- `fontzero-attribution` (branch asks, main/Chromium innerText do not): font-size:0 text is in innerText but drawn at
  zero size -- the deliberate invisible family. Not a regression.
- **`apostrophe-unquoted-attr` -- BRANCH WRONG.** See 1d.

CRLF / CR / astral / BOM offsets: the cut removes exactly the hidden text (`crlf-hidden` branch = `"Hello\n\n Can you
approve the budget?"`, no stray characters), so parse5's source offsets line up with the original string.

### 1d. REFUTED: the new quote-aware tag regex drops visible text main keeps (live, flags OFF)

`onedrive-feed.ts:470` (added in b6b5f9af): `.replace(/<[a-zA-Z\/!?](?:[^>"']|"[^"]*"|'[^']*')*>/g, " ")` treats ANY
quote character inside a tag as the start of a quoted run. A browser only opens a quoted run right after `=`; a quote in
an attribute NAME or inside an UNQUOTED value is an ordinary character and the tag ends at the first `>`. So a tag with
an odd quote swallows everything up to the next matching quote (in English text, the next apostrophe) and then the next
`>`, visible text included.

| shape (synthetic) | branch | main | Chromium |
|---|---|---|---|
| `<p><b data-x=it's>Can you approve the budget? it's urgent</b></p>` | `""` -- **asks=false** | `Can you approve the budget? it's urgent` asks=true | same as main, asks=true |
| `<p><a href=mailto:o'neil@corp.example>Dana O'Neil</a> wrote to us. Can you approve the budget?</p>` | `wrote to us. Can you ...` (name dropped) | `Dana O'Neil wrote to us. Can you ...` | same as main |

Regex attribution (bun): the first input matches as ONE "tag": `<b data-x=it's>Can you approve the budget? it's urgent</b>`.
Controls that stay correct: balanced `style='font-family:"Calibri",sans-serif'` (Outlook's normal form),
`style=font-family:'Arial'`, an inch mark `alt="27" monitor"` with no later quote, a later `class="x"` pair (the
unbalanced run fails and main's plain regex takes over).

Reach: needs an apostrophe (or odd `"`) outside a quoted value in a tag AND a later matching quote before a `>`.
Uncommon in Outlook/Gmail output (they quote values), but it is a new path to a dropped visible ask on the LIVE work-email
screen with every flag OFF, and it contradicts the fix's own claim ("no row may drop a word main keeps").
Minimal fix options (propose, not implemented): (a) delete line 470 -- htmlToText's tag handling is then byte-for-byte
main's (the GT-in-alt row then leaves main's `b">` residue, which never removes an ask); or (b) only treat a quote as
opening a run directly after `=` (optionally after whitespace), as the HTML tokenizer does; or (c) let visibleHtml
replace each element's START-TAG source span (parse5 `startTag` location = the browser's own tag extent) so no regex
has to guess where a tag ends.
