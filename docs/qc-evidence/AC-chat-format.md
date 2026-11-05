<!--
WHAT:          Independent, adversarial acceptance criteria for the chat-format change (A, B, C, E; D is held).
WHY:           Owner 2026-11-05: chat stream is "raw text", inconsistent spacing, "line breaks between every
               line". Approved "do all of A-E, but hold on D". Tier 1 (it decides what text a user sees as the
               agent's words vs a system notice, and it parses free text), so it needs a cold AC set + spelling table.
SUPERSEDES:    nothing
SUPERSEDED-BY: nothing -- current
EVIDENCE:      written cold from the request + source on branch claude/vibrant-allen-p52snq @ 3a0cd80.
               VERIFY-chat-format-*.md were deliberately NOT read.
-->

# Acceptance Criteria — chat-format (A, B, C, E; D held)

**Task:** Agent chat messages render as clean, consistent rich text (A); Iris's scheduled schedule brief and priority check use a code-built list that is the same layout every day (B); new-email alerts show the draft once, in the reply card's quote box, with a short summary above it (C); runtime failure replies show as a grey system notice, not as the agent talking (E). Moving long research into a document (D) is out of scope.

**Sources read:** `lib/chat-format.ts` and `components/ChatText.tsx` (both new); the branch diff to `HuddleView.tsx` (MessageRow, EmailReplyRow), `huddle.functions.ts` (`appendBlock` input, `ensureAppendBlockDelivered`, turn endings around 7535-7576, hardReply texts at 5287 / 6788-6789, per-agent fallback suffix at 6874), `email/inbound-email.ts`, `tasks/priority-check.server.ts`, `tasks/schedule-brief-run.server.ts` (`briefDeliveryPlan`, lines 180-330); `push/turn-push.ts` (title handling only).
**Not read (gaps):** the voice or TTS path, the ceremony transcript renderer, the rest of `runHuddleTurn` for early returns before line 7535, and the 2-day Iris message corpus the implementer measured (`azure-pg-query run 42105101844`).

**Existing system this extends:** `MessageRow` already has a `m.author.kind === "system"` branch (HuddleView ~1064) that renders a grey centred notice. E should **reuse** that look and must not create a second, different notice style inside the agent bubble. The turn runner's `ensure*Delivered` end-of-turn hooks (`ensureNotSilentOnRealWork`, `ensureNavLinkDelivered`) are the existing mechanism that B's `ensureAppendBlockDelivered` extends. That is correct and is not a parallel system. There is exactly **one** formatting module (`chat-format.ts`), shared by the client and the server.

## Acceptance criteria

Observed via: **U** = unit test on `parseChatBlocks` / `noticeText` / `stripRepeatedDraft` / `joinOpenerAndBlock` / `bulletSection`. **R** = React render (testing-library or SSR string) of `MessageRow` / `ChatText`. **L** = live: a `getTurnUpdates` read of the real Iris turn plus a Playwright screenshot from `verify-uat.yml`. **D** = dry-run (`runPriorityCheck({dryRun})` / `briefDeliveryPlan`).

### A — readable formatting for every agent

