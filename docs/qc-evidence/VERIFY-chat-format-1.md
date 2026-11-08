# VERIFY-chat-format-1 — independent verification of aad39f4

- WHAT: verifier findings for commit aad39f4 (branch claude/vibrant-allen-p52snq) — chat message formatting (A/B/C/E).
- WHY: independent verification requested before merge; owner-approved scope A, B, C, E (D excluded).
- SUPERSEDES: nothing. SUPERSEDED-BY: nothing -- current.
- EVIDENCE: commands + outputs below. Code under test = `git archive aad39f4` extracted to a scratch dir
  (no branch switch). aad39f4 confirmed head of origin/claude/vibrant-allen-p52snq; parent c6c4fc6.

Written incrementally, one section per criterion.

## R1 — regression suites, typecheck, build: CONFIRMED

Run from the extracted aad39f4 tree after `npm ci --ignore-scripts` (rc=0):
- `bun scripts/schedule-brief.test.ts` -> `78 passed, 0 failed`
- `bun scripts/priority-check.test.ts` -> `47 passed, 0 failed`
- `bun scripts/inbound-email.test.ts` -> `72 passed, 0 failed`
- `bun scripts/chat-format.test.ts` -> `38 passed, 0 failed`
- `bun scripts/schedule-brief-dedupe.test.ts` -> `21 passed, 0 failed`
- `bun scripts/router-winners.test.ts` -> `39 passed, 0 failed`
- `npx tsc --noEmit -p .` -> no output, `rc=0`
- `npm run build` -> nitro "You can deploy this build", `rc=0`

## A1 — agent bubble renders elements, no HTML injection, http(s)-only links: CONFIRMED

- `HuddleView.tsx` agent branch now renders `<ChatText text={bodyText} />` (was `{m.text}`); the
  `whitespace-pre-wrap` class was removed from that wrapper (diff of aad39f4).
- `ChatText.tsx` emits only React nodes: `<p>`, `<ul>/<ol>/<li>`, `<blockquote>`, `<strong>`, `<code>`,
  `<a href target=_blank rel="noopener noreferrer">`. `grep dangerouslySetInnerHTML` over ChatText.tsx,
  HuddleView.tsx, chat-format.ts -> no matches.
- Link regex (chat-format.ts:84-85) only admits `https?://`. Scratch adversarial run (`bun scripts/zz-adv.test.ts`,
  not committed):
  - `[click](javascript:alert(1))` -> `[{"t":"text",...}]` (no link)
  - `javascript:alert(1)`, `data:text/html,<b>x</b>`, `HTTPS://UPPER.com` -> text only
  - `<script>alert(1)</script> **b**` -> text node + bold; rendered as escaped text by React
  - `[ok](https://a.com"onmouseover=alert(1))` -> link with href `https://a.com"onmouseover=alert(1` —
    href is set via a React attribute, so the quote is escaped; not exploitable.
- Minor (not a security issue): `https://en.wikipedia.org/wiki/Foo_(bar)` -> link to `.../Foo_` with
  `(bar)` left as text (URLs containing parentheses are truncated, chat-format.ts:85 excludes `()`).

## A2 — blank lines between bullets -> one list; words never altered; user bubble unchanged: PARTIALLY REFUTED

- CONFIRMED: `"Hello Sir,\n\n• a\n\n• b\n\n\n• c\n\nDone?"` -> p, ONE `ul` [a,b,c], p. Mixed `- a\n\n* b\n\n• c` -> one ul.
- CONFIRMED: user bubble (`HuddleView.tsx` ~line 1050, `m.author.kind === "user"`) still renders `{m.text}`,
  untouched by the diff.
