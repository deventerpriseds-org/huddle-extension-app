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

## 2026-09-13 — THREE corrections in one cluster: values INVENTED to fill a gap, then defended by a test
All three shipped into `ec46286`, all three reached the owner as "fixed and pushed", and all three
share ONE root cause. Logged separately because each needs its own guard, then the class at the end.

### (1) Career and Ventures hues — invented, and effectively SWAPPED
**Claim:** `CATEGORY_HUES` = `CAREER: 340` (magenta), `VENTURES: 160` (teal), with a docblock
asserting the spec "names exactly two" colours (Life blue, Education amber) and that the other two
were therefore free to be "the two remaining quadrants, as far apart as the wheel allows".
**Ground truth:** the spec draws a coloured spine for EVERY top-level topic. Measured off
`docs/widgets/spec-priorities-widget.jpg`'s own pixels: **Career 149° green, Ventures 303° purple** —
151° and 143° from the invented values, and near enough to each other's TRUE hues that the two
categories rendered as swapped.
**Single source that would have settled it:** the JPEG itself — and, cheaper still,
`docs/AC-journey-widgets.md:51-52`, which had **already recorded all five** ("green (Career), purple
(Ventures), orange (Education), blue (Life), grey (Family)"). The code contradicted its own
acceptance criteria, written by an independent pass, days before.
**Root-cause pattern:** an aesthetic rule was invented to fill a gap that only LOOKED like a gap. The
premise ("the spec names two") was never checked against the spec.
**Guard (shipped, mutation-proved FIRED):** `scripts/widget-colors.test.ts` now asserts a hue BAND
for all four categories against the spec, not just the two that happened to be documented. Guarding
only the documented subset is precisely what let the other two drift.

### (2) The 60° separation floor — invented, and it REJECTED the spec's own palette
**Claim:** `MIN_GAP = 60`, described as the threshold under which two hues "read as the same colour".
**Ground truth:** the spec's real four have a closest pair of **~53°** (Life 250 / Ventures 303). The
floor therefore failed the very design the file exists to reproduce — a fourth mutation showed it
would have **blocked the fix for (1)**.
**Single source:** computing the pairwise gaps of the spec's measured hues — four numbers, which the
test file itself already had the helper (`hueGap`) to do.
**Root-cause pattern:** THE SAME invention, one layer up. A plausible-sounding number was written
into an assertion, which converted a guess into something believed and enforced. A test that fails
the ground truth is not strict, it is wrong, and it is worse than no test.
**Guard (shipped):** the floor is now DERIVED — 45°, stated in-file as "below the spec's own
minimum", with the reasoning and the measured 53° recorded beside it so the next person cannot
re-tighten it without meeting the spec first.

### (3) Family — a hue where the spec wanted GREY, colliding with Ventures
**Claim:** leaving `FAMILY` out of the seeded map was neutral, because the hash would give it "a
stable, distinct colour".
**Ground truth:** the hash puts FAMILY at **300°, three degrees from Ventures' 303°** — the two
render as the same purple, in the one tree that shows them together. The spec draws Family GREY, and
grey is not a hue at any value; it is a **chroma of zero**.
**Single source:** running `categoryHue("FAMILY")` — one line, which the suite was already importing.
**Root-cause pattern:** "the fallback handles it" asserted without executing the fallback. Same
family as (1) and (2): a property assumed rather than measured.
**Guard (shipped, mutation-proved FIRED):** `categoryChromaScale()` scales the caller's chroma to 0
for grey categories, and the suite asserts the FAMILY/VENTURES hue collision is rendered harmless —
asserting the collision exists and is neutralised, rather than pretending the hues differ.

### The CLASS, and why prose cannot hold it
One pattern, three instances, one session: **a value that must match an external artifact was
invented from a plausible-sounding rule, and no one executed or measured the artifact.** Prose
("read the spec") does not bind — the docblock asserting "the spec names exactly two" was itself
written by someone who had the spec open.
**Structural mitigation, and it is the one that actually fires:** every value that must match the
spec is now asserted against a measured band in an executable test, and each assertion was
mutation-proved. A future invented value FAILS `npm run test:widget-colors`; it does not merely
contradict a comment.

### (4) A guard that was INERT because I appended it after `process.exit()`
**Claim (to myself, mid-task):** the new Family tests were added to the suite.
**Ground truth:** they sat BELOW `console.log(summary)` + `process.exit(...)` at the end of the file,
so they never executed. The suite kept reporting **18 passed** while looking seven assertions longer.
**Single source:** the printed pass COUNT — 18, not 25. It was on screen and I read past it.
**Root-cause pattern:** appending to a file without reading how the file ENDS. A script with a
terminal `process.exit` has no "end of file" to append to.
**Guard implied, NOT yet built:** nothing structurally stops the next append-after-exit. The honest
status is that this one was caught by looking at the count, which is exactly the kind of vigilance
this log exists to stop relying on. Candidate: a lint rule or a suite-level assertion that the
reported total matches the number of `check(` calls in the file. **Not built — do not record this row
as mitigated.**

## 2026-09-13 — SHIPPED FOUR VISUAL DEFECTS TO PRODUCTION; the owner found them, the suites could not
The costliest miss of this session, and the only one a user saw in the live product.

**Claim:** "Merged + deployed. tsc exit 0, 67 assertions green across four suites, three mutation
proofs FIRED, three independent verification loops." Reported as shipped.
**Ground truth (the owner, on his phone, in ONE screenshot):**
1. The priority band renders **pink**, where the spec is pale yellow.
2. **Two navigation bars stacked** — mine sits directly on top of one that already existed.
3. That bar is at the **TOP** of a phone screen, where primary nav does not belong.
4. Full-page views render as **small cards in an empty panel**.
Plus: Priorities is not a faithful port of journey's view.

**Root causes, both ground-truthed from source:**
- **Pink:** `BAND_STYLE = color-mix(in oklch, var(--warning) 9%, var(--surface))`. `--surface` is
  `oklch(1 0 0)` — white carrying an EXPLICIT hue of 0. A polar space interpolates hue, so 9% of
  hue-55 orange against hue-0 lands on **hue ≈5, chroma ≈0.014: pale pink**. `docs/widgets/prototype/
  Priorities.dc.html` had the CORRECT literal (`oklch(0.975 0.032 92)`, cream) — the prototype was
  right and the implementation silently diverged from it.
- **Two nav bars:** `HuddleView.tsx:190-206` ALREADY rendered a view switcher calling the same
  `setView`, with the Meeting button beside it. I added a second five-entry bar in `HuddleApp.tsx`
  instead of extending it. A straight **"extend, don't duplicate"** violation — the org's own first
  rule — committed in the most visible element of the app.

**Single source that would have settled ALL of it:** opening the app at 390px and looking. Failing
that, `src/styles.css` for the token, and one grep for an existing switcher before adding one.

**Root-cause pattern — and this is the part worth carrying:** every check I ran tested LOGIC. Types,
enums, mappings, tag unions, cadence arithmetic, guard mutations. **Not one of them rendered
anything.** So a colour could drift 87° off-hue, a duplicate nav could stack, and a layout could
collapse into a card, and the suite stayed green through all of it. Three verification loops asked
"is the logic right", never "what does this look like". Confidence came from the green count, and the
green count was measuring the wrong dimension entirely.

**Guards:**
1. **SHIPPED — `ship-ui-that-belongs`** in eds-claude-skills (PR #83): the mandatory pre-flight for any
   user-visible change — grep for the nav that already exists and EXTEND the incumbent; copy the
   nearest existing component's anatomy; every visual value from real resolved tokens, never invented
   or rounded; decide the PHONE layout first (bottom nav, safe-area insets, full-panel views). It
   opens with the rule this miss earned: *a passing suite cannot see a visual defect.*
2. **SHIPPED — the colour trap is recorded with its measured numbers**, because "use color-mix" reads
   as safe and is not: mixing against a neutral that carries an explicit hue MOVES THE HUE.
3. **IN FLIGHT — a hue assertion on the band**, mutation-proved, so the next silent colour drift fails
   a test instead of reaching the owner.
4. **NOT BUILT, and I am not claiming otherwise:** nothing in this repo renders a component and looks
   at it. Until something does, "verified" for UI means a human opened it. `verify-uat.yml` +
   Playwright-in-GHA already exist and could screenshot at 390px — that is the real structural fix and
   it is unbuilt.

## 2026-09-13 — "topics aren't available" — one ROUTE's absence reported as the DATA's absence

| | |
|---|---|
| **Claim** | The topic tree stays empty "until journey deploys `get_task_topics`." |
| **Ground truth** | Two journey surfaces already show the full tree. Both read `task_topic_index` **directly over PostgREST with the USER's session** (`Priorities.tsx:222`; `SupabaseTaskClient.kt:219`). Huddle holds only `JOURNEY_PROXY_TOKEN`, so it reaches only named `execute-tool` tools. The data was never missing; **Huddle's route to it was.** |
| **One source that settles it** | One grep for `task_topic_index` across journey-voice **and** the bridge repo. Never run. |
| **Root-cause pattern** | Stated a CONCLUSION ("not available") where only a PREMISE held. Same shape as the dead-connector rule already in CLAUDE.md — *one route failing is never proof the destination is unreachable* — applied to a data source. |

### Two defects that would have shipped, both from unmeasured shapes

1. **`parent_topic_id` is NULL on all 158 rows** (`select count(*), count(parent_topic_id) …` → 158, 0).
   `buildTopicTree` nested on it alone → 158 flat rows. **Nothing tested `buildTopicTree`**, and every
   hand-written fixture invented a `parent_topic_id` the real table has never contained.
2. **The fix then clobbered journey's sub-group work** — it bailed out of category grouping whenever any
   node had children, so the first sub-group would have deleted the category level. journey's tree is
   four levels (`category > group > sub-group > task`, `f0ab561`) and the two COMPOSE.
   **The owner caught this, not a test.** Its sibling: my labels came from journey's `origin/main`
   (six rows) when the live view runs an unmerged branch (five merged rows).

### Guard (shipped, deployed `1a9be2b`)
`scripts/widget-topic-tree.test.ts` — 17 assertions built from journey's **real** payload shape; two
mutation proofs **FIRED** (sub-group compose survives; six-into-five category merge).

### The reusable rule — structural mitigation
**A fixture is a claim about a shape. Measure the shape before writing the fixture.** The existing rule
*"never type a literal that must exist in something you have not read"* covers literals in files; this
extends it to **the shape of live data**, where the feedback loop is far slower because a hand-written
fixture cannot disagree with production — it silently ratifies the assumption and reports it back as a
green count. One read-only `execute_sql` against the source table costs one command.

**Second rule, from defect 2:** *before porting a UI, find which REF is actually live.* `origin/main` is
not it by default — journey's Priorities view runs an unmerged branch, and journey's clone has a
truncated history, so `git log origin/main` there cannot prove anything was never shipped.

## 2026-09-13 — FOUR corrections on the artifact-format work, ALL found by an independent verifier
`docs/VERIFY-artifact-formats-2.md` — **8 CONFIRMED, 2 REFUTED**. Every one of these got past the
implementing lanes' own suites (52 + 28 + 21 green assertions) and past me. Fixed in `b043afb`,
deployed. Logged separately because each earns its own guard; the class is at the end.

### (1) "All four dispatch sites are rewired" — I VERIFIED THE WIRING AND CALLED IT THE CAPABILITY
| | |
|---|---|
| **Claim** | Reported to the owner: four dispatch sites rewired to `createArtifactFromAgent`, so `format` works everywhere. |
| **Ground truth** | The *call sites* were all rewired. But **two of the four declare their own tool schema and neither had `format`.** Lovable (`huddle.functions.ts` ~4829) borrowed `CREATE_ARTIFACT_TOOL.description` — the text reading *"YOU ARE NOT LIMITED TO MARKDOWN: set `format` to 'docx'"* — while its zod `inputSchema` silently STRIPPED the field. Voice (`realtime-tools.server.ts` ~287) had `additionalProperties: false` with no `format`, so the model could not emit one even in principle. **The owner's original bug was still live on two of four paths after I reported it fixed.** |
| **Single source** | The `inputSchema` / `parameters` block at each dispatch site — not the `createArtifact(` grep I actually ran. |
| **Root-cause pattern** | Checked the PROXY (does the call site call the new function?) instead of the GROUND TRUTH (can the model emit the field?). The same "answered from a proxy" shape as every other entry in this log, applied to a tool schema. A borrowed description is worse than none: it promises a field the schema removes. |
| **Guard** | `artifact-format-dispatch.test.ts` + an in-file rule at both sites: *if you add a field to `CREATE_ARTIFACT_TOOL`, add it here or this path quietly lies.* **Still prose at the two sites** — the real structural fix is for every path to derive its schema FROM `CREATE_ARTIFACT_TOOL` instead of hand-writing one. Not built; recorded as the open item, not as mitigated. |

### (2) PATH TRAVERSAL reaching the user's real OneDrive
| | |
|---|---|
| **Claim** | Implicit: artifact names are safe because `slug()` sanitises. |
| **Ground truth** | `slug()` protects the **blob path** only. Nothing sanitised `artifacts.items.name`, and `onedrive.server.ts:21` encodes per segment with `encodeURIComponent`, **which does not encode `.`** — so a name of `../../etc/passwd` escaped the "Huddle Artifacts" folder on a real user's drive. Model-authored, outward-facing. |
| **Single source** | `onedrive.server.ts:21` — reading how the upload path is actually built, rather than assuming the blob-path sanitiser covered every consumer. |
| **Root-cause pattern** | Assumed one sanitiser at one layer covered every downstream consumer of the same value. Two consumers, one guarded. |
| **Guard** | `safeArtifactName()` applied ONCE at the choke point so blob path, DB row and mirror all receive the same value. Six traversal payloads asserted, plus an assertion that it does NOT eat legitimate dots/digits/spaces. **Mutation-proved FIRED.** |

### (3) The mime override lied in the direction I did not think of
| | |
|---|---|
| **Claim** | "An explicit `mime` cannot make an artifact misrepresent itself." |
| **Ground truth** | The guard tested `rendered.mime`, which blocks a real `.docx` labelled `text/markdown` — and left the reverse wide open. `{format:"md", mime:"…wordprocessingml.document"}` stored three bytes of markdown (`23 20 52`, not a ZIP's `50 4b 03 04`) under the Word mime: `report.docx` downloads and Word refuses to open it. |
| **Single source** | Running the guard against BOTH orderings. I only ever ran the one I had in mind. |
| **Root-cause pattern** | **A one-sided guard on a two-sided problem.** I tested the failure I imagined, then stopped. Same family as the invented 60° hue floor earlier today: an assertion written from the hypothesis rather than from the space of inputs. |
| **Guard** | Both sides must be non-package types. All three directions asserted, including that the legitimate text→text escape hatch still works. |

### (4) `" DOCX "` degraded silently to markdown
| | |
|---|---|
| **Claim** | `format` matching handles what the model sends. |
| **Ground truth** | Only exact lowercase matched; stray casing or whitespace fell through to the markdown default with no warning. |
| **Single source** | Calling it with `" DOCX "`. |
| **Root-cause pattern** | Trusted model output to be normalised. Model output is never normalised. |
| **Guard** | `.trim().toLowerCase()` at the choke point, asserted. |

### Caught by me, not the verifier — and it nearly broke every filename
The control-character class landed in source as **literal NUL and 0x1F bytes** rather than ` `/``
escapes. Functionally the same range, so it worked — but raw control bytes in source get mangled
silently by diffs and editors, and had they been re-read as the printable range `space`→`<` the class
would have stripped **dots and digits out of every filename**. Found by reading `od -c` of the line
after the file-change notice rendered it as `[ -<>:"|?*]`. **Rule: when a rendered line disagrees with
what you wrote, check the bytes, not the render.** File now asserted to contain zero raw control bytes.

### The CLASS, and the one structural change it actually earns
Three of these four are the same error: **I verified the thing I could see from where I was standing.**
The call site, not the schema. The one mime direction I imagined, not both. Exact-match format, not the
input space. The implementing lanes' suites were green on all of it, because each lane tested its own
half and nothing tested the SEAM.

**What genuinely mitigates this is not another assertion — it is that an independent pass ran at all.**
Loop 2 found four defects that 101 green assertions did not, and it found them in under 30 minutes by
reading the code cold and trying to break it. The structural conclusion: for work assembled from
parallel lanes, an independent cross-lane verification is not ceremony, it is the only thing that
looks at the joins. **A single lane cannot verify a seam it is one side of.**

### Process note, honestly stated
Loop 2's brief was declared as `loop: 1`. Loop 1 had run the identical brief and been killed before
its first push, leaving zero durable evidence — so I mis-numbered the re-run as a first pass. Corrected
mid-run by message (the artifact is `VERIFY-artifact-formats-2.md` with a truthful empty PRIOR STATE),
but the declared brief text was already wrong. **The next verification of `artifact-formats` is loop 3.**
Related: I also reported loop 1's C3 as "banked" when it had never been pushed — a partial result read
off an agent's status line and treated as durable evidence, which is precisely what the per-claim push
rule exists to prevent.