| # | Given / When / Then | Cat | Via |
|---|---|---|---|
| A-1 | Given an agent reply `"Here:\n\n• a\n\n• b\n\n• c"` (a blank line between every bullet), when it renders, then there is ONE `<ul>` with 3 `<li>`, no empty `<p>`, and no `<br>` between items. | happy | U+R |
| A-2 | Given `"Here:\n• a\n• b\n• c"` (tight bullets), when it renders, then the DOM is identical to A-1. This is the core complaint: two spellings of one list must look the same. | happy | R (compare outerHTML) |
| A-3 | Given `**Up next**` mid-sentence, then it renders `<strong>Up next</strong>` and no literal `*` appears in the text content. | happy | R |
| A-4 | Given a bare `https://zoom.us/j/123?pwd=SECRET`, then it renders an `<a href="https://zoom.us/j/123?pwd=SECRET" target="_blank" rel="noopener noreferrer">`, and the visible label does not contain `pwd=SECRET`. | happy | R |
| A-5 | Given `[Agenda](https://x.com/a)`, then the link label is `Agenda` and the `[`, `]`, `(` and `)` characters are not visible. | happy | R |
| A-6 | Given `1. one\n2. two\n3. three`, then it renders an `<ol>` and the markers read 1, 2, 3. Given `3. a\n2. b\n1. c`, the markers read 3, 2, 1 (not 3, 4, 5). | happy | R |
| A-7 | The formatting applies to EVERY agent (Iris, Finn, Terry, Sam, …), to group and 1:1 huddles alike, and to `isBriefing` rows. | happy | R with 3 agent ids + `isBriefing:true` |
| A-8 | **No text is lost.** For each spelling-table input, the rendered `textContent` with whitespace collapsed equals the input with whitespace collapsed, minus only the markup characters the table says are consumed (`**`, list markers, `# `, `> `, Markdown link syntax, URL query string in the label). Every other word, number, emoji and punctuation mark is present, in order. | edge | U property test over the spelling table |
| A-9 | **No HTML injection.** Given `<img src=x onerror=alert(1)>` or `<script>`, then it renders as literal text. No element is created from it, and there is no `dangerouslySetInnerHTML` anywhere in ChatText/MessageRow. | error / security | R + grep |
| A-10 | **Only http(s) becomes a link.** `javascript:alert(1)`, `[x](javascript:alert(1))`, `data:…` and `file:///…` render as text and never as `<a>`. | error / security | R |
| A-11 | Given an empty or whitespace-only reply, the row renders without throwing, and ChatText yields no blocks. (Does an empty bubble appear? Record what happens. The baseline also rendered an empty bubble, so that is not a regression.) | edge | R |
| A-12 | Given a 16,000-character reply (`INTERNAL_TEXT_MAX`) with 400 list lines, `parseChatBlocks` finishes in < 50 ms on a laptop, and a thread of 200 such messages scrolls without visible jank. **Performance default proposed. No stated NFR exists, so the owner should confirm it.** | perf | U timed + L |
| A-13 | No horizontal overflow: a 300-character URL without spaces and a 200-character word wrap inside the bubble at 375 px width. | edge | L (Playwright mobile viewport) |
| A-14 | Paragraphs a model wrote one per blank-line-separated line (`"Line A\n\nLine B\n\nLine C"`, which is NOT a list) render with the same tight spacing the owner is asking for, OR this is explicitly declared as kept by design. The owner's complaint ("line breaks between every line") is not limited to bullets. | edge | R + L screenshot reviewed by owner |

### B — code-built schedule brief and priority check

