<!--
WHAT:          Implementation evidence for part A of the correspondence "needs you" redesign, as finally built: an AI
               CONVERSATION JUDGE for email (facts in code, meaning from the model, Tier 1 validation before anything is
               reported or stored), the email-only preview report, the tests (observed counts), the mutation proofs
               (mutate.sh verdict + exit code), what is NOT done, and the two owner changes received mid-pass.
WHY:           Owner 2026-11-14 redesign; AC docs/qc-evidence/AC-correspondence-redesign.md (branch
               claude_ac-correspondence-redesign @ 5b8ba7d3) R1, R2, R3 (fact rows), R6, R7, R9. Owner redirect the same
               day: "The problem is you are trying to apply keyword capture instead of using ai's ability to determine it
               contextually".
SUPERSEDES:    this file's earlier version (05fa3e9c), which described a keyword classifier that is now REMOVED.
SUPERSEDED-BY: nothing -- current.
EVIDENCE:      branch claude_redesign-needs-you from claude_task-proposals @ b7ddbdca; judge commit 52e75291 (+ this file).
               All fixtures synthetic (.example / .test). No live model, Graph, database, deploy or workflow was used.
-->

# IMPL: correspondence "needs you", part A (AI conversation judge, email only)

Nothing here is live. Everything new runs only when `correspondence.conversations` is literally `true`; the preview
script is a manual one-off that always uses the judge.

## How it works now

```
email snapshot ──► group by conversationId ──► FACTS (code, deterministic)
                                                 • messages oldest-first, OWNER / OTHER (name), quoted history stripped (newTextOnly)
                                                 • owner position on the latest OTHER message: direct / group / cc_only / none
                                                 • others on To / CC, recipient count; header facts (calendar stamp,
                                                   list-unsubscribe, auto-submitted, precedence, bulkcategory)
                                                 • SETTLED = owner wrote after the latest OTHER (inbox or Sent Items)
                    settled / owner-only ──► never sent to the model (counted)
                    otherwise ──► JUDGE (existing model path: callOpenAIRouter, OPENAI_API_KEY, EXTRACT_MODEL, strict schema)
                                   ──► VALIDATE (Tier 1)
                                        • bad JSON / wrong shape ──► needs_context (ledger retries; never "open")
                                        • needs_reply: ask.quote must be verbatim (whitespace-normalised) in the LATEST
                                          OTHER message, ask present, not "not_addressed" ── else downgraded to fyi
                                        • owner_todos: doer ≠ owner dropped; the rest go through the EXISTING
                                          validateCandidates via proposeFromSource (verbatim evidence, title grounding,
                                          negation D5/D6, date words); none from minutes / calendar / broadcast / not_addressed
                                   ──► report: Needs your reply (validated needs_reply AND Sent Items usable),
                                       Action items for you, Meeting action items (part B; "none triaged yet")
```