- REFUTED ("words are never altered") — characters/numbers the agent wrote are dropped or changed:
  1. **Ordered lists are renumbered.** `"1. first\n2. second\n\nSome note\n\n3. third"` -> two `ol` blocks;
     ChatText renders `<ol>` with no `start` attribute (ChatText.tsx:59-76), so "3. third" displays as "1. third".
     `"5. five\n6. six"` displays as "1. five / 2. six". The parser discards the original number
     (`line.replace(LIST_RE, "")`, chat-format.ts:148).
  2. **`>` at line start is eaten.** `">50% of tasks done"` -> quote block with text `"50% of tasks done"` (meaning inverted
     from "more than 50%" to "50%"). chat-format.ts:21 `QUOTE_RE = /^\s{0,3}>\s?/`.
  3. **`#` at line start is eaten.** `"# of tasks: 5"` -> heading `"of tasks: 5"`. chat-format.ts:20.
  4. **`__x__` becomes bold, underscores dropped.** `"call __init__ then __main__"` -> bold "init", bold "main".
  Severity: low-medium. (1) is the most plausible in real agent output (numbered steps split by a note).

## A3 — non-Markdown text not mis-parsed: CONFIRMED with minor exceptions

- `"**Up next** is the dentist at 3."` -> p with bold "Up next" + text (NOT a bullet). `"**Today**\n• 9:00 AM standup"` -> bold p + ul.
- Hyphenated words (`well-known`, `-ish thing`, `non-stop`) -> plain paragraph lines.
- Times (`7:00 PM dinner`, `10:30 AM call`) -> plain lines. `"2026. A big year"` -> plain.
- Email sig `"Thanks,\n-- \nVon\nCEO"` -> plain lines (the `--` is not a bullet).
- Plain sentences -> single p.
- Exceptions (mis-parses): `"Best,\n- Von"` (dash-signed signature) -> a one-item bullet list "Von";
  `">50%..."` and `"# of tasks"` (see A2); `"5 * 3 = 15\n* note"` -> "* note" becomes a bullet (arguably intended).

## B1 — code-built list attached at BOTH turn endings, before navLink; no double list; delivered on empty/quota: REFUTED (one delivery-blocking defect), otherwise confirmed

Confirmed parts:
- `ensureAppendBlockDelivered` (huddle.functions.ts ~7284-7295) is called in the chunked terminal path
  (~7556, after `ensureNotSilentOnRealWork`, BEFORE `ensureNavLinkDelivered`) and the sync path (~7569, same order).
  `replies` is seeded from `resume.replies` (huddle.functions.ts:1886), so a target reply from an earlier chunk is found.
- Both producers set the payload: schedule-brief-run.server.ts (`...(plan.appendBlock ? { appendBlock } : {})`,
  `targetAgentId: BRIEF_OWNER` line 437); priority-check.server.ts (`...(appendBlock ? { appendBlock } : {})`,
  `targetAgentId: owner` line 230).
- Scratch run (`bun scripts/zz-brief.test.ts`) of `briefDeliveryPlan` morning edition -> block =
  "Meetings and classes:" bullets, "On your task list:" bullets, "Later this week:" bullets, closing question.
  `priorityAppendBlock` -> 3 bullets, "7 open priorities (4 more not shown): 2 past due, 1 not yet scheduled.", closing ask.
  Empty band -> `undefined` (stays model-written).
- Empty / quota: `joinOpenerAndBlock("", "• a")` and `joinOpenerAndBlock("(couldn't respond — quota)", "• a")`
  both -> `"Hello Sir,\n\n• a"`. If no target reply exists, a new reply is pushed with the block.
- No double list when the model wrote a marked list: `joinOpenerAndBlock("Hello Sir, top items:\n1. A\n2. B", "• A\n• B")`
  -> `"Hello Sir, top items:\n\n• A\n• B"`; a model copy of a section header ("Today:") is also cut.

**DEFECT B1-a (delivery-blocking): the block can exceed its schema cap and the brief is then never sent.**
- `Input.appendBlock: z.string().max(3500)` (huddle.functions.ts:294). The durable runner does
  `const data = Input.parse(record.payload)` (huddle.functions.ts:7990) inside a try whose catch is
  `failTurn(record.id, ...)` (~8116). `enqueueTurn` (turns.server.ts ~197-207) inserts the payload with NO validation.
