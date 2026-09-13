# Accuracy log — wrong-first-answers & the behavioral fix each one implies

Purpose (user instruction, 2026-08-18): *"you being wrong so often is dangerous, you need to be
running a log of when that happens to gather insights on behavioral changes we can make to optimize
your performance, accuracy and first-shot completions."*

This is a running log. **Append an entry every time a first answer turns out to be wrong** — one row
per miss. Each entry names the claim, the ground truth, the *single source that would have settled it
up front*, the root-cause pattern, and the concrete behavioral rule that would have prevented it. The
value is the compounding pattern across entries, not any single row.

## The recurring pattern (what the misses have in common)
**Answering a factual/capability question from a PARTIAL or PROXY source instead of the ground-truth
primary source — and stating it with unearned confidence.** Every miss below is a variant of the
org-wide "Ground-truth before answering" rule being skipped. The two highest-leverage guards:

1. **Capability-absence claims are the most dangerous.** Before saying "X can't do Y" / "there is no
   tool for Y" / "that isn't implemented", the bar is: grep **every** place the capability could live
   (both repos, all `tool-definitions`, the proxy passthrough, the runtime tool-assembly), not one
   file for one name. A single-file grep proves nothing about absence.
2. **The user's stated observation IS ground truth.** If the user says "Iris already does X" / "I saw
   X happen", and my analysis concludes "X is impossible/absent", **my analysis is the thing that's
   wrong** — treat their observation as the fact to *explain*, never the thing to contradict. Reconcile
   to their reality; don't argue the code at them.

## Log

| # | Date | Wrong first claim | Ground truth | The one source that would have settled it | Root-cause pattern | Behavioral rule added |
|---|------|-------------------|--------------|-------------------------------------------|--------------------|-----------------------|
| 1 | 2026-08-18 | "Streaming isn't implemented yet." | Incremental per-agent streaming **is** implemented (`run-turn.ts`, `kickNextChunk`, resumable turns). | The code (`run-turn.ts`), not the CLAUDE.md backlog note. | Trusted a stale doc/backlog note as current state. | For any "is X built/done?" question, read the **code on origin**, never a backlog/status note. Docs describe intent; code is truth. |
| 2 | 2026-08-18 | "Agents have no tool to create Outlook events." | Journey exposes `create_outlook_event` / `create_google_event` / `create_calendar_event` (`_shared/tool-definitions.ts:313-355`), dispatched in `execute-tool` (`case 'create_outlook_event'` → `createOutlookEvent`). Iris uses it — as the user said. | journey `_shared/tool-definitions.ts` + `execute-tool/index.ts`, **and** the user's own statement "Iris has been doing so successfully." | Grepped ONE file (`huddle.functions.ts`) for ONE name (`Create_Calendar_Event`), called absence; also contradicted the user's direct observation. | (a) Never claim tool/capability absence from a single-file/single-name grep — sweep both repos + all tool-definition sources + proxy passthrough. (b) When the user reports observed behavior, treat it as ground truth to explain, not to override. |

| 3 | 2026-08-20 | Deployed a "semantic 1:1 owner-resolution" fix and reported it shipped; user hit the same Finn→Tess mis-route again. | The fix was a **no-op**: (a) `resolveOwnerLLM` returned `null` for BOTH "keep with addressed agent" AND "failure", and the caller fell back to keyword `laneOwnerFor` on either → the mis-route it replaced came right back; (b) the candidate enum was `data.members` = `[finn-reid]` only in a 1:1, so the classifier could never pick another owner. | The independent `verifier` subagent's LIVE run (a fresh `followup-…-tess-sutton` turn appeared, no quota fallback) — NOT tsc, which was green. | Shipped a fix whose success path was structurally unreachable; "tsc clean + mechanism looks right" is not proof for a behavior fix. | (a) A behavior/routing fix is NOT "done" until an independent verifier confirms the OBSERVABLE outcome live — tsc/mechanism review is necessary, not sufficient. (b) A sentinel that means two different things (null = keep AND fail) is a bug smell — make "success/keep" distinct from "failure". (c) Check the actual data shape at the call site (a 1:1's `members` is the single addressed agent, not the team). |

| 4 | 2026-08-20 | Treated the recurring "phantom hand-off — heads-up push fired but no message in the owner's chat" as fully covered by the owner-resolution (mis-route) fix. | Two SEPARATE bugs. Bug #1 = wrong owner (mis-route). Bug #2 = a legitimate follow-up turn is stored under the RAW `entra_email` (`Von.Ellis@EnterpriseDS.io`) while the client back-fill (`getAllTurnUpdates`→`getUserTurnsSince`) queries under the CANONICAL `resolveTaskEmail` (`dev@enterpriseds.io`); `lower(user_email)` never matches → the finished turn can't render even though its push (which resolves the email separately) fired. | The actual `chat.pending_turns` rows: `followup-%` keyed under `Von.Ellis@EnterpriseDS.io`, but all 205 `u-%` interactive turns keyed under `dev@enterpriseds.io`. The email divergence was right there. | Diagnosed a two-cause symptom as one cause; didn't check the WRITE-side key against the READ-side query until forced. | Before calling a "notification fired but content missing" bug fixed, verify the write key and the read query use the SAME identity — grep every enqueue site's `user_email` against the reader's filter. A push firing proves nothing about whether the row is *matchable* by the renderer. |