| # | Given / When / Then | Cat | Via |
|---|---|---|---|
| B-1 | Given the same `ScheduleBrief` fixture on two runs, when `briefDeliveryPlan` runs, then `appendBlock` is byte-identical on both. The model's text affects ONLY the opener line. | happy | D |
| B-2 | Given an Iris reply that is just an opener, the final reply text is `<opener>\n\n<appendBlock>`, and it renders as: opener paragraph, then a bold-or-plain section title, then a `<ul>` per section, then the closing question. | happy | U+R |
| B-3 | Given Iris ALSO wrote her own list (`"Hello Sir, today:\n• 9:00 AM Standup\n• …"`), the final text holds each item exactly once. The model's list is cut and the code list kept. The same holds when her copy uses `-`, `1.`, `**Meetings and classes**:`, `### Meetings and classes` or no colon. | edge | U |
| B-4 | Given Iris put the items in PROSE ("you have Standup at 9 and Gym at 6."), the result is still one opener plus the block. Record whether the prose duplicates the list. **Hypothesis: it does (see H-4).** | edge | U |
| B-5 | **No scenario or excuse for the priority message not being produced.** Given the model times out, returns empty, or returns `(couldn't respond — …)` / `(fallback: …)`, then Iris's reply STILL exists, holds the full code-built block under "Hello Sir,", and keeps the "Open Priorities" / "Open Schedule" nav button. It does not render as a grey notice (that would hide the list). | error | U on `ensureAppendBlockDelivered` with each failure text + R |
| B-6 | Given every exit path of `runHuddleTurn` (chunked final, chunked partial-then-resume, sync, deadline/abort, thrown model error), the `appendBlock` is delivered exactly once on the FINAL persisted reply. It is not doubled across chunk resumes and not missing on any exit. | error | U: drive a turn with a mocked model through each exit and count block occurrences in `chat.pending_turns.replies` |
| B-7 | Given the payload's `targetAgentId` is unset, or names an agent not in `members`, the block is not silently dropped. Either it is delivered under the target, or the turn logs or fails loudly. | error | U |
| B-8 | Given a very busy week (15 meetings/day × 7 days, 40 tasks, titles of 300 characters), `appendBlock.length ≤ BLOCK_MAX_CHARS`, which is `< INTERNAL_TEXT_MAX` (16000). The turn enqueues without a zod failure, and each section ends with `…and N more — the "Open Schedule" button below shows them all.`, where N equals the hidden count exactly. | edge / perf | D with generated fixture |
| B-9 | Every time renders in exactly one spelling: `7:00 PM`, never `7:00PM`, `7PM` or `7:00 p.m.`. All-day items or tasks with no time say `any time` (or a single agreed label). | happy | D |
| B-10 | Priority check: `count=0` sends a short model message (not skipped), with no `appendBlock`. For `count=1` it says `1 open priority`, and for `count=7` with 5 shown it says `7 open priorities (2 more not shown)`. There is one "more" phrasing across all editions (the owner saw four). | happy / edge | D |
| B-11 | **Regression — the read-error brief.** Given meetings or classes fail to read, `kind:"read-error"` has NO `appendBlock`, and the message names only the failed source and does not claim it is empty. This is unchanged from main. | regression | D, diffed against main fixture |
| B-12 | `nothing-scheduled`: the opener says nothing is on, and the block (if any) contains only "Later this week" and the closing question. There is no empty `Meetings and classes:` heading. | edge | D |
| B-13 | Window editions (`brief.window` set) have no "Later this week" and no closing question, and list only what is still ahead. | edge | D |
| B-14 | Idempotency is unchanged: a retry of the same edition and day reuses the turn id and sends once. Adding `appendBlock` does not change the turn id. | regression | D |
| B-15 | The push for the brief or check is still sent, keeps its `pushStyle` title and sticky flag, and its body is the opener (or opener plus the start of the list) without literal `**`, `•`-runs that wrap to garbage, or the 16k block. | regression | U on turn-push with the final reply |

### C — email alert: draft shown once, in a quote box, with a summary

| # | Given / When / Then | Cat | Via |
|---|---|---|---|
| C-1 | Given an alert WITH a card (`emailId` set, `propose_email_reply` called), the message shows ≤ 2 short prose lines (who and what, then a close), and the draft text appears ONLY inside `[data-testid=email-reply-body]`. The count of draft-sentence occurrences on screen is 1. | happy | R + L |
| C-2 | Given the model disobeyed and pasted the draft (with or without a `Suggested reply:` / `**Suggested reply:**` label) into the prose, then the prose copy and its label are removed, and the who/what and closing lines remain. | edge | U |
| C-3 | Given the prose only PARAPHRASES the draft, or shares just `Hi Sam,` and `Best, Von` with it, the prose is left wholly unchanged. Nothing is half-stripped. | edge | U |
| C-4 | Given the prose contains a sentence that also happens to be a draft paragraph (for example "Thanks!") AND the rest of the draft is not present, the prose is unchanged. | edge (over-match) | U |
| C-5 | The quote box preserves the draft's line breaks (greeting / body / sign-off on separate lines), removes trailing-space hard breaks, and scrolls if long. The draft's words are unchanged, and the text saved to Outlook on "Save to Drafts" is the ORIGINAL `replyBody`, not the normalized display copy. | happy / regression | R + U on the save payload |
| C-6 | The owed/settled tally appears once, on the card, and not also in the prose. | happy | R |
| C-7 | **Regression — the no-card path.** Given an alert with no `emailId`, the prose still contains who/what, the full suggested reply and the close, and nothing is stripped (`stripRepeatedDraft` is not applied without `replyBody`). | regression | U+R |
| C-8 | Given Iris's prose failed (timeout, quota) but the card exists, the card with its draft and its Save to Drafts / Dismiss buttons still renders (the 2026-10-15 guarantee). | regression | R |

