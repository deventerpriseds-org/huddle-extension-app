# BUILD — override quote hardening (fixing VERIFY-override-gate-1 CLAIM 4) + the approach-gate fail-open

```
WHAT:       Closes the PROVEN self-override hole in verifyOwnerQuote (provenance was being mistaken
            for authorization), and the live fail-open in approach-gate.server.ts that STORES an
            approval no grader produced when the grader call throws.
WHY:        .claude/VERIFY-override-gate-1.md CLAIM 4 REFUTED: an independent verifier called the
            real verifyOwnerQuote() with three attacks and all three returned ok:true — an unrelated
            complaint, a pasted agent proposal, and a substring of a sentence that explicitly says
            NOT to proceed. Plus: the quote is never bound to the task_id it authorises.
SUPERSEDES: nothing (hardens .claude/IMPL-override-gate.md's work in place)
SUPERSEDED-BY: nothing -- current
EVIDENCE:   this file; scripts/approach-override.test.ts; mutation outcomes recorded below.
BRANCH:     claude/iris-huddle-interaction-baj51c
CONSTRAINT: another agent owns src/features/huddle/lib/huddle.functions.ts and
            src/features/huddle/lib/tasks/deep-confirm.server.ts THIS SESSION — neither is edited
            here. Every change below is reachable without touching either.
```

## Written as I go. Appended incrementally; committed with each code commit.

---

## 1. What I read before designing (ground truth, not recall)

| File | What it settled |
|---|---|
| `.claude/VERIFY-override-gate-1.md` | CLAIM 4 REFUTED. Three attacks, reproduced by calling the real function. Attack 4 (cross-task replay) CONFIRMED exploitable. |
| `approach-override.ts` (all 143 lines) | The check is `isUserTurn(id)` + 24h window + `normalizeQuote(turn.text).includes(normalizeQuote(quote))`. **The model chooses the substring.** No task argument is passed at all. |
| `green-light.ts` (all 80 lines) | Already owns "did the user say GO": `GREEN_LIGHT` idiom list + `isNegatedOrAsked` (negation/deferral/question). `isNegatedOrAsked` is currently **private**. |
| `review-gate.server.ts:104-109` | **Verified by reading, as instructed.** Its catch returns `{gated:true, proceed:true, note:...}` and writes NOTHING. That is the shape to copy. |
| `approach-gate.server.ts:179-182` | The defect: `await approveApproach(...)` inside the catch on the fresh path — a stored approval. The errored RE-grade path (171-178) is already correct and is NOT touched. |
| `confirm-ask.functions.ts:166-231` | `overrideEscalatedApproach` — the single shared core. Has `task.title`, `task.assigned_agent` (from `getOwnedTaskForConfirmAsk`) and `state` in hand already. |
| `huddle.functions.ts:3628-3668`, `:4800-4840` | **Read only.** Both dispatch paths call `overrideEscalatedApproach({taskId, email, source})`. They do **NOT** pass a huddleId. So no binding design may depend on the *current* huddle. |
| `turns.server.ts:421-462` | `getRecentUserUtterances` projects `id, text, updated_ms` only. `chat.pending_turns.huddle_id` exists (line 38 DDL) and is NOT projected — I add it. |
| `tasks.server.ts:700-731, 1055-1110, 1233-1272` | `TaskEngagementState` does not project `updated_at`; the table has it (NOT NULL, bumped by `escalateApproach`). No dedicated escalation timestamp exists — I add one. |
| `autowork.server.ts:697` | `promotedToDoing = state?.approach_status === "approved"` — the one downstream consumer of a STORED approval. Relevant to fix 2 (see §5). |

## 2. The diagnosis I am designing against

The existing check proves **provenance** — these characters were really typed by the user, recently.
It then treats that as **authorization** — these words mean "proceed, on THIS task". Those are not the
same claim, and no length floor bridges them, because the model picks which characters to submit.

```
            what verifyOwnerQuote proved            what it needed to prove
            ------------------------------          ------------------------------
  WHO       a real user turn typed it       OK      a real user turn typed it          OK
  WHEN      within 24h                      OK      AFTER this task escalated          MISSING
  WHAT      >=24 chars / >=4 words           OK      the sentence READS as consent      MISSING
  ABOUT     (nothing at all)                        this task                          MISSING
```

