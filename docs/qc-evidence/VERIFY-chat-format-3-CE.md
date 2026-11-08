# VERIFY chat-format loop 3, slice CE (C1 + E1)

WHAT: independent re-verification of claims C1 (email-draft directive + render-time strip) and E1 (runtime failure notices) at 3a0cd80.
WHY: loop 2 refuted C1-b, C1-c and E1-b. 544c002 says it fixes them. This loop re-derives each one.
SUPERSEDES: nothing (loop 2 reports stay as history).
SUPERSEDED-BY: nothing (current).
EVIDENCE: scratch harness `scripts/zz-ce3.ts` (not committed), run with bun at 3a0cd80.

## Suites at 3a0cd80
- `bun scripts/chat-format.test.ts` -> 64 passed, 0 failed
- `bun scripts/inbound-email.test.ts` -> 72 passed, 0 failed

## C1-a directive: CONFIRMED
- With a card (`emailId`): the directive says "Do NOT write the suggested reply in your message" and "ONLY in propose_email_reply's reply_body". There is no "2. A suggested reply" step, and it says "do not repeat it" about the owed count, with no "Mention the owed count" line.
- Without a card: the output is byte-identical to `git show c6c4fc6:.../inbound-email.ts` for three inputs: with owed/settled, with no ctx, and with a 50,000-character body (truncation path). All three `===` true.

## C1-b distinct paragraphs: CONFIRMED (loop-2 input reproduced)
- The prose has "Hi Sam," twice plus the full draft. Result: `"Sam wants lunch.\n\nTap Save to Drafts."`. Stripped.
- Partial match (same greeting and sign-off, different middle): returned unchanged.

## C1-c label: CONFIRMED, plus two minor non-blocking findings
- `**Suggested reply:**` on its own line: stripped. Inline `Suggested reply: Hi Sam,`: stripped. Inline bold: stripped.
- ATTACK, over-strip: none found. A real draft paragraph starting "Suggested reply…" is NOT over-stripped.
- MINOR, under-strip: when a draft paragraph starts "Suggested reply" (e.g. "Suggested reply times are noon or 3pm." or "Suggested reply: yes."), the label prefix is taken off the prose copy only, not the body copy. The paragraph then never matches, so the WHOLE text is returned unchanged and the draft shows twice (text + card). This is the safe direction and it is rare.
- MINOR, cosmetic: a label at the end of the intro paragraph ("Sam wants lunch. Suggested reply:") or a dash label ("Suggested reply —") is left behind after the draft is stripped. The card follows directly, so it still reads correctly.
- By design: a one-paragraph draft that equals a prose paragraph ("Sounds good.") gets that paragraph stripped.

## E1-a row keeps its buttons: CONFIRMED
In HuddleView.tsx MessageRow, `notice` only swaps `<ChatText>` for the grey `agent-notice` div. Everything below it still renders unconditionally on its own field: artifacts, toolUses, priorities/schedule, ConfirmAskRow, OverrideAskRow, EmailReplyRow, NavLinkButton. hardReply attaches `emailReply` (huddle.functions.ts ~6840).

## E1-b every "(fallback: " reply is a notice: CONFIRMED
- Producers, found by grep over all of `src/`: huddle.functions.ts:5287 `(fallback: …) AI gateway…`, :6788 `(couldn't respond — …)`, :6789 `(fallback: …) couldn't reach the model — …`. All three are notices, including the loop-2 input with ")" inside (`gpt-4o (TPM): Limit`). The curly apostrophe works too.
- Not notices: the :6874 appended `_(fallback: …)_` after real text; "(fallback: …)" or "(couldn't respond — …)" in the middle of a sentence; "(Fallback: …)" with a capital F.
- ATTACK: a model reply that literally begins "(fallback: if Tuesday fails) we can do Wednesday." IS shown as a grey notice. The text is shown in full; only the styling changes. This is unlikely, and its only cost is presentation. Not blocking.
- `joinOpenerAndBlock` with a notice falls back to "Hello Sir," (B-slice consumer, consistent).

Slice verdict: CONFIRMED