### E — runtime failure replies as a grey system notice

| # | Given / When / Then | Cat | Via |
|---|---|---|---|
| E-1 | Given a reply `(couldn't respond — <quota inline>)`, the row renders as a grey system notice reading `Couldn't respond — …`. The agent's avatar and name do NOT present it as the agent speaking: it matches the existing `author.kind==="system"` look, or carries a clear "system" label. | happy | R |
| E-2 | Given `(fallback: gpt-4o (TPM): Limit) couldn't reach the model — 500` and `(fallback: x) AI gateway is not configured yet.`, then both render as the notice. | happy | R |
| E-3 | Given a notice reply that carries `emailReply`, `navLink`, a confirm row or artifacts, those buttons and cards still render and still work under the notice. | regression | R |
| E-4 | A REAL reply that merely mentions the words ("I couldn't respond earlier — sorry", "(fallback plan: …)", "Fallback: use Zoom") renders as normal agent text, not as a notice. | over-match | U |
| E-5 | A real reply with the per-agent suffix `\n\n_(fallback: …)_` (huddle.functions ~6874) renders the agent text normally. The suffix shows either as a muted note or as clean text, and never with literal `_` underscores. | edge | R |
| E-6 | A notice never triggers voice TTS of the raw parenthesised error, and push for a notice-only turn is no worse than on main (record the behaviour). | regression | L / U |

### Regression guards (what must NOT change)

| # | Given / When / Then | Via |
|---|---|---|
| G-1 | User bubbles render exactly as on main: same DOM, raw text, and `whitespace-pre-wrap` kept. They do not pass through ChatText. | R, outerHTML diffed against main |
| G-2 | `author.kind==="system"` rows and CheckInCard are unchanged. | R |
| G-3 | Stored data is unchanged: `chat.pending_turns.replies[].text` and `rag_chunks` hold the agent's original text. Formatting happens at render time only, except B's deliberate `appendBlock` join. | L query |
| G-4 | Voice and ceremony paths (`useCeremonyVoice`, MeetingBar transcript, TTS input) receive the same text as before. No markup is introduced into what is spoken. | grep + U |
| G-5 | D is untouched: no change to long-research/artifact routing or `create_artifact` behaviour. The diff touches no file under `lib/artifacts/`, and no "move to document" logic is added. | git diff |
| G-6 | The existing suites pass: `test:router`, `scripts/schedule-brief.test.ts`, `priority-check.test.ts`, `inbound-email.test.ts`, plus the new `chat-format.test.ts`. | run |
| G-7 | Agent prompts are additive-only: any directive text that was removed (for example `PRIORITY_LAYOUT` and the old 3-step email order) is a replacement the owner approved under B/C. It must not be a silent removal of unrelated rules. List every removed directive line in the PR. | git diff review |

## Spelling table (Tier 1: parses agent free text)

Sources: **CM** = CommonMark 0.31.2 (§4.2 ATX headings, §4.5 fenced code, §5.1 block quotes, §5.2 list items, §6.2 emphasis, §6.3 links, §6.5 autolinks). **GFM** = GitHub Flavored Markdown spec (extended autolinks, task list items, tables). Models write in this dialect, so it is the documentation of "what an agent could plausibly produce". **GAP: neither spec was opened in this 12-minute pass.** Section numbers are cited from recall, and the red-team pre-pass must confirm each row against the spec text before turning it into a test.
"Wrong answer would be": **FP** = a FALSE PASS (markup or a broken link shown to the owner as if the message were clean) and **FR** = a FALSE REFUSAL (real text mangled, re-shaped or hidden).

