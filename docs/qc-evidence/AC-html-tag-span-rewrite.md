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
Definitions used below. **branch** = `htmlToText` after the change; **main** = main's `htmlToText` (the copy at
`scripts/verify5-main/onedrive-feed.ts` on the loop-8/9 branches, used by `verify8-chromium-rows.ts`); **base** = c479cc33;
**Chromium** = the recorded `browser` / truth text. `norm` = collapse `\s+` to one space and trim. `words(s)` =
`s.toLowerCase().match(/[a-z0-9]+/g)` (the loop-8 harness's definition: it SPLITS `">Can` into `can`, so glued residue is
not a drop under it -- AC-4 adds the stricter whitespace-split check that catches glued residue). **All corpora** = loop 5
(88), loop 6 (130), impl (81), loop 8 (71), loop 9 (28) = 398 rows, plus every row of the spelling table in section 3.
**Ask** = `asksSomething` from `src/features/huddle/lib/email/inbound-email.ts` called as the loop-8 harness calls it
(`{subject:"Status", bodyPreview:null}`).

| # | Given / When / Then | Category | Observed via |
|---|---|---|---|
| AC-1 | Given the 8 loop-5 fragment rows (`GT-in-alt-inside-hidden`, `GT-in-alt-phantom-hidden`, `GT-in-title-hidden-tag`, `GT-in-href-inside-hidden`, each plain and `#quirks`), when branch converts each, then `norm(branch) === norm(Chromium)` for all 8 (base: 0 of 8). | happy-path | new assertion in `scripts/html-visible-loop5.test.ts` naming the 8 ids; mismatch list `[]` |
| AC-2 | Given fragment rows with NO hidden text (loop 8 `gt-in-dq-attr`, `gt-in-sq-attr`, `gt-in-dq-style`) and loop 6 `IFRAME-srcdoc` (+`#quirks`), when branch converts each, then `norm(branch) === norm(Chromium)`. Proves the rewrite is not skipped by the base's `if (!cuts.length) return html` early exit. | happy-path | same harness, 5 named ids, `[]` |
| AC-3 | Given all 398 rows, when branch and main both convert, then the set of rows where a `words(Chromium)` word is in `words(main)` but not in `words(branch)` is IDENTICAL to the base's set (measured base: `recon-i-fontzero`, `fontzero-attribution`, both font-size:0) -- no new id, in any corpus. | regression | `verify8-chromium-rows.ts` extended to loop 9; drop ids per set, diffed against a base run |
| AC-4 | Given all 398 rows, when branch converts, then every row where `norm(main)` contains every whitespace-split token of `norm(Chromium)` also has `norm(branch)` containing every such token. Catches a word that survives `words()` but is glued to new residue (`">Can`). | regression | harness, whitespace-split; list `[]` |
| AC-5 | Given all 398 rows, when Ask is computed on branch, main and Chromium text, then every row with `Ask(branch) !== Ask(main)` has `Ask(branch) === Ask(Chromium)`. Only allowed exception: html matching `/font-size\s*:\s*0\|font\s*:\s*0/i` AND the same flip already present on the base. Flips against Chromium outside that: **0**. | regression | harness `flipsWrong` per set = 0 |
| AC-6 | Given all 398 rows, when branch and main convert, then each row's newline count is identical (`out.split("\n").length`, on htmlToText's own output). Any differing row fails unless it is on the owner-approved list from Q2 (section 5). | regression | harness; list `[]` or exactly the Q2 list |
| AC-7 | Given reply/forward header spellings S-40..S-47 (section 3), when branch converts, then nothing at or after the marker div appears in the output, and fresh text before it does. Includes the marker div with a `>`-bearing attribute BEFORE `id` (main does not cut that one at all: `<p>a<div title="x>y" id="divRplyFwdMsg">old</div>` -> base `a y" id="divRplyFwdMsg">old`). | happy-path / regression | spelling-table assertions; onedrive-feed + correspondence-ingest suites green |
| AC-8 | Given `<blockquote cite="a>b">old words</blockquote><p>Can you sign?</p>` and `<BLOCKQUOTE TYPE=cite>old</BLOCKQUOTE>Can you sign?`, when branch converts, then the output is exactly `Can you sign?` for both. | regression | rows S-50, S-51 |
| AC-9 | Given an input for which `guardedParse` throws `ParseBudget`, when branch converts, then `branch === main` byte-for-byte. Proven with `"<div></i>".repeat(40000)+"Can you sign?"` and `"<div>".repeat(2100)+'<b title="a>b">Can you sign?</b>'` -- the latter MUST still show main's `b">` residue, proving the fallback path ran and not the rewrite. | edge | named assertions, `===` main |
| AC-10 | Given an element deeper than `MAX_DEPTH` (400) but inside the parse budget, e.g. `"<div>".repeat(450)+'<b title="a>b">Can you sign?</b>'`, when branch converts, then `Can you sign?` appears as whole whitespace tokens. Rewriting deep tags or leaving main's residue are both acceptable; the PR states which. | edge | named assertion |
| AC-11 | Given every spelling row, all 398 rows, and hostile strings (`"<".repeat(1e5)`, `"<a ".repeat(1e5)`, `'<b title="'.repeat(1e5)`, lone surrogate `"\uD800<b title='a>b'>x"`, 1 MB of `<p title="a>b">x</p>`), when branch converts, then it returns a string and never throws. | error | try/catch harness: 0 throws |
| AC-12 | Given two elements sharing one `startTag.startOffset` (reconstruction; measured: offset 18 in `<p><b title="x>y">one<p>two</p>`), when branch builds its output, then that span is replaced exactly once; output `norm` = `one two`, no `y">`, nothing duplicated. | edge (parse5 trap) | row S-30; unit assertion that replacement start offsets are unique and non-overlapping |
| AC-13 | Given rewrites and hidden-text cuts together, when branch builds its output, then outside located `startTag`/`endTag` spans every byte equals the base output: the branch changes bytes ONLY inside located tag spans. | regression | differ in the test mapping both outputs back to source offsets; 0 violations over all rows |
| AC-14 | Given the change, when `src/features/huddle/lib/external-feeds/` is read, then parse5 `parse(` runs exactly once per `visibleHtml` call; `onedrive-feed.ts`'s tag rule is still exactly `/<[^>]+>/g`; no new regex tries to find the END of a tag (no quote-run alternation such as `"[^"]*"\|'[^']*'` added). | regression (extend, not duplicate) | `git diff origin/main -- src/features/huddle/lib/external-feeds/`; grep counts |
| AC-15 | Given every sanitized tag the branch emits, then it contains no `<` or `>` other than its own two delimiters, and an `id` value containing `"`, `'`, `<`, `>` or `&` is entity-escaped or dropped, never emitted raw. A tag NAME may itself contain `<`, `"`, `'`, `=` (element `a<b` from `<a<b>`, measured); such a tag must still be removed whole by `/<[^>]+>/` (row S-23). | edge | unit assertion over all rows: collect emitted tags, 0 violations |
| AC-16 | Given end tags: a located `endTag` whose text holds a `>` early (`</p title="a>b">`) is rewritten; an implied end tag (no `endTag`) inserts nothing; a stray end tag (no node, measured) is left as main (residue allowed). | edge (parse5 trap) | rows S-25..S-27 |
| AC-17 | Given text inside raw-text / RCDATA / plaintext elements (`textarea`, `title`, `xmp`, `plaintext`, `iframe`, `noembed`, `noframes`, `script`, `style`), when branch converts, then that inner text is byte-identical to the base output (tag-looking text inside is not an element and is never rewritten). | edge (parse5 trap) | loop 6 `XMP-raw`, `TEXTAREA`; loop 8 `xmp-tags`, `textarea-att`: branch === base |
| AC-18 | Given foreign content (`svg`, `math`, `foreignObject`), `<template>` content, and WRITTEN `<html>`/`<head>`/`<body>` tags with `>` in attributes, when branch converts, then no attribute residue appears and every word of the base output that is not residue is still present. Loop 6 `MATH` stays exactly `Total x = 5 Can you sign the NDA?`. | edge | rows S-33..S-36; loop 6 MATH === base |
| AC-19 | Given the loop-9 shapes that broke earlier attempts (`data-x=it's`, `href=mailto:o'neil@host.example`, `<b class="hi"='x>`, `<span title=='x>`, `<b='x>`, `<b class="hi" ='x>`), when branch converts, then each output contains every whitespace token main shows and Ask equals Chromium's. | regression (prior failures) | loop-9 set: drops 0, flipsWrong 0 |
| AC-20 | Given the performance set (writer-measured on the base, this container, bun 1x): realistic 1.1 MB Outlook-style body 270 ms; 182 KB of `<img alt="a > b" title="c>d">w ` 22 ms; 40k `<div></i>` 12 ms (budget fallback); 300 unclosed `<b class>` + 6000 `<p>` 14 ms; 50x `<b title><i title>` + 3000 `<p>` 4 ms -- when branch converts each (median of 5, base re-measured in the same process), then each is <= 1.5x base + 20 ms and the 1.1 MB case < 1000 ms absolute. | performance | perf script checked into `scripts/`, prints both columns |
| AC-21 | Given the existing suites, when run on the branch, then `onedrive-feed-truth`, `html-visible-loop5`, `onedrive-feed`, inbound-email, redteam-correspondence, needs-you and correspondence-ingest report 0 failures; no assertion deleted or loosened (an assertion that pinned main's residue may change ONLY to the Chromium text, each listed in the PR); `npx tsc --noEmit` exit 0. | regression | suite output; reviewed test diff |
| AC-22 | Given the new tests, when mutation-proved with `scripts/mutate.sh`, then each FIRES with control EQUIVALENT: (a) remove the rewrite -> AC-1 fires; (b) place the rewrite after `if (!cuts.length) return html` -> AC-2 fires; (c) drop the duplicate-offset guard -> AC-12 fires; (d) emit the id raw -> AC-15 fires; (e) rewrite on budget fallback too (parse the partial tree) -> AC-9 fires. | guard proof | verdicts pasted in the IMPL evidence file |

Performance note: the base returns the input unchanged when nothing is hidden; after the change most bodies (any with an
attribute) are rebuilt, so the change is not free. AC-20 bounds it.

## 3. Spelling table
Source of validity: WHATWG HTML Living Standard section 13.2.5 "Tokenization": tag open, end tag open, tag name, before
attribute name, attribute name, after attribute name, before attribute value, attribute value (double-quoted) / (single-quoted)
/ (unquoted), after attribute value (quoted), self-closing start tag, bogus comment, markup declaration open, comment
start / comment start dash; 13.2.6 tree construction for reconstruction / adoption agency / implied end tags; 13.2.3.5
input preprocessing (CR/LF). **Caveat (Gaps):** this writer could not open the spec page this session (time budget); state
names are cited from recall and the state-machine reading of each row was cross-checked against parse5 7.3.0's measured
behaviour (`scratchpad/locs.ts`, `scratchpad/spell.ts`), not against Chromium. The rows marked `CHROMIUM: not recorded` must
be recorded with `scripts/html-visible-text-truth.mjs` before the verifier relies on them.

Columns: **base** = measured c479cc33 output (= main's tag handling), `norm`ed. **REQUIRED** = what the branch must output
(`norm`ed) -- binary. **Wrong answer** = direction a failure takes: FALSE REFUSAL = a visible word/ask lost (the dangerous
direction for this screen); FALSE PASS = residue or hidden/quoted text kept.

| # | Input (synthetic) | Tokenizer path that makes it valid | base | REQUIRED | Wrong answer |
|---|---|---|---|---|---|
| S-01 | `<p><b title="a > b">Can you sign?</b></p>` | attr value (double-quoted): `>` is data | `b">Can you sign?` | `Can you sign?` | FALSE REFUSAL (`">Can` glued) |
| S-02 | `<p><b title='a > b'>Can you sign?</b></p>` | attr value (single-quoted) | `b'>Can you sign?` | `Can you sign?` | FALSE REFUSAL |
| S-03 | `<p><b title=a>Can you sign?</b></p>` | attr value (unquoted): `>` ends the tag | `Can you sign?` | `Can you sign?` | FALSE REFUSAL |
| S-04 | `<p><b title=a"b>Can you sign?</b></p>` | unquoted value: `"` is a parse error but DATA, `>` ends | `Can you sign?` | `Can you sign?` | FALSE REFUSAL (loop 8/9 class) |
| S-05 | `<p><b title=it's>Can you sign?</b></p>` | unquoted value: `'` is data | `Can you sign?` | `Can you sign?` | FALSE REFUSAL (loop 8 `data-x=it's`) |
| S-06 | `<p><a href=mailto:o'neil@host.example>Lee</a> can you sign?</p>` | unquoted value with `'` | `Lee can you sign?` | `Lee can you sign?` | FALSE REFUSAL (loop 9) |
| S-07 | `<p><b ="x">Can you sign?</b></p>` | before attr name: `=` STARTS a name (parse error); `"` is a name char | `Can you sign?` | `Can you sign?` | FALSE REFUSAL |
| S-08 | `<p><b ='x>Can you sign?</b></p>` | same; `'` in name, `>` ends tag | `Can you sign?` | `Can you sign?` | FALSE REFUSAL (loop 9 `attr-name-starts-eq`) |
| S-09 | `<p><b class="hi"='x>Can you sign?</b></p>` | after attr value (quoted): `=` reconsumed in before-attr-name -> new name `='x` | `Can you sign?` | `Can you sign?` | FALSE REFUSAL (loop 9) |
| S-10 | `<p><span title=='x>Can you sign?</span></p>` | before attr value: second `=` -> unquoted value `='x` | `Can you sign?` | `Can you sign?` | FALSE REFUSAL (loop 9 `double-eq`) |
| S-11 | `<p><b='x>Can you sign?</b></p>` | tag name state: `=`, `'` are name chars -> element `b='x` | `Can you sign?` | `Can you sign?` | FALSE REFUSAL (loop 9 `tag-name-eq`) |
| S-12 | `<p><b a"b="c>d">Can you sign?</b></p>` | attr name: `"` is a name char (parse error); then `=` + double-quoted `c>d` | `d">Can you sign?` | `Can you sign?` | FALSE REFUSAL |
| S-13 | `<p><b a'b=c>Can you sign?</b></p>` | `'` in name, unquoted value | `Can you sign?` | `Can you sign?` | FALSE REFUSAL |
| S-14 | `<p><b title = "a>b">Can you sign?</b></p>` | after attr name / before attr value skip whitespace | `b">Can you sign?` | `Can you sign?` | FALSE REFUSAL |
| S-15 | `<p><b title=\n"a>b">Can you sign?</b></p>` | tag split across lines (LF is whitespace) | `b">Can you sign?` | `Can you sign?` | FALSE REFUSAL |
| S-16 | `<p><b\ntitle="a>b"\n>Can you sign?</b></p>` | LF between name/attrs/`>` | `b" >Can you sign?` | `Can you sign?` | FALSE REFUSAL |
| S-17 | `<p><b title="a\nb>c">Can you sign?</b></p>` | newline INSIDE a quoted value | `c">Can you sign?` | `Can you sign?` | FALSE REFUSAL |
| S-18 | `<p>a<br/>b<br />c<br/ >d</p>` | self-closing start tag; `/` then space -> before-attr-name | `a b c d` (newline count 1 on `a`,`b`,`c` lines: base text `a\nb\nc d`) | newline structure === base (AC-6) | line-structure drift |
| S-19 | `<p><img alt="a>b"/>Can you sign?</p>` | quoted value then self-closing | `b"/>Can you sign?` | `Can you sign?` | FALSE REFUSAL |
| S-20 | `<p><b / title="a>b">Can you sign?</b></p>` | self-closing state: `/` not followed by `>` -> reconsume as attr | `b">Can you sign?` | `Can you sign?` | FALSE REFUSAL |
| S-21 | `<p><img/alt="a>b">Can you sign?</p>` | `/` between name and attr | `b">Can you sign?` | `Can you sign?` | FALSE REFUSAL |
| S-22 | `<p><b title="a>b"/>Can you sign?</p>` | self-closing flag on a non-void element (ignored by tree builder) | `b"/>Can you sign?` | `Can you sign?` | FALSE REFUSAL |
| S-23 | `<p><a<b>Can you sign?</a<b></p>` | tag name: `<` is a name char -> ONE element `a<b` (measured) | `Can you sign?` | `Can you sign?` | FALSE REFUSAL (sanitized `<a<b>` must still be one tag to `/<[^>]+>/`) |
| S-24 | `<p><B TITLE="a>b">Can you sign?</B></p>` | ASCII upper alpha lowercased in name states | `b">Can you sign?` | `Can you sign?` | FALSE REFUSAL |
| S-25 | `<p>Can you sign?</p title="a>b">next` | END tag with attributes (parse error, attrs dropped) -- located endTag | `Can you sign? b">next` | `Can you sign? next` | FALSE REFUSAL |
| S-26 | `<p title="a>b">Can you sign?<p>next` | implied end tag: no endTag location | `b">Can you sign? next` | `Can you sign? next`, newline count === base | line-structure drift / duplicate insertion |
| S-27 | `Can you sign?</ x title="a>b">next` | end tag open + space -> BOGUS COMMENT to first `>` (not a tag) | `Can you sign? b">next` | `Can you sign? b">next` (= base; it is a comment node in parse5 -- if the base already cuts comments this row must show the comment cut: verifier records the actual) | FALSE PASS acceptable, FALSE REFUSAL not |
| S-28 | `Can you sign?</>next` | end tag open + `>`: dropped entirely | `Can you sign? next` | `Can you sign? next` | FALSE REFUSAL |
| S-29 | `a<!doctype html>b <b title="c>d">Can you sign?</b>` | DOCTYPE token in body: ignored, no node | `a b d">Can you sign?` | `a b Can you sign?` | FALSE REFUSAL |
| S-30 | `<p><b title="x>y">one<p>two</p>` | reconstruct active formatting elements: 2 `b`, ONE span (measured) | `y">one two` | `one two` | duplicate rewrite / garbled offsets |
| S-31 | `<b title="x>y"><p>one</b>two</p>` | adoption agency: clone has NO location | `y"> one two` | `one two` | FALSE REFUSAL |
| S-32 | `<a href="x>1">one<a href="y>2">two</a>` | nested `<a>`: first implicitly closed, no endTag | `1">one 2">two` | `one two` | FALSE REFUSAL |
| S-33 | `<svg><desc title="a>b">d</desc></svg>Can you sign?` | foreign content; attr states identical | `b">d Can you sign?` | `d Can you sign?` (CHROMIUM: not recorded; may hide `d`) | FALSE REFUSAL |
| S-34 | `<math title="a>b"><mi>x</mi></math> Can you sign?` | foreign content (MathML) | `b"> x Can you sign?` | `x Can you sign?` | FALSE REFUSAL |
| S-35 | `<template><b title="a>b">t</b></template>Can you sign?` | template contents (located, measured) | `b"> Can you sign?` | `Can you sign?` | FALSE PASS (residue) |
| S-36 | `<html lang="a>b"><body class="c>d"><p>Can you sign?</p></body></html>` | written html/body tags are located | `b"> d"> Can you sign?` | `Can you sign?` | FALSE PASS |
| S-37 | `<textarea title="a>b"><b>raw</b></textarea><p>Can you sign?</p>` | RCDATA: inner `<b>` is TEXT | `b"> raw Can you sign?` | `raw Can you sign?` (inner text === base, AC-17) | rewriting text inside RCDATA |
| S-38 | `a<![CDATA[x>y]]>b Can you sign?` | markup declaration open in HTML content: bogus comment to first `>` | `a y]]>b Can you sign?` | `a y]]>b Can you sign?` (= base) | FALSE REFUSAL if `y]]>b` lost |
| S-39 | `a<!-->b<!--->c Can you sign?` | comment start / comment start dash + `>`: empty comments | `a b c Can you sign?` | `a b c Can you sign?` | FALSE REFUSAL |
| S-40 | `<p>Can you sign?</p><div id="divRplyFwdMsg">From: old</div><p>old ask?</p>` | ordinary dq id | `Can you sign?` | `Can you sign?` | FALSE PASS (old ask kept -> false alert) |
| S-41 | same with `id=divRplyFwdMsg` | unquoted value | `Can you sign?` | `Can you sign?` | FALSE PASS |
| S-42 | `<p>Can you sign?</p><DIV ID='appendonsend'></DIV><p>old ask?</p>` | upper-case name+attr, sq | `Can you sign?` | `Can you sign?` | FALSE PASS |
| S-43 | `<p>Can you sign?</p><div title="x>y" id="divRplyFwdMsg">From: old</div><p>old ask?</p>` | `>` in an attr BEFORE id | `Can you sign? y" id="divRplyFwdMsg">From: old old ask?` (main does NOT cut) | `Can you sign?` | FALSE PASS (old ask surfaces as new) |
| S-44 | same with title AFTER id | | `Can you sign?` | `Can you sign?` | FALSE PASS |
| S-45 | OWA pair `<div id="appendonsend"></div><hr><div id="divRplyFwdMsg">` after the ask | | `Can you sign?` | `Can you sign?` | FALSE PASS |
| S-46 | `<p>Can you sign?</p><div data-id="divRplyFwdMsg">kept?</div>` | over-match NEGATIVE on main's reply regex (`id=` inside `data-id=`) | `Can you sign?` | see Q1 | either direction -- Q1 decides |
| S-47 | `<p>Can you sign?</p><div title="id=appendonsend">kept?</div>` | over-match NEGATIVE (marker text inside another attr value) | `Can you sign?` | see Q1 | Q1 |
| S-50 | `<blockquote cite="a>b">old words</blockquote><p>Can you sign?</p>` | dq value in blockquote | `Can you sign?` | `Can you sign?` | FALSE PASS |
| S-51 | `<BLOCKQUOTE TYPE=cite>old</BLOCKQUOTE>Can you sign?` | upper case, unquoted | `Can you sign?` | `Can you sign?` | FALSE PASS |
| S-52 | `a<br class="x">b` | `<br>` with an attribute | `a b` (main: SPACE, `<br\s*\/?>` does not match) | per Q2 (default: `a b`, newline count === base) | line-structure drift |
| S-53 | `a</p >b` | end tag with trailing whitespace | `a b` (main: space) | per Q2 (default: === base) | line-structure drift |
| S-54 | `a<script type="a>b">x()</script>Can you sign?` | raw text; script tag with `>` in attr | `a Can you sign?` | `a Can you sign?` | FALSE PASS (`x()` kept) / FALSE REFUSAL |
| S-55 | `<p>He\u0000llo <b title="c\u0000>d">Can you sign?</b></p>` | NUL in text and in a quoted value (offsets measured exact) | `He\u0000llo d">Can you sign?` | `He\u0000llo Can you sign?` | offset drift garbles text |
| S-56 | `<p>x</p>\r\n<b title="c>d">Can you sign?</b>` | CRLF preprocessing (offsets measured exact) | `x d">Can you sign?` | `x Can you sign?` | offset drift |
| S-57 | `﻿<p>\u{1F600}<b title="c>d">Can you sign?</b></p>` | mid-string BOM (after the prefix) + astral char (UTF-16 offsets) | `\u{1F600} d">Can you sign?` | `\u{1F600} Can you sign?` | offset drift |
| S-58 | `Can you sign? <b title="a>b` | EOF in attr value: token dropped, no element | `Can you sign? b` | `Can you sign? b` (= base; nothing located to rewrite) | FALSE REFUSAL if `Can you sign?` lost |
| N-01 | `<p>if a < b > c, can you sign?</p>` | OVER-MATCH NEGATIVE: tag open + space -> `<` is TEXT | `if a c, can you sign?` (main eats `< b >`) | `if a c, can you sign?` (= base; Chromium shows `if a < b > c, ...`: Q3) | the rewrite must NOT treat text as a tag |
| N-02 | `<p>5<6 so can you sign?</p>` | `<` + digit is TEXT | `5<6 so can you sign?` | `5<6 so can you sign?` | FALSE REFUSAL |
| N-03 | `<p>love you <3 can you sign?</p>` | `<` + digit is TEXT | `love you <3 can you sign?` | `love you <3 can you sign?` | FALSE REFUSAL |
| N-04 | `<p>From Lee <lee@host.example> can you sign?</p>` | `<` + letter IS a tag: element `lee@host.example` (Chromium hides it) | `From Lee can you sign?` | `From Lee can you sign?` | FALSE PASS acceptable only if the address shows whole; never a residue fragment |
| N-05 | `<p>a &lt;b title=&quot;x&gt;y&quot;&gt; can you sign?</p>` | escaped markup is TEXT; must never become a tag | `a <b title="x>y"> can you sign?` | `a <b title="x>y"> can you sign?` | FALSE REFUSAL (rewrite applied to decoded text) |
| N-06 | `<p>if a<b and it's fine, can you sign? I'd say x>y</p>` | `<b` + attrs to the first `>` IS a tag (loop 8 `text-lt-letter-apostrophe`; Chromium `if ay`) | `if a y` | `if a y` (Ask false, = base and Chromium) | FALSE PASS if `can you sign?` resurfaces |
| N-07 | `<p>Can you sign?</p><!-- <b title="a>b"> -->` | tag inside a comment is comment data | `Can you sign?` | `Can you sign?` | FALSE PASS (`b">` residue) |
| N-08 | `<xmp><b title="a>b">raw</b></xmp>Can you sign?` | RAWTEXT: inner tag is TEXT (Chromium shows it literally) | `b">raw Can you sign?` | `b">raw Can you sign?` (= base, AC-17) | rewriting inside raw text |

## 4. Goal -> AC coverage
PENDING

## 5. Open questions for the owner
PENDING
