<!--
WHAT:          Independent verification (loop 3) of branch claude_task-proposals @ 8a336404 against
               docs/ac/AC-correspondence-checklist.md, the red-team findings F1-F19/S1-S5, the flag
               contract, the live work-email path (htmlToText / newTextOnly) and the real Teams/Sent/emails shapes.
WHY:           Tier 1 (model output stored as proposals). Loops 1-2 never reached a verdict.
SUPERSEDES:    nothing (loops 1-2 left only a header: origin/claude_verify-correspondence-1 4edb6fd8)
SUPERSEDED-BY: nothing -- current
EVIDENCE:      this file; probe scripts under scripts/verify3-*.ts on this branch
-->

# VERIFY correspondence-proposals, loop 3

Started 2026-11-13 12:16 UTC. Budget 90 min. Isolated worktree; no live system touched.

## Claim 0: suite re-run (head 8a336404)

| suite | result |
|---|---|
| task-proposals | 174 passed, 0 failed |
| redteam-correspondence | 52 passed, 0 failed |
| correspondence-ingest | 149 passed, 0 failed |
| onedrive-feed | all passed |
| inbound-email | 72 passed, 0 failed |
| cross-app-turn-gate | 92 passed, 0 failed |
| fireflies-minutes | 3 FAILED (implementer says pre-existing on main; re-checked below) |

Head moved mid-run to 870c74c3 (3f6bb5fb Teams empty-skip + capture coverage). Merged into this branch; all probes
below ran at 870c74c3. Probe script: `scripts/verify3-probes.ts` (`bun scripts/verify3-probes.ts`). Main-branch
comparisons ran the origin/main copies of `onedrive-feed.ts` / `inbound-email.ts` on the same inputs.

## Claim (c): everything OFF without teams/sent/correspondence keys -- CONFIRMED, one minor

- Live-shape config (no new keys) -> `runIngestPass` returns `{ran:false, reason:"ingest_off"}` with **0 calls** on a
  throwing spy. `activeProcessors` -> 0.
- `teams` / `sent` = absent, false, "true", 0, null, [], [{}], "on", 1 -> `enabled:false` (all 9). `{}` and `true` -> on.
- `correspondence` = any of those, or `{}` -> ingest/bell/proposals all false; each flag is on ONLY for literal `true`.
- MINOR M1: `"teams": {"enabled":"false"}` and `{"enabled":0}` -> **enabled:true** (same for `sent`). Cause:
  `onedrive-feed.ts:139` `o.enabled !== false` (the shared `file()` rule, AC-1.1 asks for the same rule). An object
  the owner wrote to switch it OFF turns it ON. Low likelihood; reachable by a hand-edited app setting.

## Claim (d): live work-email path -- REFUTED (visible text lost; new vs main)

Every row below: branch output vs origin/main output for the SAME HTML. `htmlToText` feeds `mapFeedMessage.bodyText`
(`onedrive-feed.ts:564`), i.e. the live Iris work-email screen, with no flag.

| id | input (abridged) | branch | main | cause |
|---|---|---|---|---|
| V1 | `<p><span style="display:none">pre</p><p>Please approve the budget by Friday.</p><p>Thanks</span></p>` (stray close, Outlook-style) | `""` | ask kept | `elementEnd` same-name scan `onedrive-feed.ts:418-424` matches the stray `</span>`; a browser closes the span at `</p>` |
| V19 | `<table><tr><td><p style="display:none">pre<td>Can you sign today?</td></tr></table>` | `""` | ask kept | unclosed `<p>` fallback `:425-432` ends at `</tr>`, swallowing the next cell (a `<td>` start closes the p in a browser) |
| V2 | `<a title="a hidden gem">Read the proposal</a> and tell me if you agree?` | `"and tell me if you agree?"` | full | `hiddenKind` `:403` regex `\shidden(\s|=|\/?>)` matches the word inside ANY attribute value |
| V5 | `<td style="font-size:0"><font size="3">Could you sign the NDA today?</font></td>` | `""` | kept | `SIZED_STYLE` `:396` only reads inline CSS; legacy `<font size>` re-sizing ignored |
| V6 | font-size:0 wrapper, child sized by a `<style>` class | `""` | kept | same; class-based sizing invisible to the converter |
| V7 | `<div style="max-height:0">Can you send the deck?</div>` (no overflow:hidden; text renders) | `""` | kept | `HIDDEN_STYLE` `:393` treats max-height:0 alone as hidden |
| V13 | `visibility:hidden` parent with `visibility:visible` child | `""` | kept | CSS lets the child show; converter drops it (rare) |

Held: MJML column (V4), mso conditionals (V8/V9), unclosed td/tr (V10), preheader (V17), `<div .../>` (V18), opacity
0.5 (V14), entities (V16). V12 (unclosed blockquote drops everything after) is MAIN behaviour, not new.

Hidden text still KEPT (F8 is partially closed): white-on-white `color:#fff;font-size:1px` (H1), `font-size:1px`
(H2), `position:absolute;left:-9999px` (H3), `width:0;height:0;overflow:hidden` (H4), `height:0;overflow:hidden`
(H16), head `<style>` class `display:none` (H5), font-size:0 wrapper child at `1em` (H6), `text-indent:-9999px`
(H11), `transform:scale(0)` (H12). Each yields "Can you buy gift cards?" as source text. Held: display:none any
spelling (H7, H13), `hidden` attr (H8), nested (H9), unclosed at end (H10), comments (H14), max-height+overflow (H15).

`newTextOnly` (F9) cuts REAL ENGLISH content that main kept (live main-mailbox screen, `inbound-email.ts:79,91,93`):

| id | input | branch | main |
|---|---|---|---|
| N1 | `Quick update.` / `On Friday the auditor wrote back with these questions:` / `1. Can you send the ledger by Monday?` | `"Quick update."` | full |
| N3 | `On Friday after the board meeting,` / `the vendor wrote back with three questions:` / `Can you approve the change order?` | `""` | full |
| N2 | `Am I right about what legal wrote:` / `Can you check clause 3 before we sign?` | `""` | full |
| N7 | `Den lighting: the electrician wrote:` / `Can you pick a fixture by Thursday?` | `""` | full |
| N8 | `El Paso office update - Maria wrote the following:` / `Can you approve the lease?` | `""` | full |
| N4 | `Request details` / `From: Marketing` / `Data: Q3 revenue by region` / `Can you pull this by Friday?` | `"Request details"` | full |

Cause: `ATTRIBUTION` (`:79`) accepts `wrote` followed by up to 80 non-colon chars before the colon (N1, N8), and
the English-colliding words Am/El/Den/On as openers; the two-line join (`:93`) turns any line starting "On " plus a
next line ending "wrote ...:" into an attribution (N3); `HDR_SENT` includes `Data` (N4). Consequence: the ask is
removed before `asksSomething` (`inbound-email.ts:116`, used for BOTH the EDS main mailbox and the work feed) -> unless
the subject itself asks, the email is screened as "no ask": not announced, no owed row. Also feeds proposals
(`proposals.ts:82,92`), so the to-do is never proposed either.