| # | Input spelling (as the agent writes it) | Documented by | Expected rendering | Wrong answer would be |
|---|---|---|---|---|
| S-1 | `• a\n• b` | (house style: the directive asks for "• ") | `<ul>` with 2 items | FP |
| S-2 | `- a\n- b` / `* a\n* b` | CM §5.2 bullet list marker `-` `*` | `<ul>` with 2 items | FP |
| S-3 | `+ a\n+ b` | CM §5.2 (`+` is a bullet marker) | `<ul>` with 2 items | FP (H-10) |
| S-4 | `• a\n\n• b\n\n• c` | CM §5.2 loose list | one `<ul>` of 3, tight spacing | FP |
| S-5 | `1. a\n2. b` / `1) a\n2) b` | CM §5.2 ordered marker `.` `)` | `<ol>` 1, 2 | FP |
| S-6 | `3. a\n2. b\n1. c` | CM §5.2 (only the start number is honoured in CM; here the owner's text wins) | markers read 3, 2, 1 | FR |
| S-7 | `  - sub item` under `- item` | CM §5.2 nested list | nested `<ul>`, or flattened with the words intact (must be declared) | FR |
| S-8 | `- [ ] buy milk` | GFM task list item | checkbox or literal `[ ]`, declared; the words are intact | FP |
| S-9 | `**Up next**` / `**Up next:**` / `**Up next**:` | CM §6.2 strong emphasis | bold, no `*` visible | FP |
| S-10 | `__Up next__` | CM §6.2 (`__` is strong) | bold, OR declared as literal. Note the code deliberately leaves it literal, to protect `__init__` | FP |
| S-11 | `*note*` / `_note_` | CM §6.2 emphasis | italic or plain, no `*` / `_` visible | FP (H-3) |
| S-12 | `_(fallback: x; y)_` (the runtime's own suffix, huddle.functions ~6874) | CM §6.2 | a muted note with no literal `_` | FP (H-2) |
| S-13 | `***really***` | CM §6.2 | bold-italic or bold, no `*` visible | FP |
| S-14 | `## Today` | CM §4.2 ATX heading | heading style, no `#` | FP |
| S-15 | `## next steps` (lower-case) | CM §4.2 (case-insensitive) | heading style, no `#` | FP (H-14) |
| S-16 | `# of tasks: 5` / `#1 priority` / `#hashtag` | CM §4.2: `#1`/`#hashtag` are NOT headings (no space). `# of` IS one per CM | **over-match negative:** stays text exactly as typed (the house rule overrides CM for `# of`) | FR |
| S-17 | `> quoted line` | CM §5.1 block quote | quote style, no `>` | FP |
| S-18 | `>50% done` / `5 > 3` | CM §5.1 (`>50%` IS a quote per CM; the house rule says no) | **over-match negative:** literal text, `>` kept | FR |
| S-19 | `>` alone on a line inside a quote (`> a\n>\n> b`) | CM §5.1 | one quote of 2 paragraphs, no stray `>` | FP (H-13) |
| S-20 | `` `npm run x` `` | CM §6.1 code span | monospace, no backticks | FP |
| S-21 | ```` ```\n# Not a heading\n- not a list\n``` ```` | CM §4.5 fenced code | a preformatted block; its inner lines are NOT parsed as heading or list | FR (H-7) |
| S-22 | `https://zoom.us/j/1?pwd=SECRET` | GFM extended autolink | link; label `zoom.us/j/1`; the full href is kept | FP |
| S-23 | `See https://x.com/a.` / `(https://x.com/a)` / `https://x.com/a,` | GFM extended autolink (trailing punctuation excluded) | href is `https://x.com/a`, and the `.`, `)` or `,` stays as text | FR |
| S-24 | `https://en.wikipedia.org/wiki/Foo_(bar)` | GFM extended autolink (balanced parens kept) | href includes `(bar)` | FR |
| S-25 | `[wiki](https://en.wikipedia.org/wiki/Foo_(bar))` | CM §6.3 link destination (balanced parens) | href includes `(bar)`, and no stray `)` | FR (H-6) |
| S-26 | `<https://x.com>` | CM §6.5 autolink | link, with no `<` `>` visible | FP |
| S-27 | `**https://x.com/a**` | CM §6.2 + GFM autolink | bold AND clickable | FR (H-20) |
| S-28 | `javascript:alert(1)` / `[x](javascript:alert(1))` / `data:text/html,…` | CM §6.3 (allowed by CM, unsafe) | **negative:** text, never `<a>` | FP (security) |
| S-29 | `<b>hi</b>` / `<img src=x onerror=…>` | CM §6.6 raw HTML | **negative:** literal text, no element | FP (security) |
| S-30 | `mailto:a@b.com` / `a@b.com` / `+1 (555) 010-0000` | GFM email autolink | text (or mailto link, declared); the words are intact | FR |
| S-31 | `9:00 AM — Standup` / `7:00PM` / `7PM` / `7:00 p.m.` (code-built lists) | (house rule B-9) | one spelling, `7:00 PM` | FP |
| S-32 | `2026. What a year` / `10. That's the deadline` mid-message | CM §5.2 (an ordered list item after a paragraph must start at 1 to interrupt it) | **over-match negative:** a sentence starting `10. ` after a paragraph is NOT a list | FR |
| S-33 | `-5°F tonight` / `- 5 tasks left` | CM §5.2 (`-5` has no space so is not a list; `- 5` is one) | `-5°F` is literal text; `- 5 tasks` is a list | FR / FP |
| S-34 | `✅ Done\n✅ Next\n⚠️ Blocked` | none (not Markdown) | three lines in one paragraph, emoji intact, no merge into one line | FR |
| S-35 | `Hello Sir,\n\njust a reminder…` | (house rule: greeting re-join) | one paragraph `Hello Sir, just a reminder…` | FP |
| S-36 | `Hi Sam,\n\nthanks for reaching out…` **inside an email DRAFT (`replyBody`)** | — | **negative:** the draft's paragraph break is kept in the quote box (an email greeting on its own line is correct for a letter) | FR (H-15) |
| S-37 | `Best,  \nVon` (two-space hard break) / `Best,\\\nVon` | CM §6.7 hard line break | `Best,` and `Von` on two lines, no visible spaces or backslash | FP |
| S-38 | `\r\n` throughout / lone `\r` | CM §2.1 line ending | identical to the `\n` version | FP |
| S-39 | `| a | b |\n|---|---|\n| 1 | 2 |` | GFM tables | a table, OR declared as literal; no words lost | FP |
| S-40 | `---` alone / `***` alone | CM §4.1 thematic break | divider, or declared literal | FP |
| S-41 | `• item\n  continued on next line` | CM §5.2 continuation | one item containing both lines | FR |
| S-42 | 16,000 chars, 400 bullets, 300-char URL | — | renders < 50 ms, wraps, no overflow | FP (perf) |
| S-43 | `(couldn't respond — quota)` / `(couldn’t respond — …)` (curly apostrophe) | runtime hardReply ~6788 | grey notice | FP |
| S-44 | `(couldn't respond - quota)` (hyphen) / `(couldn't respond – …)` (en dash) | runtime-only: the em-dash spelling | stays agent text; record it (the runtime only emits `—`) | — |
| S-45 | `I couldn't respond earlier — sorry` / `(fallback plan: Zoom)` / `Fallback: use Zoom` | over-match negative | normal agent text, NOT a notice | FR |
| S-46 | `Suggested reply:` / `**Suggested reply:**` / `Suggested reply` / `Here's a reply you could send:` | (C label) | the label is removed only when the full draft is removed; the last spelling is never stripped | FR |
