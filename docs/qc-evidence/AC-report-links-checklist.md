<!--
WHAT:          Acceptance criteria (cold, adversarial) for the report email's links into Iris's
               existing proposals checklist, plus a per-row "Wrong" link.
WHY:           Owner decision 2026-11-15: act on report items from the email, via links into the
               EXISTING checklist, "as long as it's reversible". Forms-in-email, one-step action
               links for every action, and Outlook Actionable Messages were rejected.
SUPERSEDES:    nothing
SUPERSEDED-BY: nothing -- current
EVIDENCE:      base origin/claude_task-proposals @ c479cc33; sources listed under "Sources read".
STATUS:        IN PROGRESS -- sections are appended and pushed as they are written.
-->

# Acceptance Criteria -- report email links into Iris's checklist

Synthetic data only (public repo). No real names, addresses, ids, or message content.

## Sources read
All on `origin/claude_task-proposals` @ c479cc33 unless noted. Read this pass, not recalled.

| File | What it settled |
|---|---|
| `.claude/actions.md` (top rows) | Owner approval of item (2): links into the EXISTING checklist + a "Wrong" link per row; depends on proposals being stored; loop-7 before-switch-on list. |
| `.claude/memory.md` "Correspondence + proposals" | The report is produced by `proposals-preview.yml` on a GitHub runner and emailed via Graph `sendMail`; logs are counts only. |
| `docs/qc-evidence/IMPL-needs-you-redesign.md` | Judge flow; the verdict name is written into `chat.correspondence_ledger.result_ids` (`needs_you: [category]`); no new table. |
| `docs/qc-evidence/IMPL-meeting-triage.md` (headings + design) | `untriaged`/`delegated` states; TRIAGE_LOOKBACK_DAYS. |
| `origin/claude_ac-correspondence-redesign:docs/qc-evidence/AC-correspondence-redesign.md` (R7, R9) | The report's three lists; R7.7 public-log privacy; R9 flags literal `true`. |
| `src/features/huddle/lib/proposals/proposals.functions.ts` | `actOnProposalFn` / `getProposalStatesFn`; ids validated `^prop-[0-9a-f]{1,32}$`; **caller is a client-supplied `{entra_object_id, entra_email}` object, no id-token check.** |
| `src/features/huddle/lib/proposals/proposals.server.ts` | `proposalsConfig()` gate; `callerOwners()` resolves scope from the client-supplied email; `proposalChecklistForUser`; `TRIAGE_LOOKBACK_DAYS = 2`. |
| `src/features/huddle/lib/proposals/proposals-store.server.ts` | `chat.task_proposals` / `chat.task_proposal_refs` schema; every query owner-scoped (`owner_email = ANY($1)`); `decide`/`edit` apply only from `proposed`; **no transition back out of approved/completed/dismissed exists.** |
| `src/features/huddle/lib/proposals/proposals.ts` (L29-36, L654-657) | `PROPOSALS_HUDDLE = dm-iris-chase`; `proposalId = "prop-" + stableHash([owner, source, sourceItemId, normTitle])`. |
| `src/features/huddle/lib/proposals/engine.ts` (L180-205) | `proposeJudgedTodos` keeps todos where `doerIsOwner(t.doer)`. |
| `src/features/huddle/lib/correspondence/needs-you.ts` (L205-225, L331, L458-465) | Thread rendered to the model as `--- [n] OWNER|OTHER (name) | at | subject: ...` with message text inserted raw; `doerIsOwner(null) === true`. |
| `src/features/huddle/components/ProposalChecklistItem.tsx` | Row actions approve / edit / complete / dismiss / triage; optimistic + rollback; disabled when signed out. |
| `src/features/huddle/components/HuddleApp.tsx` (L348-369) | `?huddle=` deep link read once, `&email=` focus, params stripped by `replaceState`. |
| `src/features/huddle/lib/attention/focus.ts` | `messageDeepLink(huddle, emailId)` / `parseFocusParams`; `FOCUS_WAIT_MS = 6000`; not-found state. |
| `src/features/huddle/lib/correspondence/ledger.server.ts` (L43-65) | `chat.correspondence_ledger` columns incl. `result_ids JSONB`. |
| `src/features/huddle/lib/fireflies/minutes.functions.ts` (L15-36) | The EXISTING verified-auth pattern: `idToken` -> `verifyEntraIdToken` (`src/lib/entra-verify.server.ts`). |
| `scripts/proposals-preview-render.ts` (L1-40) | `NeedsYouReport` shape: `replies[]` (conversation rows), `todos[]` (grouped per conversation), `meeting[]`; HTML escaped via `esc`. |
| `src/start.ts` | No auth middleware on server functions. |

Not read (named so the coverage is honest): the loop-7 verifier report itself (not found on the `edscheck/claude_verify-correspondence-proposals-7` ref under a VERIFY name); the third before-switch-on item ("owner rules only in the prompt") is therefore specified from the brief + `actions.md`, not from the verifier's own text.

## Existing systems this extends (not duplicates)

| Need | Existing system to EXTEND | New thing? |
|---|---|---|
| Link opens Iris's chat at a row | `?huddle=` deep link + `focus.ts` (`messageDeepLink`, `parseFocusParams`, `requestEmailFocus`, FOCUS_WAIT_MS) -> add ONE sibling param `proposal=<prop-id>` beside `email=` | no |
| Acting on the row | `ProposalChecklistItem` + `actOnProposalFn` unchanged in behaviour | no |
| Showing the row when no loaded checklist message holds it | `getProposalStatesFn` (one request, owner-scoped) + the same `ProposalChecklistItem` component | no new widget |
| "Review all" | `proposalChecklistForUser` / `listActive` + `listUntriaged` (the same set `build_checklist proposals:true` shows) | no |
| "Wrong" correction | proposal rows: `chat.task_proposals` (add a nullable `owner_correction JSONB` column); reply rows: `chat.correspondence_ledger` (same nullable column, on the row whose verdict was shown). Read/write through the two existing store modules. | a column, not a table (see OQ-3 for the one-table alternative) |
| Report email | `scripts/proposals-preview-render.ts` (`renderNeedsYouHtml`) + the existing Graph `sendMail` step | no |
| Switch | `HUDDLE_ONEDRIVE_FEEDS.correspondence.*`, literal-`true` parser (AC-R9.1) -> one new key `correspondence.reportLinks` | a key |
| Verified identity | `verifyEntraIdToken` as used by `minutes.functions.ts` | no |

### The dependency the owner must see (why links cannot ship alone)

```
today:   GitHub runner ──judge (stores NOTHING)──► report email     (rows exist ONLY in the email)
                                                    Iris checklist ◄── chat.task_proposals (EMPTY: flag off)

needed:  heartbeat ingest ──judge──► validators ──► chat.task_proposals / correspondence_ledger
                                                         │
                         report email ◄── rendered FROM ─┘──► Iris checklist (same rows, same ids)
```

A link can only point at a row that is STORED. Today the report and the checklist are produced by two different
runs (the runner's judge and, once on, the app's judge); a model is not deterministic, so two runs can disagree.
**The report must therefore be rendered from the store, not from a second judge run** (AC-D1), or every link is a
coin-flip between "lands on the item" and "not found".

## Acceptance criteria
PENDING

## Spelling table
PENDING

## Goal -> AC coverage
PENDING

## Build plan
PENDING

## Open questions for the owner
PENDING