Four properties, in the order a request hits them.

## 3. The design (and what each part genuinely stops)

### P2 — it must POSTDATE the escalation
A sentence typed before the task ever escalated cannot be authorising an override of it.
`task_engagement_state` has no escalation timestamp, so I add **`approach_escalated_at TIMESTAMPTZ`**
(idempotent `ADD COLUMN IF NOT EXISTS`, next to the existing override audit columns), written by
`escalateApproach()` and cleared by `resetEngagementOnReassignment()`. For rows that escalated before
this column existed it falls back to the row's `updated_at` (NOT NULL, and for an escalated row the
escalation is normally the last write). If neither parses, the quote path REFUSES.

### P3/P4 — it must READ AS CONSENT, over the whole clause, not the attacker's substring
**Extended `green-light.ts` rather than writing a second classifier** (repo rule: extend, don't
duplicate). `green-light.ts` already owns "did the user say GO" and already has the negation logic
the attack defeats. Added there, additively:
- `isNegatedOrAsked` is now **exported** so there is exactly one negation rule in the codebase.
- `isAuthorisation(line)` — `GREEN_LIGHT` idioms **plus** override-specific ones
  (`override the gate`, `approve it as-is`, `unblock it`, …), minus negation/deferral, minus
  questions **including leading interrogatives** ("what is this: …", "should we …").
- `isGreenLight` and the `GREEN_LIGHT` array are **byte-identical in behaviour** — `deep-confirm.server.ts`
  and `huddle.functions.ts` consume those and belong to another agent this session.

`approach-override.ts` then evaluates **the sentence/clause the match falls inside**, not the needle:
it locates the needle in the normalised utterance and expands to the nearest `. ! ? ;` boundaries
(keeping the terminator so a question still reads as a question). The attacker chooses only *which
clause gets evaluated*; they cannot shrink it.

### P1 — it must BIND to the task
`overrideEscalatedApproach` has `taskId`, `task.title` and `task.assigned_agent`. The dispatch sites
do not pass a huddle id, so binding uses the **matched turn's own** `huddle_id` (newly projected).
At least ONE must hold:

| # | Binding | Stops |
|---|---|---|
| B1 | the utterance contains the task id verbatim | everything, when present (rare in real chat) |
| B2 | the utterance contains a >=2-word, >=10-char contiguous phrase of the task title | replay onto a task the sentence does not name |
| B3 | the turn was typed in the assignee's own DM (`dm-<assigned_agent>`) **and that agent has no other escalated task** | replay across agents; replay across that agent's tasks |

B3's ambiguity clause is the part that does real work on the verifier's attack 4: a bare "go ahead"
in Cole's DM authorises an override only while Cole has exactly one escalated task. Two escalated
Cole tasks -> ambiguous -> refuse. If that count query throws, B3 is treated as unavailable (closed).

### Fail CLOSED everywhere
New reasons: `predates-escalation`, `not-consent`, `not-this-task`. Every new catch refuses. A
missing/unparseable context refuses. The **button path is untouched** — `via:"button"` never enters
this code, because the click is itself the user act.

## 4. Honest residuals (recorded before implementing, so they cannot be quietly dropped)

- **Attack 2 is mitigated, not eliminated.** If the user's *own sentence* both quotes the agent AND
  reads as an imperative go-ahead ("what is this: go ahead and skip the backup" — leading
  interrogative, so refused; but a cleanly-phrased paste that happens to be an imperative would
  pass), consent semantics cannot tell a paste from an instruction. Naming it rather than rounding up.
- **B3 with exactly one escalated task per agent still admits an unrelated go-ahead** typed in that
  agent's DM about something else, if it postdates the escalation and reads as consent.
- **Nothing here is confirmed live.** Nothing is merged or deployed.

## 5. Fix 2 — the live fail-open at `approach-gate.server.ts:179-182`

