<!--
WHAT:          acceptance criteria + spelling table for rewriting each element's tag at parse5's own
               source spans (startTag/endTag) in visibleHtml, so htmlToText's `/<[^>]+>/g` never sees a
               `>` inside an attribute value.
WHY:           main's tag rule ends a tag at the first `>`; 8 of 88 Chromium-recorded loop-5 rows differ
               from the browser only by attribute fragments like `b">`. Two regex attempts (verifier
               loops 8, 9) dropped visible words on malformed shapes. Owner approved the span-rewrite
               approach 2026-11-15.
SUPERSEDES:    nothing
SUPERSEDED-BY: nothing -- current
EVIDENCE:      base claude_task-proposals @ c479cc33; loops 7..9 on claude_verify-correspondence-proposals-7/8/9
WRITER:        independent AC-writing subagent, cold, no access to the implementer's plan.
-->

# Acceptance Criteria — html tag span rewrite (Tier 1, live work-email text path)

Status: IN PROGRESS (skeleton committed first; sections appended as written)

## 0. Sources read
- `src/features/huddle/lib/external-feeds/html-visible.ts` (whole file, base c479cc33): `guardedParse` (budget:
  `PARSE_DEPTH_LIMIT` 2000, `parseNodeLimit` = 4 x start tags + 2000, `ParseBudget` -> `return html`), `walk`
  (`MAX_DEPTH` 400 -> subtree left as source), `cutNode` (cuts TEXT/COMMENT spans only), early `if (!cuts.length) return html`,
  splice with `PREFIX.length` offset shift.
- `src/features/huddle/lib/external-feeds/onedrive-feed.ts:420-482` (`stripBlockquotes`, `decodeHtmlEntities`, `htmlToText`).
  Every downstream regex that reads a TAG: reply cut `/<div[^>]*id=["']?(divRplyFwdMsg|appendonsend)["']?[\s\S]*$/i`,
  `stripBlockquotes` `/<blockquote\b[^>]*>.../`, `/<(script|style)[\s\S]*?<\/\1>/gi`, `/<br\s*\/?>|<\/(p|div|li|tr|h\d)>/gi`,
  `/<[^>]+>/g`. Nothing else reads attributes.
- Consumers of `htmlToText`: `onedrive-feed.ts:529` (bodyText), `correspondence/forwarded.ts:44,49`, `external-feeds/teams-log.ts:103`.
  (`email/inbox-read.ts:254` has its OWN `htmlToText` -- not in scope, not touched.) `visibleHtml` has exactly one consumer.
- `scripts/onedrive-feed-truth.test.ts`, `scripts/html-visible-loop5.test.ts` (names only), fixtures
  `scripts/fixtures/html-visible-text-truth.json` (81 rows), `scripts/fixtures/html-visible-truth-loop5.json` (88 rows).
- From `origin/claude_verify-correspondence-proposals-9`: `docs/qc-evidence/VERIFY-correspondence-proposals-9.md` (claim 1d
  table, lines 46-99), `scripts/verify6-html-truth.json` (130), `scripts/verify8-chromium-truth.json` + `verify8-shapes.mjs` (71),
  `scripts/verify9-chromium-truth.json` + `verify9-shapes.mjs` (28), `scripts/verify8-chromium-rows.ts` (the comparison harness).
  Loop 7/8 reports: file lists only (time budget).

### Measured on the base (c479cc33), by this writer, in the scratchpad -- observations, not inferences
| corpus | rows | differ from Chromium (whitespace-normalised) |
|---|---|---|
| loop 5 (`html-visible-truth-loop5.json`) | 88 | 13 |
| loop 6 (`verify6-html-truth.json`) | 130 | 24 |
| impl (`html-visible-text-truth.json`) | 81 | 0 |
| loop 8 | 71 | 14 |
| loop 9 | 28 | 6 |

**The 8 loop-5 fragment rows** (base text -> Chromium): `GT-in-alt-inside-hidden` (+`#quirks`) `"\"> Can you sign the NDA?"`;
`GT-in-alt-phantom-hidden` (+`#quirks`) `"4 \">Can you sign the NDA?"` (note `">Can` glued: a word-split check reports
"Can" MISSING); `GT-in-title-hidden-tag` (+`#quirks`) `"b\" style=\"display:none\"> shown"`; `GT-in-href-inside-hidden`
(+`#quirks`) `"2&b= \"> Can you sign the NDA?"`. The other 5 loop-5 differences are NOT fragments (opacity:0%, three
`FMT-*-p-table#quirks`) and are out of scope.
**Other fragment rows the change should also fix** (same cause, other corpora): loop 6 `IFRAME-srcdoc` (+`#quirks`)
`"Wire 5000 today \"> shown"`; loop 8 `gt-in-dq-attr`, `gt-in-sq-attr`, `gt-in-dq-style` (`b">`, `y'>`, `B'">` glued to "Can").
NB loop-8 rows have NO hidden text, so the base takes the `if (!cuts.length) return html` early exit -- a rewrite placed
after that line would not reach them (AC-2).

### parse5 7.3.0 span facts, measured (`scratchpad/locs.ts`, source = `<!doctype html>` + html)
| shape | what parse5 reports |
|---|---|
| CRLF, lone CR, astral chars, NUL, mid-body BOM | startTag/endTag offsets slice the ORIGINAL string exactly (no drift) |
| `<p><b title="x>y">one<p>two</p>` (reconstruction) | TWO `b` elements share startTag offset 18 -- **duplicate span** |
| `<b title="x>y"><p>one</b>two</p>` (adoption agency) | clone `b` has NO location |
| `<p title="a>b">one<p>two` | both `p` have startTag, no endTag |
| `a</span title="x>y">b` (stray end tag) | no node at all -- span is not reported anywhere |
| html/head/body/tbody implied | no location; written `<html lang="a>b">`/`<body class="c>d">` DO have startTag+endTag |
| `<template><b title="a>b">` | the `b` inside `content` has a location |
| `<svg><desc title="a>b">` / `<foreignObject><p title="c>d">` | located, namespace svg |
| `<textarea title="a>b"><b>raw</b>`, `<plaintext ...>` | element located; inner `<b>` is TEXT (no element) |
| `<a<b>x</a<b>` | ONE element named `a<b` |
| `Can you sign? <b title="a>b` (EOF in tag) | no element (tokenizer drops it); base text `"Can you sign? b"` |
| `<![CDATA[x>y]]>` in HTML content | bogus comment ending at first `>`; inside `<svg>` it is text |
| `a<!-->b<!--->c` | comments (already cut by the base) |
| `<b title="a>b" title="c>d">` | one `attrs` entry (first wins), startTag spans both |

## 1. Existing system this extends
**Extends `visibleHtml`'s existing locate-then-splice mechanism** (html-visible.ts:205-280): the parse already runs with
`sourceCodeLocationInfo`, and the output is already "the ORIGINAL html with source spans replaced". Tag rewriting is a
second kind of span edit in the SAME splice. AC-14 forbids a second parser pass, a second tree walk over a re-parse, or a new
tag regex anywhere in `onedrive-feed.ts`. `htmlToText`'s regex chain stays as the only text converter.

## 2. Acceptance criteria
PENDING

## 3. Spelling table
PENDING

## 4. Goal -> AC coverage
PENDING

## 5. Open questions for the owner
PENDING