Files: `src/features/huddle/lib/correspondence/needs-you.ts` (facts, schema, prompt, validator, judge flow),
`src/features/huddle/lib/proposals/engine.ts` (`proposeJudgedTodos`, `needsYouJudgeProcessor`),
`src/features/huddle/lib/proposals/proposals.server.ts` (`judge` = the same client/key/model/timeout as `extract`;
processor only under the flag), `src/features/huddle/lib/external-feeds/onedrive-feed.ts` (optional
`toRecipients`/`ccRecipients`/`contentClass` on `mapFeedMessage`'s result; the flags), `email-replies.server.ts`
(`loadFeedSent` exported: no second Sent Items reader), `scripts/proposals-preview.ts` +
`scripts/proposals-preview-render.ts`, `scripts/fixtures/needs-you-judge-cases.json`, tests.

## Owner changes received mid-pass

| Owner instruction | What I did |
|---|---|
| Scope change: email only; Teams out of scope; leave Teams ledger/bell unchanged | `teams-log.ts`, `source-item.ts`, `bell.ts` are byte-identical to `b7ddbdca` (the Teams mentions parse I had added was BACKED OUT). With the flag on, Teams items go to the ORIGINAL per-message proposals processor (test "SCOPE Teams items..."). The preview reads no Teams log (PV-11). |
| Redirect: no keyword / regex classifiers for meaning; build an AI judge | **REMOVED, not left unused:** ask detection, group-address phrases, minutes/recap words, invite subject prefixes, the CC keyword rule, the owner-name gate, the keyword doer rules, and the `doer` seam I had added to `proposeFromSource` (`proposals.ts` is back to `b7ddbdca`; `proposeFromSource` is unchanged from base). A test asserts none of those names or the live-screen functions appear in `needs-you.ts`. Owner names (config, else the first token of each login, capitalised) are passed to the model as CONTEXT only, and used to compare the model's `doer` with the owner. |
| Spelling tables | **S-B, S-C (and my S-F, CC rows) are SUPERSEDED for meaning** and deleted. Only the fact-parsing rows remain: S-A recipient-string formats (S-A1..S-A13, R3.2/3.3/3.6, the real `;`-separated shape from probe P-5). |

## Deferred

- **Teams:** judge each chat from its CONTEXT with the speaker-tagged thread (the owner's messages vs others'), not
  with @mention rules. Nothing Teams-specific was built in the end. AC R2.10-2.12, R3.10-3.13, R7.8, S-D, S-E deferred.
- **OQ-5 (owner open question, recorded as asked):** the "2 or fewer other people / @mention / first name" rule for
  group and meeting chats. Superseded by the owner's later direction above.
- **Persistent judge cache.** The judge is cached per conversation + latest message id through an injected
  `JudgeCache` (in-memory in the preview). In the ledger path a conversation is judged once per pass, and the ledger
  only re-claims an item when it is new or its content changed, so an unchanged conversation is not re-judged; the
  verdict name is written into the ledger row's existing `result_ids` JSON (`needs_you: [category]`). What is NOT
  built: READING that JSON back to skip a re-judge when a conversation's older item is re-claimed (the ledger store
  has no read-by-key API; adding one is an SQL change I did not make). No new table.
- `emailBell` (AC-R9.4 / OQ-2 "not now"): parsed, OFF, read by nothing. Iris's email alerts and bell rows unchanged.
- Part B (R5 meeting triage) is the parallel agent's; the report's third list says "none triaged yet" (PV-9).
- AC-R6.10 (a commitment in a replied thread is still proposed) now CONFLICTS with the redirect's "a settled thread is
  never sent to the model": settled threads produce no to-dos. Kept the redirect's rule.

## Per AC: status, tests, mutation proof

Observed on the final tree: `bun scripts/needs-you.test.ts` **77 passed, 0 failed**; `bun scripts/proposals-preview.test.ts`
**15 passed, 0 failed**.