| 4 | 2026-08-22 | Assumed/implied 1:1 turns don't go through the chunked engine ("1:1 is carried by a bigger sync budget, not chunking") when framing verification for ACT-56. | 1:1 chat ALSO runs chunked=true — `enqueueHuddleTurn` (the real HuddleView path for both 1:1 and group) always sets `turnId`, and `chunked = !!turnId` regardless of scope; `budgetMs===one-to-one?40s` is just a bigger per-agent timeout, not a chunking bypass. The verifier found a REAL pre-fix 1:1 occurrence of the same silent-zero-reply bug (`dm-finn-reid`, 2026-08-18, chunks=1 replies_len=0, latency ~40s). | The code itself (`const chunked = !!turnId`) plus which server fn the real UI calls — not an assumption about scope. | Reasoned from the `budgetMs` special-case for one-to-one and inferred a chunking bypass that isn't there — a proxy (a related-looking branch) instead of tracing the actual boolean. | Before claiming a code path is scope-gated, grep the actual boolean/condition, not an adjacent parameter that merely LOOKS related. |

## Note on what createOutlookEvent actually does (the real answer #2 was blocking)
`createOutlookEvent` (`execute-tool/index.ts:1701`) invokes `send-unified-notification` with
`channels:['OUTLOOK_EVENT']` and an `outlookEvent.reminder` — it **creates the Outlook event only**.
It does NOT arm journey's own full-screen alarm (`scheduled_notifications` → `calendar_events` channel
→ AlarmSoundService). So a relayed appointment that Iris drops into Outlook gives the user **Outlook's
native reminder**, not the journey/Huddle full-screen alarm — which is exactly what the user reported
seeing. (Journey's full-screen alarm for external events comes from `notification-scheduler` →
`calendar_event_reminder`, and only after `calendar-delta-sync` pulls the event back into
`external_calendar_events` — a lagged round-trip, not something `createOutlookEvent` arms directly.)

---

## 2026-09-08 — "there is no §5.2b in the widget spec" — read off a STALE working tree

**Claim made:** Working on `docs/specs/assignment-widget.md`, I stated plainly that the spec had
**no as-built section at all** — that `### 5.2b` did not exist, that the document was "still
entirely a proposal", and that anyone building the widget from it would code against a phantom
interface. I then wrote a replacement §5.2b from scratch.

**Ground truth:** `### 5.2b RESULT — the registry is BUILT, and here is exactly how much of §5.2 it
is` **already existed**, stamped 2026-09-08, merged in PR #53. It is BETTER than the section I
wrote: it carries the field-by-field delta with shipped / not-shipped / partial marks, the list of
fields added beyond the proposal, AND a correction stamp recording that the parity test's coverage
claim had been refuted. My duplicate had to be deleted — **3,523 characters removed** from my own
diff before the commit.

**The single source that would have settled it up front:**
`git show origin/main:docs/specs/assignment-widget.md | grep -n '5.2b'` — one command, against
**origin**, rather than `grep` against the working tree. The section appeared the instant I ran
`git checkout -B <branch> origin/main`; every grep before that had been reading a checkout that
predated PR #53.

**Root-cause pattern — and it is the nastier variant, not the plain one.** This is not "failed to
verify". I DID verify. I caught myself using a label from memory (`§5.2b`), stopped, announced the
correction, and grepped — **against the wrong copy of the file.** The verification step ran and
returned a confident false negative, which is worse than not checking, because it produced a
correction I then stated to the owner with more confidence than the original claim. The repo's own
rule already covers this and I applied only half of it: the rule is not "verify", it is **"answer
from `origin/main`, never from the local working tree"** — written for deploy-status questions, and
exactly as binding for "does this section exist".

Compounding factor: the working directory flipped between two repos several times across the turn
(`/home/user/nexus-hub` ↔ `/home/user/huddle-extension-app`), so which tree a bare `grep` read was
not obvious from the command.

**The guard it implies — a `grep` that returns ZERO is not evidence until it has been run against
`origin`.** A non-zero result proves presence from any copy; **absence proves nothing from a local
tree.** So: before writing or saying "X does not exist / there is no Y / this was never built",
re-run the search as `git grep <pattern> origin/main -- <path>` or
`git show origin/main:<path> | grep`. This costs one command and it is the same guard the log
already carries in another form — *"never claim a capability is ABSENT from a single-file /
single-name grep"* — which this miss proves is not yet reflexive. Absence claims are the ones that
need the strongest source, and they are consistently the ones given the weakest.

---

## 2026-09-08 — the log itself was not read, and three misses it had ALREADY catalogued recurred

