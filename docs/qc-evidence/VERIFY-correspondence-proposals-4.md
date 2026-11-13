<!--
WHAT:          Independent verification (loop 4) of claude_task-proposals @ 2cf5fa8d: re-check of loop-3 confirmed
               items, full re-derivation of loop-3 defects D1-D6/M1/M2, and full-depth check of the new
               file-staleness alert (correspondence.staleAlerts) and scripts/proposals-preview.ts.
WHY:           Tier 1 (model output stored as proposals; live bell + live email screens touched).
SUPERSEDES:    docs/qc-evidence/VERIFY-correspondence-proposals-3.md (origin/claude_verify-correspondence-3)
SUPERSEDED-BY: nothing -- current
EVIDENCE:      this file; probe scripts scripts/verify3-*.ts (loop 3) and scripts/verify4-*.ts (this loop)
-->

# VERIFY correspondence-proposals, loop 4

Started 2026-11-13 14:28 UTC. Budget 90 min. Isolated worktree; no live system touched; synthetic `.example` data.

## Claim 0: full suite re-run at 2cf5fa8d

| suite | result |
|---|---|
| task-proposals | 198 passed, 0 failed |
| redteam-correspondence | 70 passed, 0 failed |
| correspondence-ingest | 149 passed, 0 failed |
| onedrive-feed | all passed |
| inbound-email | 72 passed, 0 failed |
| cross-app-turn-gate | 92 passed, 0 failed |
| feed-staleness | 66 passed, 0 failed |
| attention | all passed |
| `npx tsc --noEmit -p .` | exit 0, no output |

Matches the implementer's numbers exactly.

## Claim 1: loop-3 repro inputs re-run at head (scripts/verify3-*.ts, unchanged)

| loop-3 item | loop-3 result | head result |
|---|---|---|
| M1 `teams`/`sent` `{"enabled":"false"}`, `{"enabled":0}` | enabled:true | **enabled:false** (both keys); `{}`/`true` still on; `"on"`, `1`, `"true"` off |
| D1 V1 stray `</span>` | `""` | "Please approve the budget by Friday.\n Thanks" |
| D1 V2 `title="a hidden gem"` | ask cut | full text |
| D1 V5 `<font size>`, V6 class, V7 max-height alone, V13 visibility:visible child, V19 unclosed `<p>` in td | `""` | ask kept in all five |
| D1 negatives H7-H10, H13-H15 | hidden | still hidden |
| D1 H1-H6, H11, H12, H16 | kept (hidden text leaks) | still kept -- unchanged, documented as out of scope |
| D2 N1, N2, N3, N4, N7, N8, N9 | cut | **all kept in full**; controls N5 (Outlook header) and N6 (Gmail attribution) still cut |
| D3 image-only / emoji-only / Giphy owner reply | skipped, chat stays OWED | kept; decision **answered** |
| D3 whitespace-only code block | -- | still `empty` (skipped) |
| D4 19:30-EST rerun | false DROP on next UTC day | unioned into 2026-11-12, `drop:false` |
| F4 a-d (invented detail) | c, d ACCEPTED | all four rejected |
| F5a "Redo the deck you sent" | ACCEPTED | rejected `task_not_grounded` |
| F5b "Send the budget review" from "Thanks for sending..." | ACCEPTED | still ACCEPTED (implementer documents as not addressed) |
| F7 a-e, h | ACCEPTED | all `evidence_negated` |
| F7f negation on the previous line | ACCEPTED | still ACCEPTED (documented: newline is a boundary by design) |
| M2 F10 `"3"`, F11a `"may"` as dueText | kept | dueText null |
| F3, F11b/c, F12, F13 | closed | still closed |
| sanitize S0-S5 vs main | S3 differs (correct) | identical result |

## Claim 2: D6 present AND tested at head

`proposals.ts:251` `return tw.every((w) => ev.has(w)) ? ...` is in the tree. `mutate.sh` with that line reverted to
the strict-majority rule (`tw.filter(...).length * 2 > tw.length`): **FIRED (control EQUIVALENT), exit 0** on
`D6 a title that adds`. CONFIRMED present and guarded.

## Claim 3: NEW spellings beyond loop 3 (`scripts/verify4-probes.ts`, `scripts/verify4-browser-truth.mjs`)

Every D1/D2 row ran on this branch AND on origin/main's copy of the same file. D1 ground truth is a real Chromium
(`/opt/pw-browsers/chromium-1243`, `page.setContent`, `document.body.innerText`), not a reading of the spec.

### D1 (live work-email screen, no flag) -- REFUTED on three new shapes

| id | HTML | Chromium shows | branch | main |
|---|---|---|---|---|
| W1 | `<p><span style="display:none">preheader text<p>Please approve the budget by Friday?</p>` | "Please approve the budget by Friday?" | **`""`** | kept |
| W2 | `<p><span style="display:none">pre<ul><li>Can you sign the NDA today?</li></ul>` | "Can you sign the NDA today?" | **`""`** | kept |
| W3 | `<ul><li><span style="display:none">x<li>Can you call the vendor?</li></ul>` | "Can you call the vendor?" | **`""`** | kept |
| W4 | `<!--[if mso]><p>Can you sign the NDA?</p><![endif]--><div style="mso-hide:all">Can you sign the NDA?</div>` | "Can you sign the NDA?" | **`""`** | kept (twice) |
| W7 | `<div title=' style="display:none"'>Can you approve the PO?</div>` | "Can you approve the PO?" | **`""`** | kept |
| W1b | as W1 but `<b style="display:none">` (a formatting element, which the parser re-opens) | `""` | `""` | kept |

