# VERIFY chat-format, loop 5

- WHAT: independent verification of deventerpriseds-org/huddle-extension-app 38f5833 (PR #149), loop 5
- WHY: new commits since loop 4 (cca0cf1 italics/fences/+/##/bare >/raw reply card; 38f5833 clipErr)
- SUPERSEDES: docs/qc-evidence/VERIFY-chat-format-4.md (for the subject 38f5833)
- SUPERSEDED-BY: nothing -- current
- EVIDENCE: scratch scripts scripts/zz-v5.tsx, scripts/zz-v5b.ts (not committed); outputs quoted below

Subject checked out at 38f5833 (`git checkout -B claude_verify-chat-format-5 origin/claude/vibrant-allen-p52snq`).
Renderer: `react-dom/server` `renderToStaticMarkup(<ChatText text=…/>)`, every AC spelling row S-1..S-46 plus 30 attack rows.

## R1 suites / tsc / build -- CONFIRMED
`bun scripts/<t>.test.ts`: chat-format 81 passed 0 failed; schedule-brief 85/0; priority-check 47/0;
inbound-email 72/0; schedule-brief-dedupe 21/0; router-winners 39/0. `npx tsc --noEmit -p .` -> `tsc rc=0`.
`npm run build` -> `build rc=0`. `grep -c '(?<'` chat-format.ts / ChatText.tsx -> 0 / 0 (no lookbehind).

## A1 rendering -- REFUTED (3 AC rows fail, none declared)
Holds: no injection (S-29 `<b>hi</b>` -> `&lt;b&gt;hi&lt;/b&gt;`; `*<img src=x onerror=…>*` -> `<em>&lt;img …&gt;</em>`);
only http(s) becomes `<a>` (S-28 javascript:/data: stay text); S-22..S-25 hrefs correct incl. `Foo_(bar)`;
S-11 `*note*`/`_note_` -> `<em>`; S-12 `_(fallback: x; y)_` -> `<em>(fallback: x; y)</em>`; S-14/S-15/X `# Today` headings;
S-17/S-19 quotes; S-20 code; S-21 fence -> `<pre>` with inner `# Not a heading`/`- not a list` unparsed; S-42 149,490 chars in 42.8 ms;
pathological `_`/`*` inputs (20k chars) 1.3 ms total (no ReDoS).

Fails:
- **S-13 `***really***` -> `<p>*<strong>really</strong>*</p>`** -- literal `*` on both sides. AC: "bold-italic or bold, no `*` visible"
  (FP). This is half of H-3, which cca0cf1 says it fixed ("italics"); `***x***` was not fixed. Same for `**_y_**` -> `<strong>_y_</strong>` (literal `_`).
- **S-27 `**https://x.com/a**` -> `<strong>https://x.com/a</strong>`, no `<a>`** -- AC: "bold AND clickable" (H-20, unaddressed).
- **S-26 `<https://x.com>` -> `&lt;<a …>x.com</a>&gt;`** -- AC: "no `<` `>` visible".
- Minor (no AC row): `text ```inline``` text` -> visible ``` `` ``` around a `<code>`; bare `>` alone -> an empty `<blockquote>`.

## A2 lists/numbers/words never altered -- CONFIRMED (with one note)
S-6 `3. a\n2. b\n1. c` -> `value="3" "2" "1"`; `5. *a*\n7. _b_\n2. c` -> nums [5,7,2]; S-33 `-5°F` literal, `- 5 tasks` list;
`+1 on that` stays text, `+ 5 more` is a list; S-34 emoji lines intact; S-38 CRLF identical. Italics never ate a word:
`2*3*4`, `a * b * c`, `5*x*y`, `snake_case_name`, `my_var_`, `_private`, `__init__`, `report_final_v2.docx`, `*.ts`, `rm *.log *.tmp`,
`~/a_b_/c`, `von_ellis@enterpriseds.io`, `https://x.com/a_b_c_d`, `https://x.com/_a_` all render unchanged.
Note: `normalizeChatText` runs BEFORE fence detection, so whitespace INSIDE a ``` fence is rewritten: ```` ```\na\n\n\n\nb\n``` ```` -> `a\n\nb`,
```` ```\n- a\n\n- b\n``` ```` -> `- a\n- b` (blank line removed). Words intact; code whitespace not preserved.

## A3 plain text not mis-parsed -- REFUTED (1 AC row)
Holds: S-16 `# of tasks: 5`, `#1 priority`, `#hashtag`, `##nospace`, `####### seven` stay text; S-18 `>50% done`, `5 > 3` stay text;
S-30 mail/phone intact; X-bul `* not italic*` -> list item `not italic*` (no em).
Fails: **S-32 `Note here.\n10. That's the deadline` -> `<p>Note here.</p><ol start="10"><li value="10">That's the deadline</li></ol>`**.
AC S-32 (FR, over-match negative): a sentence starting `10. ` after a paragraph is NOT a list. Words intact, shape changed.

## B1 code-built list delivered once; payload never fails on size -- CONFIRMED (with one note)
`joinOpenerAndBlock` x5 openers (plain, `+ ` copy, `* ` copy, fenced copy, fallback notice): `9:00 AM — Standup` appears exactly 1x each.
clipErr: schedule-brief K6 (5,000-char errors -> directive < 16000 and no 300-char run) passes; clip is applied to `brief` before every branch;
`errors` grows by one per source (bounded), `upcomingErrors` sliced to 5.
Note (new interaction from cca0cf1 fences): opener `Morning.\n```\n• 9:00 AM — Standup\n```` is cut at the bullet, leaving a dangling ```` ``` ````;
`parseChatBlocks(joined)` -> `["p","pre"]` -- the code-built list renders as raw monospace text, not a list. And a fenced NON-bullet copy
(```` ```text\n9:00 AM Standup\n``` ````) is kept, so the schedule shows twice (`["p","pre","p","ul"]`). Low likelihood; words intact.

## B2 window/empty-day brief -- CONFIRMED (re-check depth)
schedule-brief suite 85/0 at 38f5833; the only change in that file is clipErr (above), which does not touch the window/empty branches.

## B3 read-error brief unchanged -- CONFIRMED (re-check depth)
K6 exercises the read-error branch with clipped errors; suite 85/0. Wording unchanged except errors > 200 chars now end in `…`.

## C1 email draft once / full-match strip / card shows exact draft -- CONFIRMED
HuddleView diff: `{normalizeChatText(ask.replyBody)}` -> `{ask.replyBody}` in `data-testid="email-reply-body"` (whitespace-pre-wrap),
so S-36 `Hi Sam,\n\nthanks…` keeps its break in the card. `stripRepeatedDraft`: full match -> `"Here's a draft."`; partial match ->
text unchanged; `*Suggested reply:*` label also removed on a full match.

## E1 failure notice keeps the row's buttons -- CONFIRMED (re-check depth)
No change to the notice row since c57018f (HuddleView diff touches only the import and the email card body). `noticeText`:
`(couldn't respond — quota)` / curly apostrophe -> notice; hyphen variant, `I couldn't respond earlier — sorry`, `(fallback plan: Zoom)`,
`Fallback: use Zoom` -> null (agent text).

## R2 other consumers -- CONFIRMED
Server importers of chat-format: huddle.functions (`joinOpenerAndBlock`), priority-check + schedule-brief-run (`bulletSection`, `spacedClock`)
-- unchanged functions; `+` in LIST_RE only adds a cut point in `openerOnly` (tested above). 63fbb38 merge touches AppsLauncher/Rail/ViewSwitcher
only; none imports chat-format or ChatText. tsc + build pass.

Overall verdict: FIX FIRST — S-13 `***x***` literal asterisks (H-3 claimed fixed), S-27 bold URL not clickable, S-26 visible `<` `>`, S-32 `10. ` sentence becomes a list