- The block includes ALL of today's items, ALL tasks and ALL "later this week" items (6-day lookahead,
  schedule-brief.server.ts:439-454, no cap). Scratch `bun scripts/zz-cap.test.ts` (4 meetings today, 5 tasks,
  N meetings/day for the next 6 days, realistic titles, Teams location on half):
  ```
  meetings/day=3 upcoming=18 appendBlock.length=2297 over3500=false
  meetings/day=4 upcoming=24 appendBlock.length=2948 over3500=false
  meetings/day=5 upcoming=30 appendBlock.length=3431 over3500=false
  meetings/day=6 upcoming=36 appendBlock.length=4070 over3500=true
  ```
  At ~6 meetings/day the whole brief turn fails Zod parsing -> `failTurn` -> NO message, NO button. The turn id is
  idempotent per edition per day, so it is not retried. Before aad39f4 the same lists rode in `text`
  (`INTERNAL_TEXT_MAX = 16000`, huddle.functions.ts:220), so this is a NEW failure mode introduced by the commit.
  (Inference, not run live: the Zod rejection itself is standard `max()` behaviour; the cap/path are read from source.)

Gap B1-b (minor): a model list written WITHOUT markers is still shown twice. `joinOpenerAndBlock("Hello Sir,\n\n**Today**\n9 AM standup\n3 PM dentist", "Today:\n• 9:00 AM standup")`
-> keeps the model's bold header + unmarked lines and appends the block. A bold copy of a header (`**Today:**`) is
also not recognised as the header (`openerOnly` compares the raw trimmed line). Low likelihood since the
directive now says "ONE sentence only".

## B2 — window brief: no "later this week", no question; empty day: no "nothing scheduled" bullet: CONFIRMED

Scratch `bun scripts/zz-brief.test.ts`:
- window with items + upcoming week -> block is ONLY "Meetings and classes:\n• 7:00 PM–10:00 PM — MGT-782-W1 (class)" (no week, no question).
- window, nothing scheduled -> `appendBlock` = none.
- empty day, no week -> block is only the closing question; empty day with week -> "Later this week:" + question.
  No bullet anywhere reads "nothing scheduled" (`bulletSection` returns "" for empty input, chat-format.ts:271-275).
- Existing test J4 (`a window heads-up carries no question`) passes in schedule-brief.test.ts.

## B3 — read-error kind unchanged: CONFIRMED

- `git show aad39f4 -- .../schedule-brief-run.server.ts` has no hunk inside the `if (!hasAny && brief.errors.length)` branch;
  it returns `{ kind: "read-error", directive }` with no `appendBlock`.
- Scratch: `briefDeliveryPlan(mk({ items: [], errors: ["classes: http_500"] }))` -> `kind=read-error`, block `(none)`.

### A1/A2 addendum — real React render (react-dom/server, `bun scripts/zz-render.test.tsx`)

Input `"Hello Sir,\n\n• **Up next**: standup at 9:00 AM\n\n• Join https://zoom.us/j/1?pwd=x\n\n1. one\n2. \`two\`\n\n[bad](javascript:alert(1)) <img src=x onerror=alert(1)>"` ->
`<p>Hello Sir,</p><ul ...><li><strong>Up next</strong>: standup at 9:00 AM</li><li>Join <a href="https://zoom.us/j/1?pwd=x" target="_blank" rel="noopener noreferrer" ...>zoom.us/j/1</a></li></ul><ol ...><li>one</li><li><code ...>two</code></li></ol><p>[bad](javascript:alert(1)) &lt;img src=x onerror=alert(1)&gt;</p>`
— one `ul` despite blank lines, HTML escaped, javascript: not a link.
Input `"1. first\n\nnote\n\n3. third"` -> `<ol><li>first</li></ol><p>note</p><ol><li>third</li></ol>` — second `<ol>`
has no `start`, so the browser shows "1. third" (confirms A2 defect 1). Not run in a browser (no Playwright on the deployed app).