Causes:
- W1-W3: `startTagEnds` (`onedrive-feed.ts:459`) knows only the hidden element's OWN implied ends. When a hidden
  inline element sits unclosed inside a `<p>` / `<li>`, the browser's "close a p element" / next `<li>` pops it with
  its parent; `elementEnd` (`:485`) does not see the parent, walks to the end of the document, and drops everything.
  This is the V1 class reached through an implied (not explicit) parent close.
- W4: `HIDDEN_STYLE` (`:406`) treats `mso-hide:all` as hidden everywhere, and `:596` removes every `<!-- -->`
  comment including the `[if mso]` copy. `mso-hide:all` hides only in Outlook desktop; the mso copy shows only in
  Outlook desktop. Each reader sees the text once; the converter keeps neither. (Common in bulletproof-button
  markup; rarer in person-to-person mail.)
- W7: `styleOf` (`:418`) finds ` style="..."` inside another attribute's quoted value. Exotic.

Held (correctly hidden or kept): aria-hidden / data-hidden kept (W5, W6); void tags inside a hidden div (W8);
Outlook `<o:p>` (W9); hidden `<h2>` ended by `<h3>` (W10); stray `</div>` (W11); `opacity:0` sibling (W12); upper-case
`HIDDEN` attr (W13), `display :none` (W14), font-size:0 + `<b>` (W16) hidden; unclosed hidden `<td>` then `<tr>`
(W17); table inside hidden div (W18). `display:/*x*/none` (W15) is kept (leak direction, as H1-H16).

### D2 (`newTextOnly`, live main-mailbox + work-feed screen) -- REFUTED on the two-line join

| id | body | branch | main | asks? branch / main |
|---|---|---|---|---|
| X1 | `Status below.` / `On Nov 12 the auditor sent these questions and Pat` / `also wrote:` / `Can you send the ledger by Monday?` | `"Status below."` | full | **false** / true |
| X2 | `On 3 occasions the client` / `complained, and today she wrote:` / `Can you call her back?` | `""` | full | **false** / true |

Cause: `inbound-email.ts:123`. The digit guard admits any hard-wrapped English line that starts "On" and carries a
digit when the next line ends "wrote:"; joined, it matches main's own English rule `^\s*On .+wrote:\s*$` (`:97`).
Consequence: same as loop-3 N3 -- the email is screened as "no ask" (not announced, no owed row, no proposal).
Narrower than N3 (needs a digit), but still English content main kept. Plain-text mail is hard-wrapped at ~72
chars, which is what produces this shape.

Held: X3 (German opener + English verb) identical to main; X4/X5 identical to main. X6-X9 (`De :`/`Da:`/`De:` +
`Date`/`Data`) are the deliberate F9 non-English cuts; X9 (Spanish `De:` + English `Date:`) is cut through the
French pair -- a real mixed-locale header, so acceptable.

### D3 (Teams empty skip) -- PARTIAL residue

Kept: sticker `<img>`, upper-case `<IMG>`, a text-type body holding only an emoji. Still skipped as `empty`:
`<customemoji ...></customemoji>` and `<video>`. `hasNonTextContent` (`teams-log.ts:111`) matches `<(?:img|emoji)\b`,
so `<customemoji` misses. Whether Graph writes custom emoji as `<customemoji>` is my recollection of the Graph
chatMessage docs, NOT checked against a live payload (inference, medium confidence). Before 3f6bb5fb such a message
was kept and settled the chat.

### D4 (Eastern capture day) -- CONFIRMED

DST end (03:00Z Nov 1 = Oct 31 23:00 EDT; 23:00Z Nov 1 = 18:00 EST) -> `2026-10-31` and `2026-11-01`; DST start
06:30Z/07:30Z on 2026-03-08 -> one day. 12 timed + 3 untimed lines -> note "3 line(s) with no capture time". An
epoch-number `capturedAt` is "unknown" (the flow writes ISO; counted in the note).

### D5 (negation) -- PARTIAL

Refused: "Do not, repeat, do not send", "asked us not to send", "hold off on sending", curly `don’t`, "Stop
sending", "shouldn't", "No need to", "cannot". Affirmative controls accepted ("To avoid delays, send", "Don't forget
to send", "If it is not signed, send"). **Accepted (new spelling): "Nobody should send the contract to the client
today."** -> proposal "Send the contract to the client". `proposals.ts:326` `NEGATION` has no "nobody"/"no one".

### D6 (title grounding) -- PARTIAL

Refused: added adverb, swapped object, added name. **Accepted: title "Do not send the deck to finance" from evidence
"send the deck to finance"** -- "do"/"not" are stopwords (`proposals.ts:204` `STOP`), so a title that INVERTS the
evidence is fully grounded. Low likelihood (the model is told to use the text's own words) but it is the exact
class D6 exists for: an added word that changes the meaning.

### M1 / M2 -- CONFIRMED

M1: re-checked above (claim 1). M2: "Friday-ish", "the 14th", "mon", "next time", "may 3" -> dueText null;
"Nov 14" -> 2026-11-14; "this week" -> dueText kept, date null.