Owner: *"are you updating and guarding according to the accuracy log and themes it identifies? wasn't
that a part of the hook instructions?"* It is — Stop-gate clauses **(l) accuracy-log** and
**(m) theme-mitigation** have been ALWAYS-required since v32 (2026-09-03). Answer: **partially, and
the gap is the interesting part.**

| | |
|---|---|
| `nexus-hub/.claude/accuracy-log.md` | 118 entries, **updated today** (the az `--offset` window defect) |
| `huddle-extension-app/.claude/accuracy-log.md` | 7 entries, **last touched 2026-08-24** — every huddle-side miss today went unlogged until now |

**Three of today's misses match themes ALREADY IN THE LOG, and I did not read it first.**

| today's miss | the theme it belongs to | prior instances |
|---|---|---|
| `turn_1925 = 5` read as "he told Huddle too" — a `LIKE '%1925%'` over a whole JSONB blob, matching ids and timestamps | **"the zero-over-wrong-population pattern"** (2026-09-06) — a count taken over the wrong population | logged as **three in one day**; this is the fourth, and the first in the *non*-zero direction |
| "zero assignments are due in the future", stated twice, used to argue the date filter was untestable — two were | **"it isn't stored / it needs a new import"** (2026-09-08) — asserting absence about data already present | logged that morning as **five times**; this is the sixth |
| "batches 5-7 were DEFERRED, correctly" — said from the pre-Option-B plan while eight `BATCH-*-RESULTS.md` files sat in the folder | **"absence is not evidence; read the record"** | the family the SessionStart banner warns about every single turn |

### The structural cause, which is not "I forgot"

**The accuracy log is PER-REPO, and the work is cross-repo.** The zero-over-wrong-population theme
was logged in `nexus-hub` on 2026-09-06. Today's instance of it happened while I was reasoning about
`RAG_AI_Agents` from the huddle side. **A theme recorded in one repo's log does not reach a session
working in the other**, and this integration spans two repos by construction — which is exactly the
class of work most likely to repeat a theme, because the two halves are read by different sessions.

The Stop gate cannot catch this either: it judges whether the log was UPDATED, not whether it was
READ, and updating one repo's log satisfies it.

### The guard this earns, stated as a check rather than an intention

**Before answering any "is X true / did Y happen / does Z exist" question in a cross-repo task, grep
the accuracy log of BOTH repos for the shape of the claim** — not for its subject. The three misses
above would each have been caught by searching for `zero|absent|never|none` in a log I had not
opened. Concretely, and cheap enough to actually do:

```
grep -hiE "zero|absent|never|no rows|not stored|deferred" \
  /home/user/*/.claude/accuracy-log.md | head -40
```

**And the narrower rule the second row earns, because it has now cost three separate answers:**
a measured COUNT of live data expires; a structural fact does not. Two copies of
*"534 assignments … 0 due in the future"* had been baked into `nexus.server.ts` and
`nexus-read-tools.test.ts` as though structural, and were quoted back to the owner twice as a reason
the date filter could not be tested. **Both are now deleted rather than restated** — a count with no
date and no expiry condition becomes a false constraint on advice.

## 2026-09-13 — "the next 9/13/17 tick" quoted as the confirm-ask cadence
**Claim I made:** a parked task "was a promotion candidate at the very next 9/13/17 tick, and the
confirm-intent gate waved it through" — stated repeatedly while explaining the pause defect.
**Ground truth (read this session):** `lib/identity/scheduling-config.server.ts` +
`identity.scheduling_config` (queried live via `azure-pg-query.yml`, marker `CADENCE-PROBE-0913`).
- `autowork.hours = [9,13,17]` IS still the live default — that half was right.
- **`CONFIRM_JITTER_MIN/MAX_MS` no longer exists in `src/` at all.** The confirm-ask reach-out is
  scheduled inside `CONFIRM_FAN_WINDOWS_DEFAULT` (9–18, 20–22) with a random 45–90 min gap. So the
  ASK does not ride the 9/13/17 tick, and my sentence welded two different clocks together.
- Other jobs are more frequent (`reviewDigest` 5×/day), which is what the owner was reacting to.
- The table had **0 rows**, so no per-user override was in play — but I did not know that when I
  asserted it; I asserted a default as though it were the effective value.
**Single source that would have settled it up front:** `scheduling-config.server.ts` itself, plus one
query of `identity.scheduling_config`. Both cheap. I quoted CLAUDE.md instead.
**Root-cause pattern:** quoting a LITERAL out of documentation rather than reading the code it
describes — the same failure as "never type a literal that must exist in something you have not read",
applied to a doc instead of a file. Docs rot; the owner noticed before I did.
**Guard implied (done):** CLAUDE.md's cadence block rewritten to name the real path, split the two
clocks, record that `CONFIRM_JITTER` is gone, and instruct re-querying the overrides table rather than
quoting defaults as fact. **The doc was the error's source, so the doc is where the guard goes.**