## C1 — email alert directive with/without card; render-time strip only on strong match: PARTIALLY REFUTED

Confirmed parts (`bun scripts/zz-email.test.ts`, which imports the OLD c6c4fc6 `inboundEmailDirective` from the base worktree and the NEW one from aad39f4):
```
{} identical: true len old/new 872 872
{"owed":5,"settledToday":2} identical: true len old/new 990 990
{"emailId":"e1"} identical: false ...
{"emailId":"e1","owed":5,"settledToday":1} identical: false ...
```
- WITHOUT a card the directive is byte-identical to before (incl. "2. A suggested reply ..." and "Mention the owed count").
- WITH a card it says "Write ONLY two short lines ... Do NOT write the suggested reply in your message ... ONLY in
  propose_email_reply's reply_body" and "The card under your message already shows this count, so do not repeat it."
- Long body with card still fits: length 3899 <= DIRECTIVE_MAX 3900.
- Cosmetic: the card directive contains "...a placeholder he can change., ONLY in propose_email_reply's reply_body" (stray ".,").
- Render-time strip (`HuddleView.tsx` MessageRow: `m.emailReply?.replyBody ? stripRepeatedDraft(m.text, ...) : m.text`):
  exact copy is removed incl. the "Suggested reply:" label -> `"Sam Lee from Acme wants to meet this week.\n\nTap Save to Drafts."`.
  Empty `replyBody` -> no strip. A 1-of-3 match -> unchanged.

**DEFECT C1-a: strips on a PARTIAL match and leaves an orphaned draft fragment.** `stripRepeatedDraft` (chat-format.ts:206-230)
counts paragraph hits and strips when `hits*2 >= bodyParas.length`. The greeting ("Hi Sam,") and sign-off ("Best,\nVon")
are generic paragraphs that match even when the real content differs. `bun scripts/zz-strip.test.ts`:
- card = `"Hi Sam,\n\nThursday at 2 PM works for me (a placeholder, happy to move it).\n\nBest,\nVon"`
- prose draft paraphrased the middle line -> result:
  `"Sam Lee from Acme wants to meet this week.\n\nThursday at 2 PM works for me — happy to move it if needed.\n\nTap Save to Drafts, or tell me what to change."`
  The greeting, label and sign-off are removed but the draft body remains, so it now reads as Iris speaking in Von's first person.
  This is a 2-of-3 match on the two content-free paragraphs, which is exactly the "weak/partial match" the AC forbids.
  Also a 2-paragraph card where only "Best,\nVon" matches (1 of 2 = half) strips the sign-off from the prose.

## E1 — runtime failure replies render as a named grey notice; mid-sentence not matched: PARTIALLY REFUTED

Confirmed parts (`bun scripts/zz-adv.test.ts`):
- `(couldn't respond — OpenAI is out of API quota — agent routing.)` -> notice "Couldn't respond — OpenAI is out of API quota — agent routing."
- `(fallback: model call failed: x) couldn't reach the model — boom` -> notice (returned as-is).
- curly apostrophe and leading whitespace also match. `"Sorry, I couldn't respond — the calendar was down."` -> `null` (not a notice).
- HuddleView renders `<div data-testid="agent-notice" class="... bg-muted/50 ... text-muted-foreground"><span>{agent.name}</span> · {notice}</div>`.
- The formats match the producers at huddle.functions.ts:6786-6787.