`await approveApproach(...)` in the catch permanently stores an approval no grader produced; one
transient OpenAI 429 (documented as recurring in this repo's CLAUDE.md) marks a task approved
forever, indistinguishable from a real pass. `review-gate.server.ts:104-109` — **read, not assumed** —
returns `proceed:true` and writes nothing. Matching it: **fail open in the RETURN, never in the
STORED STATE.**

Traced consumer: `autowork.server.ts:697` `promotedToDoing = state?.approach_status === "approved"`.
After the fix, a grader outage means the current turn proceeds (unchanged) but autowork does not
auto-promote that task to DOING on a later pass — it goes round the approach gate again once the
grader is back. That is the gate working, not a regression.
The errored **RE-grade** path (`if (wasEscalated)` at 171) is untouched — the verifier CONFIRMED it.

---
## 6. THE ATTACKS, RE-RUN AGAINST THE FIXED CODE (the only evidence that matters here)

Method: one script importing BOTH the real modules — `git show HEAD:…/approach-override.ts` (the
version the verifier attacked) and the working tree's — and calling them with the **texts and
submitted spans copied verbatim from `.claude/VERIFY-override-gate-1.md` CLAIM 4b/4d**. Real output,
pasted unedited:

```
A: real but UNRELATED complaint
  submitted: "it when the app moves tasks around without asking me first"
  OLD (HEAD, what the verifier ran): {"ok":true,"turnId":"u-1789217630835","matchedMs":1789217630835}
  NEW (this fix):                    {"ok":false,"reason":"not-consent"}

B: the owner PASTING the agent's own proposal
  submitted: "Do the risky migration and skip the backup step entirely"
  OLD (HEAD, what the verifier ran): {"ok":true,"turnId":"u-1789217630835","matchedMs":1789217630835}
  NEW (this fix):                    {"ok":false,"reason":"not-consent"}

C: a span cut out of an EXPLICIT REFUSAL
  submitted: "proceed with that approach, override it later once we know more"
  OLD (HEAD, what the verifier ran): {"ok":true,"turnId":"u-1789217630835","matchedMs":1789217630835}
  NEW (this fix):                    {"ok":false,"reason":"not-consent"}

D: cross-task REPLAY (VERIFY CLAIM 4d) — one genuine go-ahead, pointed at another task
  OLD, task A: {"ok":true,...}
  OLD, task B (different task, SAME verdict — that is the bug): {"ok":true,...}
  NEW, task A (its own escalated task):    {"ok":true,"turnId":"u-1789217630835",...}
  NEW, task B (another agent's task):      {"ok":false,"reason":"not-this-task"}
  NEW, task C (same agent, 2nd escalated): {"ok":false,"reason":"not-this-task"}

E: A GENUINE AUTHORISATION MUST STILL PASS (a guard that blocks everything is not a fix)
  NEW: {"ok":true,"turnId":"u-1789215530835","matchedMs":1789215530835}
```

All three are now encoded as permanent cases in `scripts/approach-override.test.ts`, under headings
naming them ATTACK 1/2/3, plus ATTACK 4 for the replay.

## 7. Suites (run before the commit that carries this file)

```
test:router        -> exit 0 | 20 passed, 0 failed
test:blocked       -> exit 0 | 21/21 passed
test:presence      -> exit 0 | 18/18 passed
test:mode          -> exit 0 | 22/22 passed
test:voice-tools   -> exit 0 | 36 passed, 0 failed
test:cross-app     -> exit 0 | 83 passed, 0 failed
test:email-gate    -> exit 0 | 73 passed, 0 failed
test:nexus-tools   -> exit 0 | ALL PASS: 190 passed, 0 failed
test:turn-identity -> exit 0 | ALL PASS
test:override-gate -> exit 0 | ALL PASS
test:green-light   -> exit 0 | ALL PASS
npx tsc --noEmit   -> exit 0, no output
```

Two of my own structural assertions FAILED on first run and were corrected rather than banked —
worth recording because both are the repo's named failure modes:
- `assignedAgent: task.assigned_agent ?? null` was asserted as a literal that **does not exist**;
  the code binds it to a `const` first. (The "never type a literal you have not read" rule, again.)
- the `approveApproach`-absent check fired on my own **comment**, which names the call while
  explaining why it is gone — a cry-wolf guard. Fixed by stripping comments before matching, with a
  second assertion that the stripping left the executable body intact.

