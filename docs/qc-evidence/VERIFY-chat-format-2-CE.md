# VERIFY chat-format loop 2 — slice C1 + E1
# WHAT:       Independent re-verification of claims C1 and E1 of PR #149 at c335e3c.
# WHY:        Loop 1 (VERIFY-chat-format-1.md) refuted C1-a (partial-match strip) and E1-a/E1-b.
# SUPERSEDES: nothing. SUPERSEDED-BY: nothing -- current.
# EVIDENCE:   scratch scripts scripts/zz-ce2.test.ts, scripts/zz-c1dir.test.ts (not committed).

Subject: c335e3c. Suites re-run here: `bun scripts/chat-format.test.ts` -> 49 passed, 0 failed;
`bun scripts/inbound-email.test.ts` -> 72 passed, 0 failed.

## C1 — REFUTED (two residual defects, both small)

Directive (re-check, reduced depth), `bun scripts/zz-c1dir.test.ts`, OLD imported from `git show c6c4fc6:...inbound-email.ts`:
- no card `{}` byte-identical to c6c4fc6: true; no card `{owed:5,settledToday:2}` identical: true.
- with card: "Write ONLY two short lines ... Do NOT write the suggested reply in your message ... ONLY in
  propose_email_reply's reply_body"; owed line ends "The card under your message already shows this count, so do not repeat it."
  Loop-1 cosmetic stray ".," is gone. Long body with card: 3899 <= DIRECTIVE_MAX 3900.

Strip (full re-derivation), `bun scripts/zz-ce2.test.ts`:
- loop-1 partial case (greeting + sign-off match, middle paraphrased): returned UNCHANGED (true). 2-paragraph card,
  sign-off-only match: UNCHANGED (true). C1-a as reported in loop 1 is fixed.
- FULL match with "Suggested reply:" label and `Best,  \nVon` (trailing spaces):
  -> `"Sam Lee from Acme wants to meet this week.\n\nTap Save to Drafts."` (strips, correct). Label inline
  (`Suggested reply: Hi Sam,`) -> `"Sam wants to meet."` (correct). Empty replyBody -> unchanged.
- **C1-b (new, AC violated: strips on a non-full match).** `stripRepeatedDraft` compares `hits` (count of PROSE
  paragraphs that matched) against `bodyParas.length`, not the number of DISTINCT draft paragraphs found. A generic
  draft paragraph appearing twice in the prose fills the count. Card `"Hi Sam,\n\nThursday at 2 PM works for me (a
  placeholder, happy to move it).\n\nBest,\nVon"`, prose `"Hi Sam,\n\nSam wants to meet.\n\nHi Sam,\n\nThursday
  works, happy to move it.\n\nBest,\nVon"` -> `"Sam wants to meet.\n\nThursday works, happy to move it."` — the
  paraphrased draft middle is left orphaned, the exact loop-1 C1-a shape. Needs a repeated paragraph, so uncommon.
  chat-format.ts `if (hits < bodyParas.length) return text;` — count distinct matched paragraphs instead.
- **C1-c (display): a bold label is orphaned.** Prose with `**Suggested reply:**` on its own line + exact draft ->
  `"Sam wants to meet.\n\n**Suggested reply:**"`. The label filter `/^suggested reply:?$/i` does not allow `**`.

## E1 — CONFIRMED for E1-a; E1-b REFUTED in part

- **E1-a fixed (code read, HuddleView.tsx MessageRow 1025-1160).** `const notice = noticeText(m.text)` no longer
  returns early; the notice only swaps the text slot (`notice ? <div data-testid="agent-notice" class="rounded-lg
  bg-muted/50 ... text-muted-foreground">{notice}</div> : <ChatText text={bodyText} />`). Artifacts, toolUses chips,
  checklist, priorities, schedule, `confirmAsk` (ConfirmAskRow), overrideAsk, `emailReply` (EmailReplyRow) and
  `navLink` (NavLinkButton) all render after it unconditionally. SSR render NOT RUN (MessageRow is not exported and
  pulls the store); the structure is unambiguous from source. Agent name still shown in the header row.
- Producers (grep of all of `src` for `(fallback: ${` and `couldn't respond`): huddle.functions.ts 5287
  `(fallback: ${ev.inline}) AI gateway is not configured yet.`, 6788 `(couldn't respond — ${QUOTA_OUTAGE_INLINE})`,
  6789 `(fallback: ${ev.inline}) couldn't reach the model — ${msg}`, 6874 trailing `_(fallback: …)_` on a REAL reply
  (correctly not a notice: `"Done.\n\n_(fallback: x)_"` -> null). No other producer.
- noticeText results: quota form -> "Couldn't respond — OpenAI is out of API quota — agent routing."; gateway form ->
  notice; 500 JSON form -> notice; "Sorry, I couldn't respond — ..." -> null; mid-sentence "(fallback: none)" -> null.
- **E1-b residual: a `)` inside `ev.inline` defeats the match.** Regex `/^\(fallback: [^)]*\) /` needs the FIRST `)`
  to be followed by a space. 6789's inline is `model call failed: ${msg.slice(0, 80)}` — any error message with a
  parenthesis in its first 80 chars (e.g. a TypeError `Cannot read properties of undefined (reading 'x')`, or
  `... gpt-4o (TPM): ...`) is NOT a notice. Observed: `"(fallback: model call failed: OpenAI Responses 429: Rate
  limit reached for gpt-4o (TPM): Limit) couldn't reach the model — x"` -> null, so it renders as the agent speaking.