| AC / guard | Status | Tests | Mutation (mutate.sh, all FIRED = control EQUIVALENT, exit 0) |
|---|---|---|---|
| R1.1 live screen untouched | `git diff b7ddbdca HEAD -- inbound-email.ts` empty (note: at the base the file already differs from `origin/main`) | -- | -- |
| R1.2 / R1.4 pin | DONE: 98 synthetic messages, screenMessage x3 modes, asksSomething, newTextOnly, directive; extra mapper fields change nothing | "AC-R1.2 PIN ...", "AC-R1.4 ..." | snapshot |
| R1.5 / R1.6 | DONE: judge uses no live-screen function and no keyword classifier; preview never uses screenMessage | "AC-R1.5 + owner redirect ...", "AC-R1.6 ..." | -- |
| Facts: owner position, whole-address match (S-A) | DONE | S-A1..S-A13, AC-R3.2/3.3/3.6, P-5 | whole_address FIRED |
| Facts: thread order, OWNER/OTHER, quote stripping, counts, headers | DONE | F-1..F-5, F-12, F-13 | -- |
| Settled (deterministic) | DONE (inbox owner message or Sent Items via `sentReplySettles`; zoneless = UTC) | F-5..F-9 | settled_fact_inbox FIRED |
| Grouping by conversationId only | DONE | F-10, F-11 | -- |
| Ask quote verbatim in the LATEST OTHER message | DONE | V-1..V-3, V-6, V-7 | quote_verbatim FIRED; quote_latest_only FIRED |
| needs_reply needs an ask and an addressed verdict | DONE | V-4, V-5 | ask_missing FIRED; not_addressed_downgrade FIRED |
| Bad JSON -> needs_context, never open | DONE (needs_context in the ledger; a thrown model error -> failed_retryable/maxAttempts) | V-8, J-3, J-4, Q-5 | bad_json_needs_context FIRED |
| Settled thread never sent to the model | DONE | J-1, J-2, Q-4, PV-15 | settled_never_judged FIRED |
| Judged once per latest message | DONE (injected cache) | J-5, J-6 | cache FIRED |
| Sent Items unusable -> cant_tell, not listed | DONE | J-7 | sent_known FIRED |
| R6 to-do for someone else dropped; existing validators decide | DONE | Q-1..Q-3 | doer_filter FIRED |
| R6.1 no to-dos from minutes / calendar / broadcast / not_addressed | DONE | Q-6, Q-7 | no_todo_categories FIRED |
| R7.1-7.7 report: three lists, email only, counts only, public log content-free | DONE | PV-7..PV-15 | privacy_log FIRED; report_only_needs_reply FIRED |
| R9.1 / R9.2 flags, zero judge calls when OFF | DONE (structural: built only inside `conversations === true`) | "AC-R9.1 ...", "AC-R9.2 ..." | -- |
| Fixture set for the human check | DONE: 12 synthetic conversations, every category incl. "forwarded minutes with a direct question" and "CC to the whole group"; tests check only the deterministic part (no live model) | X-1, X-2 | -- |

**14 of 14 judge-era mutations FIRED (control EQUIVALENT), exit 0.** The keyword-era mutations recorded in the
superseded version of this file (05fa3e9c) proved guards that no longer exist.

## Existing tests changed (none weakened)

- `scripts/correspondence-ingest.test.ts` "AC-6.1 ... all OFF by default": the expected default shape gained
  `conversations:false, emailBell:false, ownerAliases:[], ownerNames:[]` (same pattern as when `staleAlerts` was added).
- `scripts/proposals-preview.test.ts` PV-1..PV-6 unchanged and green; PV-7..PV-15 added. `preview-fetch-stub.ts`
  gained a STUBBED model (`STUB_JUDGE`) and PUT-body capture.

## Suites run on the final tree (observed)

needs-you 77/0, task-proposals 204/0, redteam-correspondence 77/0, inbound-email 72/0, correspondence-ingest 149/0,
feed-staleness 96/0, proposals-preview 15/0, onedrive-feed-truth 11/0, html-visible-loop5 9/0, cross-app-turn-gate
92/0, onedrive-feed "all passed"; `npx tsc --noEmit -p .` clean. No SQL touched.

## ACs I believe are wrong, or need the owner

1. **AC-R6.10 vs the redirect** (see Deferred): his own commitment inside a thread he already answered is lost.
   Cheap fix if wanted: send settled threads to the judge for `owner_todos` only. It costs one model call per settled thread.
2. **The judge's quality is untested against a real model.** Only the guards are proven. The fixture set
   (`scripts/fixtures/needs-you-judge-cases.json`) is ready for one supervised run against the real model, so its
   categories can be compared with `expected` before switch-on.
3. **AC-R1.1 compares with `origin/main`,** but `newTextOnly` already differed from main at the branch base; the pin
   is taken against the base and this pass leaves the file untouched.
4. **Cost:** the preview caps model calls at `PREVIEW_MAX_SOURCES` (default 60); conversations over the cap are
   counted `needs_context` (reason over_cap), never listed.