**DEFECT E1-a (regression): the notice row drops the buttons that a failure reply carries.** The notice branch in
`MessageRow` (HuddleView.tsx, right after `const notice = noticeText(m.text)`) `return`s ONLY the grey div, so
`m.emailReply` (EmailReplyRow), `m.navLink` (NavLinkButton), `m.confirmAsk`, `m.checklist`, artifacts and tool chips are
never rendered for that message. But the runtime deliberately attaches these to failure replies:
- `mergeAgentResult` hardReply branch: `const card = emailCardFor(nextId, r.toolUses); replies.push(card ? { ...outcome.reply, emailReply: card } : outcome.reply)`
  (huddle.functions.ts ~6836-6840). Its own comment: "Used by EVERY path that pushes a reply (normal, hardReply, ...):
  2026-10-15 Amy's alert lost its buttons because Iris timed out". With this commit, a new-email alert during a quota
  outage again shows NO Save to Drafts / Edit first / No reply needed buttons.
- `ensureNavLinkDelivered` attaches the navLink to the target reply "wherever it was built (normal, hardReply)" (~7262-7278).
  For a priority check with an EMPTY band (no appendBlock, so the notice text is not replaced) or a schedule brief with no
  block (empty window, read-error), a quota failure now renders without the "Open Priorities"/"Open Schedule" button —
  against the owner's 2026-10-16 "There is no scenario or excuse for priority message not being produced".
  (When an appendBlock exists, `joinOpenerAndBlock` replaces the notice text, so those runs are unaffected.)
- Gap E1-b (minor, outside the AC's two listed forms): `(fallback: ${ev.inline}) AI gateway is not configured yet.`
  (huddle.functions.ts ~5285) is also a runtime failure reply and is NOT recognised (`noticeText` -> null).
- Contrived edge: a model reply that itself begins "(couldn't respond — I was on a call) Anyway..." becomes a notice. Unlikely.

## R2 — other consumers: one regression (E1-a) plus B1-a; nothing else worse

- `briefDeliveryPlan` / `runScheduleBrief`: only consumer is `src/routes/api/public/run-schedule-brief.ts`, which returns
  the result as JSON (now with `appendBlock` on dryRun). `.github/workflows/run-schedule-brief.yml` and `run-priority-check.yml`
  make no assertions on the directive text (grep for jq/grep/"Later this week" -> only request-body building).
- `priorityCheckDirective` / `runPriorityCheck`: consumers are `run-priority-check.ts` route and `runPriorityCheckNowFn`
  (scheduling-config.functions.ts:72-86) — pass-through, unaffected.
- `inboundEmailDirective`: only `inbound-email.server.ts:171` — unaffected beyond the intended directive change.
- Turn payload schema: new optional `appendBlock` with `.max(3500)` — see **B1-a** (busy week fails the whole durable turn).
- Push text: the runner's push body is `String(lead.text).replace(/\s+/g, " ").slice(0, 140)` (huddle.functions.ts ~8056).
  For briefs it is now the model's one-sentence opener (+ start of the block) — no worse. Notices push their raw text as before.
- Voice: `useVoiceCallRealtime*.ts`, `useGroupVoice.ts`, `MeetingBar.tsx` read reply text but were not changed; the changed
  texts are scheduled/email-alert turns, which are not voiced. No change in what is spoken.
- Copy button still copies raw `m.text` (incl. a draft that is hidden by `stripRepeatedDraft`) — acceptable, unchanged.
- Partial chunks (`streamChunk`) persist the model's own text before `ensureAppendBlockDelivered` runs at the end, so a viewer
  may briefly see the model's version before the final one (inference from code order; not observed).

## Verdict

PASS: R1, A1, A3 (minor exceptions), B2, B3 | FAIL: B1 (B1-a, block > 3500 chars kills the brief), C1 (C1-a, partial-match strip),
E1 (E1-a, notice hides email/nav buttons), A2 (renumbered ordered lists; `>`/`#`/`__` eaten) | UI-UNVERIFIED: browser render of
ChatText/notice/email card in the deployed app (SSR render only).

**Overall verdict: FIX FIRST — B1-a and E1-a are delivery regressions (lost brief / lost buttons); C1-a and A2 are display defects.**
