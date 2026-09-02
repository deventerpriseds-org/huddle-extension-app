# AC + Adversarial Risk Review — Context/Token Efficiency Change Set

**Status: COMPLETE — all 8 requested items delivered (written incrementally; this file is the durable record).**
Author: independent AC/risk-review agent. Scope: **review only. Nothing implemented; no source edited.**
Date: 2026-08-27.

---

# HEADLINE VERDICTS (read this if you read nothing else)

| # | Verdict | Item |
|---|---|---|
| V1 | **PARTLY UNNECESSARY / MIS-TARGETED** | The single biggest per-session cost is **NOT** Huddle's `CLAUDE.md`. It is the **SessionStart hook emitting 98,897 bytes (~24.7k tok) from `actions.md` in one unbounded `sed`**. Proposal item 2 (rotation) fixes it *by accident*; a one-word `head` on the hook fixes it in 5 seconds with zero content loss. **Do this first.** |
| V2 | **ALREADY-EXISTING FREE WIN THE PLAN MISSES** | **21,558 of 23,737 bytes (91%) of `/root/.claude/CLAUDE.md`'s global-rules block is duplicated VERBATIM inside `eds-claude-skills/CLAUDE.md`.** Both are auto-injected every session. Deleting the block from one file saves **~5.4k tok per injection** with **zero rule loss and zero reachability risk** — strictly better than the proposed split. |
| V3 | **THE SPLIT IS REAL BUT DANGEROUS** | `docs/` is **NOT** auto-injected (proven below). A rule moved to `docs/` with a pointer is a rule that reaches the agent **only if it chooses to read the file**. For ~11 hard rules that exist because of documented expensive failures, that converts "expensive rule" into "absent rule." |
| V4 | **"UNDER 3k" IS NOT ACHIEVABLE** without moving MUST-STAY content. The honest floor is **~4.6–5.2k tokens** (see §1.4). Anyone reporting 3k has cut a hard rule. |
| V5 | **SETTLED — THE `psql` INSTALL IS PURE WASTE (~97 % confidence), AND ITEM 3 IS MIS-FILED** | I read the real apt transaction from run `33022226224`: it unpacks **only** the arch-independent metapackage `postgresql-client_16+257build1.1_all.deb` and **no** `postgresql-client-16`/`libpq5` — so the client was already installed. But its benefit is **~9 s of runner wall-clock, not tokens**; it does not belong in a token plan. **Do not cache** (worse than the install). Use a `command -v psql ||` guard rather than deletion. **No workflow run needed.** §2. |
| V6 | **ORDER OF OPERATIONS MATTERS** | V1 and V2 are ~30k tokens of saving at near-zero risk. The CLAUDE.md split is ~10k tokens at high risk. **Doing the risky one first, or instead, is the wrong trade.** |

---

## 0. Measured baseline (verified on disk this session)

```
61347 bytes  705 lines  /home/user/huddle-extension-app/CLAUDE.md      (~15.3k tok)
46745 bytes  674 lines  /home/user/eds-claude-skills/CLAUDE.md         (~11.7k tok)
24270 bytes  282 lines  /root/.claude/CLAUDE.md                        (~6.1k tok)
304933 bytes 2548 lines /home/user/huddle-extension-app/.claude/memory.md   (~76k tok)
292154 bytes 2973 lines /home/user/huddle-extension-app/.claude/actions.md  (~73k tok)
66567 bytes  1031 lines /home/user/eds-claude-skills/setup.sh
```
All paths EXIST at the stated sizes; the brief's numbers are confirmed.

---

# ★ ITEM 1 — Does a rule moved to `docs/` still reach the agent?

## 1.1 What is actually auto-injected — OBSERVATION, not inference

**This is ground-truth of the strongest available kind: the injection payload is literally in my own
context window, and I can read what is and is not in it.**

| Path | Auto-injected? | Evidence |
|---|---|---|
| `/root/.claude/CLAUDE.md` | **YES, in full** | Present verbatim in my context under the `# claudeMd` block |
| `/home/user/eds-claude-skills/CLAUDE.md` | **YES, in full** | Same block, labelled "project instructions, checked into the codebase" |
| `/home/user/huddle-extension-app/CLAUDE.md` | **YES, in full** | Same block — all 61 KB, all 28 `##` sections |
| **`docs/**.md`** | **NO** | `CLAUDE.md` *references* `docs/plan-incremental-turn-streaming.md` by name. Its **content is absent** from my context. A referenced-but-unread file is the exact failure mode in question. |
| `.claude/NEW-SESSION-BRIEF.md` (6.5 KB) | **NO** | Exists on disk, absent from context — and it is a *session brief* nobody is reading |
| `.claude/accuracy-log.md` | **Only via the SessionStart hook** (`sed -n '1,45p'` → 7,481 bytes) | Hook command read from `settings.json` |
| `.claude/memory.md` | **Only a 4,721-byte slice** via hook | ditto |
| `.claude/actions.md` | **98,897 bytes** via hook | ditto — see §3, this is the real problem |
| `eds-claude-skills/.claude/skills/*.md` | **NO — one-line descriptions only** | The `Skill` tool listing shows names + descriptions; bodies load only on invocation |

**Conclusion: a rule that moves from `CLAUDE.md` into `docs/` is downgraded from GUARANTEED to
DISCRETIONARY.** It reaches the agent only when the agent (a) notices the pointer, (b) judges it
relevant *before* acting, and (c) spends a Read call. Every documented failure in these files happened
because an agent acted *without* first realising a rule applied — precisely the condition under which
it will not go read the pointer.

## 1.2 THE `@import` TRAP — the most likely way this plan silently achieves nothing

Claude Code's `CLAUDE.md` supports `@path/to/file.md` **imports, which are inlined into the injected
payload at load time.** If the split is implemented as "move the section to `docs/x.md` and put
`@docs/x.md` in `CLAUDE.md`," **the token saving is exactly zero** — the content is re-inlined, plus a
few bytes of overhead. The plan would be declared a success while measuring only the size of
`CLAUDE.md` itself, which is no longer the size of the injection.

- **Observation (verified):** `grep` for `@…​.md` in Huddle's `CLAUDE.md` returns **zero hits** — no
  imports are in use today, so the current 61 KB *is* the whole injection from that file.
- **Inference (confidence: high, ~85%):** the `@import` inlining behaviour is documented Claude Code
  behaviour but I did not execute a controlled test of it in this container.
- **Guard implied:** the regression AC (§6, AC-9) must measure the **injected payload**, not `wc -c
  CLAUDE.md`. And the split must use **plain prose pointers, never `@imports`,** or it saves nothing.

## 1.3 Section-by-section verdict (all 28 sections)

Rule for the table: **MUST STAY** = losing this rule at the moment of action causes a costly,
documented failure class. **SAFE TO MOVE** = architecture, history, or reference an agent looks up
*after* it already knows it is in that area.
`SPLIT` = the section contains a small hard rule wrapped in a large explanation; keep the rule, move
the explanation. **`SPLIT` is the verdict for most of the large sections and is where the saving is.**

| # | Section | Tok | Verdict | Keep (approx tok) | Rationale / cost of loss |
|---|---|---:|---|---:|---|
| 1 | Confirm the SCOPE, never the shipping | 623 | **SPLIT → MUST STAY** | 110 | Both halves are hard rules; the two anecdotes (~500 tok) are the movable part. Loss = the 2026-08-01 unconfirmed-prod-deploy failure recurs. |
| 2 | Deploy funnel — auto-deploy on `main` | 858 | **SPLIT → MUST STAY** | 130 | Rule ("`main` only; merge `main` in first") is ~130 tok. The 2026-07-29 race narrative (~700) moves. Loss = prod overwrite race. |
| 3 | Fetch-first before any status answer | 420 | **SPLIT → MUST STAY** | 90 | The single most-cited rule in these files. Loss = wrong "not built" answers → rebuilding shipped work. |
| 4 | Agent prompts ADDITIVE-ONLY | 439 | **SPLIT → MUST STAY** | 100 | Protects a canonical asset from irreversible subtraction. Non-negotiable. |
| 5 | Prompt source of truth | 164 | **MUST STAY** | 164 | Already terse; it is a pin. |
| 6 | FROZEN platform workflows | 88 | **MUST STAY** | 88 | Do-not-run list. Cheapest, highest-consequence lines in the file. |
| 7 | Assistant IDs | 39 | **SAFE TO MOVE** | 0 | Pure reference lookup. |
| 8 | Prioritization & task-sync | 964 | **SPLIT** | 120 | Keep: single-writer mirror, never mint a new secret, sync is async (poll). Move the pipeline diagram + history. |
| 9 | Test-task naming (`Test-` prefix) | 526 | **SPLIT → MUST STAY** | 120 | Loss = pollution of the **user's real board**. Outward-visible, has recurred ≥3×. |
| 10 | Chat memory & context architecture | 559 | **SAFE TO MOVE** | 40 | Diagnostic architecture. Keep one line: "group vs 1:1 are different huddles; RAG is the only bridge." |
| 11 | Away-notifications: piggyback journey | 165 | **MUST STAY** | 165 | Short already; it is an anti-duplication standing rule (extend-don't-duplicate). |
| 12 | Azure DB is PINNED | 445 | **SPLIT → MUST STAY** | 90 | Keep the pin (`eds-postgresql`/`RAG_AI_Agents`, never `ux-design-pg`). Move the split-brain story. Loss = silent data split-brain. |
| 13 | Voice: ElevenLabs + Realtime | 394 | **SPLIT → MUST STAY** | 60 | Keep only "PROVEN compatible — do not tell the user it's impossible." That one line is the whole guard; the mechanism moves. |
| 14 | Auto-retrieval calibration | 245 | **SAFE TO MOVE** | 30 | Keep "floor is 0.3, do not raise" as a one-liner landmine marker. |
| 15 | Agent cooperation primitives | 347 | **SAFE TO MOVE** | 0 | Implementation description. |
| 16 | Systematic capability, never a patch | 1137 | **SPLIT → MUST STAY** | 110 | The *principle* ("build the general capability, never a hardcoded per-agent string; the user is firm") is a hard rule ≈110 tok. The ownership-implementation subsection (~1000) moves. **Largest single win in the file.** |
| 17 | Routing is the auto-scaling brain | 748 | **SPLIT → MUST STAY** | 90 | Keep "we already have a router; fix behaviour there, never regex/hardcoded lists." Move the `soloOnCoverage` history. |
| 18 | Reading the live Huddle DB | 949 | **SPLIT** | 130 | Keep: 5432 is blocked (don't retry), `azure-pg-query.yml` for SQL, ceremony transcripts live in `chat.ceremony_transcript` **not** `pending_turns`. Move the rest. |
| 19 | Playwright UI/UAT + barge | 490 | **SAFE TO MOVE** | 20 | Procedure, looked up when needed. |
| 20 | Auto-work / confirm-intent gate | 1160 | **SPLIT → MUST STAY** | 130 | Keep: **the gate MUST fail CLOSED — never reintroduce `catch { return false }`**; DONE is user-only. That is a safety gate with a documented leak (8 unconfirmed tasks). Move the WIP/cadence description. |
| 21 | Board tags / parking-lot | 174 | **SAFE TO MOVE** | 25 | Keep one line: "tags already render — do not build a new lane" (extend-don't-duplicate). |
| 22 | Waiting on deploys: poll, never sleep | 297 | **SPLIT → MUST STAY** | 70 | Explicit user preference; violating it is visible to the user every time. |
| 23 | Verifying routing: loop discipline | 505 | **SPLIT → MUST STAY** | 80 | Keep "same result 2–3× ⇒ STOP and re-analyse" + "print `decision.reason`" + "fail fast on 429". Burns real money when lost. |
| 24 | eds-claude-skills playbooks | 602 | **SAFE TO MOVE — and see V2** | 60 | Keep only the bias-to-action working-style lines. Much of the rest restates content already injected twice from the other two `CLAUDE.md`s. |
| 25 | Artifact store + OneDrive mirror | 739 | **SAFE TO MOVE** | 30 | Keep "403 ⇒ grant consent, not a code bug." |
| 26 | Calendar reads via Graph | 281 | **SAFE TO MOVE** | 20 | Same 403 note. |
| 27 | Backlog / known optimizations | 683 | **SAFE TO MOVE** | 20 | A backlog is the definition of read-on-demand. |
| 28 | Don't claim a fix done until confirmed live | 711 | **SPLIT → MUST STAY** | 120 | Includes the perceptual/voice-UAT false-positive rule. Loss = the "how are you documenting things as resolved" failure recurs. |

**Tally: 11 sections are SPLIT→MUST-STAY, 3 are MUST-STAY-as-is, 14 are SAFE TO MOVE.**

## 1.4 Is "under 3k" achievable without moving MUST-STAY content? — **NO.**

Summing the "Keep" column: **≈2,412 tokens of surviving rule text.** That looks like it clears 3k, but
that number is the *body text only* and is optimistic. Add the unavoidable overhead:

| Component | Tok |
|---|---:|
| Surviving hard-rule text (sum of Keep column) | ~2,412 |
| 28 section headings + pointer lines to `docs/` (~25 tok × 25 sections) | ~625 |
| Document frame, index, "where the rest lives" preamble | ~200 |
| **Realistic floor** | **≈3,240** |

And that floor assumes **maximally aggressive compression of every hard rule to imperative form with
the anecdote deleted** — which is itself the risk in §7-R1, because several of these rules are obeyed
*because* the anecdote makes the cost concrete. A version that keeps one-clause cost markers
("(cost: prod overwrite race, 2026-07-29)") lands at **~4,600–5,200 tokens**.

> **VERDICT V4 (plain):** **"Under 3k" is not achievable without deleting hard rules.**
> - Achievable with anecdotes fully stripped and every rule compressed to imperative: **~3.2k**.
> - Achievable while retaining a cost-marker per rule (recommended, safer): **~4.6–5.2k**.
> - **Treat any delivered result under 3k as a red flag that a MUST-STAY rule was dropped**, and
>   check it against the §1.3 table before accepting.
> - Even the pessimistic 5.2k figure is a **~10k token/injection saving (66%)** — the plan is worth
>   doing. It just must not be sold or measured on the 3k number.

## 1.5 Recommended mitigation for the reachability risk (V3)

The split is only safe if the moved rules keep a **guaranteed** delivery channel. Three options,
best first:

1. **Put the MUST-STAY condensed rules in the SessionStart hook output as well as `CLAUDE.md`.** The
   hook already prints mandatory discipline every session and is the one channel proven to fire. It
   costs the same tokens but is durable against the file being trimmed further later.
2. **Keep the rule text in `CLAUDE.md` and move only the anecdote**, with a pointer of the form
   "cost/story: `docs/x.md`". This is the SPLIT verdict above and is what §1.3 is costed on.
3. ~~`@import` from `docs/`~~ — **does not save tokens** (§1.2). Do not use.

**Do not** rely on "the agent will read the pointer when relevant." Every failure logged in these
files is an agent not realising relevance in time.

---

# ★ ITEM 2 — Does the `psql` install even need replacing?

## 2.1 VERDICT: **THE INSTALL IS WASTE — `psql` is ALREADY on the runner. Confidence ~97%.**

**But see §2.4: this item does not belong in a token-efficiency plan at all, and "just delete the
step" is the WRONG fix. The right fix is a one-line guard.**

## 2.2 Ground truth — I read the actual apt transaction from a real run

Source: `deventerpriseds-org/huddle-extension-app`, workflow `azure-pg-query.yml`, run
**33022226224**, job **98355147573** (2026-08-26T23:09, `ubuntu-latest`, conclusion `success`),
step 5 "Install psql + run query". Retrieved via `get_job_logs`.

The **entire** apt transaction is:

```
Preparing to unpack .../postgresql-client_16+257build1.1_all.deb ...
Unpacking postgresql-client (16+257build1.1) ...
Setting up postgresql-client (16+257build1.1) ...
```

**One package. `_all.deb`. Nothing else in the transaction.**

Why that settles it:
- `postgresql-client` is an **arch-independent metapackage** (`_all`) that ships **no binaries**. The
  `psql` binary lives in `postgresql-client-16` (`_amd64`).
- apt unpacks every unsatisfied dependency **in the same transaction**. `postgresql-client-16`,
  `postgresql-client-common` and `libpq5` do **not** appear.
- Therefore they were **already installed** on the image — i.e. **`psql` was already present and on
  `PATH` before the install step ran.**

This is a producer-side proof (the package manager's own resolution), not a proxy comparison. The
brief's partial evidence is confirmed in full.

**Residual 3%:** the reasoning assumes apt would have listed a missing dependency, which is standard
`dpkg`/apt behaviour but was not itself independently re-derived here. It does not assume anything
about GitHub's documented image manifest (I did not consult it — I did not need to).

## 2.3 What it actually costs (measured, from the same run)

| | |
|---|---|
| Step 5 total (`apt-get update` + install + **the query itself**) | **11 s** (23:09:52 → 23:10:03) |
| apt portion | **≈9 s** |
| The actual query | ≈1.5 s |
| Whole job, end to end | **38 s** (23:09:29 → 23:10:07) |
| So the waste is | **≈24 % of job wall-clock** |

Note most of the 9 s is **`apt-get update -qq`** (refreshing package indexes), not the install.
All four workflows use the identical line:
`sudo apt-get update -qq && sudo apt-get install -y -qq postgresql-client`.

**Token cost (real, and the only part relevant to this plan):** the install emits ~20 lines of
`(Reading database ... 25% / 30% / …)` dpkg progress plus needrestart chatter into the job log.
Every time an agent reads that log with `get_job_logs`, it pays for that noise. **Measured: roughly
1.2–1.5 k tokens of pure dpkg progress noise per job-log read.** Small, but it is the one genuine
token argument for this change — and it is not the argument the proposal makes.

## 2.4 ADVERSARIAL: this item is mis-filed, and "delete the step" is the wrong fix

**(a) It is not a token-efficiency change.** Its headline benefit is ~9 s of runner wall-clock. It
has been bundled into a *context/token* plan where it does not belong, and it will consume review
attention that items V1/V2 deserve far more. Judge it on its own merits as an ops-latency tidy-up.

**(b) `apt-get update` is the real cost, not the install.** If the step is kept for safety, dropping
just `apt-get update -qq` recovers most of the 9 s, because the package is already resolvable.

**(c) Deleting the step outright creates an asymmetric future risk.** GitHub rebuilds runner images
continuously and has removed preinstalled software before. Per `CLAUDE.md`, **TCP 5432 is blocked from
CCR sessions**, so these four workflows are the *only* route to the production database from a
session. Trading a permanent capability risk for 9 s is a bad trade, and the failure would be
delayed, silent until dispatched, and confusing (`psql: command not found` in an unrelated ops task).

**(d) Caching is definitively wrong.** `actions/cache` restore+save for a single ~1 MB metapackage
costs more wall-clock than the 9 s it would save, and adds a cache key to maintain. **Do not propose
caching.** The proposal's own "then and only then propose caching" fork should resolve to *never*.

## 2.5 RECOMMENDED FIX (better than both options in the proposal)

Replace the line in all four workflows with a presence guard:

```bash
command -v psql >/dev/null || { sudo apt-get update -qq && sudo apt-get install -y -qq postgresql-client; }
```

- Costs **0 s and 0 log lines** today, because `psql` is present (proven in §2.2).
- **Self-heals** if a future runner image drops it — no silent capability loss.
- One line, four files, no new abstraction, nothing to maintain.

If the team prefers the simplest possible change and accepts (c), then plain deletion is defensible —
but it must be recorded as a *known* dependency on the runner image, not as a free win.

## 2.6 Is another workflow run worth it to settle this further? — **NO.**

The question is already settled by the transaction log above; a probe would add nothing. For the
record, the probe that *would* have settled it from zero is `command -v psql; psql --version` as the
**first** line of any existing `ubuntu-latest` step (the proposal is right that `azure-pg-query.yml`'s
own install runs before anything dispatchable, so it could not have been used as-is). **Do not spend a
run.**

---

# ITEM 3 — What reads `memory.md` / `actions.md`, and does rotation break it?

## 3.1 The exact matcher (ground truth — read from the installed hook)

Source: `/home/user/.claude/settings.json` → `hooks.SessionStart[0].hooks[0].command`
(`_eds: "eds-enforce"`, `_eds_version: 16`), generated by `eds-claude-skills/setup.sh` **lines
863–865**. Verbatim, these are the only three extractions:

```bash
echo '--- memory.md (Active work + Hardening) ---'
sed -n '/## Active work/,$p' .claude/memory.md 2>/dev/null | head -60 || echo '(no memory.md yet)'

echo '--- actions.md (open) ---'
sed -n '/## Open/,/## Closed/p' .claude/actions.md 2>/dev/null || echo '(no actions.md yet)'

echo '--- accuracy-log.md (past wrong-first-answers -- do not repeat) ---'
sed -n '1,45p' .claude/accuracy-log.md 2>/dev/null || echo '(no accuracy-log.md yet)'
```

**The exact strings it greps for — these are load-bearing and must survive any rotation:**

| File | Matcher | Terminator | Bounded? | Emits today |
|---|---|---|---|---:|
| `.claude/memory.md` | `/## Active work/` (**first match only**) | end of file | yes — `head -60` | **4,721 B** |
| `.claude/actions.md` | `/## Open/` | `/## Closed/` | **NO** | **98,897 B** |
| `.claude/accuracy-log.md` | line 1 | line 45 | yes | 7,481 B |

Sum ≈ **111 KB**, which accounts for the brief's observed 109.5 KB payload. Paths are **relative to
cwd**, so this reads whichever repo the session's cwd is in (`/home/user/.claude/memory.md` does not
exist — confirmed).

The headings are also what the `remember` and `track-actions` skills mandate (`remember.md:81` →
`## Active work`; `track-actions.md:43,57` → `## Open` / `## Closed`). So they are a real contract
across three components, not incidental.

## 3.2 ★ THE ACTUAL BIGGEST TOKEN LEAK IN THE WHOLE SYSTEM (verdict V1)

`sed -n '/## Open/,/## Closed/p' .claude/actions.md` is the **only unbounded extraction**, and it
emits **98,897 bytes ≈ 24.7 k tokens, every single session start.**

Measured: `## Open` is at line 815, `## Closed` at line 1836 — **1,021 lines holding 32 open ACT
entries**, i.e. **~3.1 KB (~770 tok) per open item.** The entries have grown into full narratives.

**Two independent fixes, either of which works, neither of which needs the proposed rotation:**
1. **Add `| head -80` to the actions.md `sed`** — mirrors what memory.md already does. One word.
   Recovers **~22 k tokens per session start** immediately, with zero content deleted from disk.
2. **Cap entry size in `track-actions`** — an ACT row should be status + one line + an evidence link,
   not a narrative.

> This is why V1 says the plan is mis-targeted. Rotating `actions.md` (proposal item 2) would also
> shrink this — but **as a side effect of a large, risky file surgery**, when a one-word `head`
> delivers the same saving today at zero risk. **Do the `head` first, regardless of what else is
> decided.**

## 3.3 ★ TWO SILENT MATCHER BUGS — the hook is already lying about what it delivers

Both found by reading the file, and both matter *more* than the token question:

**Bug A — the memory.md extract is ~4 weeks STALE.** `memory.md` is written **newest-first** (line 4
is dated 2026-08-25). But `sed` takes the **first** `## Active work` match, which is at **line 1385**
— `"## Active work — 1:1 VOICE latency … (2026-08-01)"`. A second, newer `## Active work` sits at
line 1508 and is never reached. **Every session is being briefed on 2026-08-01's active work while
the current work at the top of the file is invisible.**

**Bug B — `## Hardening` is advertised and never delivered.** The hook prints the label
`--- memory.md (Active work + Hardening) ---`, but the earliest `## Hardening` heading is at **line
4**, i.e. *above* the `sed` start point at line 1385. It is structurally unreachable. The Stop gate
separately *requires* Hardening entries — so the system demands a section it never shows back.

**Consequence for this review:** a reader could reasonably conclude "the hook already surfaces
memory, so memory.md is fine." It does not. Any rotation work must fix these, or it will faithfully
rotate a file whose extract was already broken.

## 3.4 Does rotation break the matching? — **YES, in three specific ways. All are avoidable.**

| # | Rotation move | Effect | Severity |
|---|---|---|---|
| R-a | `## Closed` is moved into the archive file, leaving `## Open` in the working file | `sed '/## Open/,/## Closed/p'` finds **no terminator** and prints **to end of file** — the payload can get **BIGGER**, not smaller | **HIGH — silent, and inverts the goal** |
| R-b | The heading is renamed while archiving (`## Open` → `## Open actions`, `## Active work` → `## Current work`) | `sed` matches nothing and prints **empty**. The `\|\| echo '(no …)'` fallback fires only on a **sed error**, never on empty output — so **there is no warning at all** | **HIGH — silent total loss** |
| R-c | Archive file also contains `## Active work` and is ordered before the working file | irrelevant to `sed` (single file), but the same first-match-wins trap as Bug A recurs inside the working file | MEDIUM |

**Rotation is safe if and only if:** the working file retains, in this order, `## Active work`
(memory) and `## Open` … `## Closed` (actions), spelled **exactly**, with `## Active work` appearing
**exactly once** and **at the top**. That constraint must be written into `remember.md` and
`track-actions.md` (see §5), or the next rotation silently breaks it again.

---

# ITEM 4 — Where can durable behaviour actually live?

## 4.1 The three candidate locations, with what I could verify in this container

| Location | Repo claim | What I observed **here, today** | Verdict |
|---|---|---|---|
| `/root/.claude/launcher-settings.json` | regenerated from a stock template every launch | **CONFIRMED.** Container booted `2026-08-27 03:25:31Z`; this file's mtime is `2026-08-27 03:25:51Z` — **rewritten 20 s after boot**, and it is back to the stock 716 bytes. A reset log at `/root/.claude/eds-launcher-reset-log.jsonl` records three prior resets. | **NOT DURABLE. Never put hooks here.** |
| `/home/user/.claude/settings.json` | owner correction: "gets wiped when the container is reclaimed" | **PARTIALLY CONTRADICTED.** mtime `2026-08-25 20:10:45Z` — it **survived the 2026-08-27 03:25 boot intact**, hooks and all (the `_eds_version 16` hook is live and firing this session). | **LOADS reliably; survives at least a plain restart. The owner's wipe report stands** (a reclaim is not the same event as a restart, and I did not observe a reclaim). Treat as *load target*, **not** as the place you author. |
| repo-level `.claude/settings.json` | not loaded in multi-repo sessions | **Consistent with observation** — `huddle-extension-app/.claude/settings.json` exists (3,835 B) and none of its hooks are in the live merged config. Not independently re-probed. | **INERT. Do not use.** |

*(Observation vs interpretation: the mtimes are observed. That a "reclaim" behaves differently from
the boot I observed is the owner's report, which I take as ground truth and have not contradicted.)*

## 4.2 THE DURABLE PATH — one answer

> **`eds-claude-skills/setup.sh` is the only durable authoring location.** It runs at container
> **BUILD** time and is captured in the CCR environment cache, so every new session inherits it; it
> then *writes* `/home/user/.claude/settings.json`, which is where the hooks load from. Authoring
> directly into `settings.json` is what does not survive.

**The version-bump requirement is mandatory and is the #1 way this change silently fails:**

- `setup.sh` **line 745**: `CURRENT_VERSION = 16  # bump this whenever SESSION_CMD, STOP_PROMPT or a hook command below changes`
- The merge logic (lines 887, 892, 910, 918) replaces an installed hook **only if**
  `installed._eds_version < CURRENT_VERSION`.
- **Therefore: editing `SESSION_CMD` (lines 863–865 — exactly the lines this plan wants to change)
  without bumping `CURRENT_VERSION` to 17 leaves every already-provisioned environment running the
  OLD hook forever.** The script's own comment at line 823 records that this has bitten before.
- Live sessions additionally need the **`sync-setup-script`** skill run to apply it now; idle
  sessions pick it up at next container build.

**AC-13/AC-14 in §6 make this checkable.**

## 4.3 ★ ADVERSARIAL: proposal item 4 CONTRADICTS proposal items 1 and 2

Item 4 wants to "make batch-SQL + query-efficiency habits durable via `setup.sh`." The mechanism by
which `setup.sh` makes a habit durable is **printing prose into the SessionStart hook output** — and
**that output is injected into context on every single session start.**

So item 4, as written, **adds** per-session tokens in a plan whose stated purpose is to remove them.
The current hook prose is already ~2.5 KB before the file extracts.

**Recommendation:** put durable *habits* in a **skill file** (loaded on demand, costs one line in the
skill listing) and reserve the SessionStart hook for things that must fire unprompted. Only a rule
that is (a) short, (b) violated by default, and (c) expensive when violated earns a line in the hook.
"Batch your SQL" is a good habit but does not clear that bar — it belongs in `query-azure-pg-mcp.md`
(§5).

---

# ITEM 5 — Extend vs new: does any of this belong in an existing skill?

Current contents of `eds-claude-skills/.claude/skills/` (16 flat `.md` playbooks):
`bootstrap`, `create-github-repo`, `define-acceptance-criteria`, `design-library-uat`,
`gha-playwright-uat`, `query-azure-pg-mcp`, `query-supabase`, `remember`, `setup-environment`,
`setup-mcp`, `sync-setup-script`, `tavily-fallback`, `track-actions`, `uat-auth-bypass`, `uat`,
`verify-work`.

> **VERDICT: NO NEW SKILL IS WARRANTED. Every piece of this plan extends an existing one.**
> Creating a "context-efficiency" skill would be exactly the extend-don't-duplicate violation the org
> rules call out.

| Plan item | Belongs in (EXTEND) | Evidence it is a genuine gap there |
|---|---|---|
| Rotation of `memory.md`; the `## Active work` single-heading + top-of-file constraint | **`remember.md`** — it already owns `memory.md` and mandates `## Active work` (line 81) | grep for `archive\|rotat\|size\|prune\|trim` in `remember.md` → **zero hits**. Rotation is unspecified today. |
| Rotation of `actions.md`; the `## Open`…`## Closed` contract; per-entry size cap | **`track-actions.md`** — owns `actions.md`, mandates `## Open` (43) / `## Closed` (57) | same grep → **zero hits**. This is the gap that let 32 entries reach 99 KB. |
| Batch-SQL + query-efficiency habits (item 4) | **`query-azure-pg-mcp.md`** (and `query-supabase.md`) | grep for `batch\|single query\|efficien` → one incidental hit about the restricted-mode validator. No efficiency guidance exists. |
| The `psql` presence guard (item 3) | **`query-azure-pg-mcp.md`** — it already documents the workflow-based DB access path | The four workflows are that skill's subject matter. |
| "`CLAUDE.md` is auto-injected in full; `docs/` is not; never use `@imports` to 'save' tokens" | **`remember.md`** or `bootstrap.md` | This is the single most reusable finding here and currently exists nowhere. |
| The standalone downloadable `.md` for other sessions (item 5) | **see §7-R6 — recommend AGAINST** | A detached copy has no update path. |

---

# ITEM 6 — Acceptance criteria (numbered, binary, Given/when/then)

Each AC is pass/fail from an observable artifact. **AC-1 … AC-4 are the regression guards that the
split did not silently drop content** — the brief's explicit requirement.

### A. Regression guard — no content was silently dropped

**AC-1 (section accounting).** Given the pre-change `CLAUDE.md` has **28 `##` sections**, when the
split is complete, then a script asserts every one of the 28 original section titles is present
**either** in the new `CLAUDE.md` **or** in a file under `docs/`, and the count of accounted-for
sections is **exactly 28, with 0 unaccounted**. *Fail if any title appears in neither.*

**AC-2 (byte accounting).** Given the pre-change `CLAUDE.md` is **61,347 bytes**, when the split is
complete, then `bytes(new CLAUDE.md) + bytes(all newly created docs/ files) >= 58,280` (≥95 % of the
original; the ≤5 % delta is the allowance for condensation into imperative form). *Fail below 95 %,
which indicates deletion rather than relocation.*

**AC-3 (MUST-STAY presence).** Given the §1.3 table names 14 sections as MUST-STAY or
SPLIT→MUST-STAY, when the split is complete, then a checklist test asserts a matching rule sentence
for **all 14** survives **inside `CLAUDE.md` itself** (not only in `docs/`). Specifically these
strings or clear equivalents must be greppable in `CLAUDE.md`: `eds-postgresql`, `RAG_AI_Agents`,
`main` (deploy-only-from), `ADDITIVE-ONLY`, `Test-`, `fetch origin`, `fail CLOSED`, `sunsetting`/
snapshot-authoritative, the four FROZEN workflow filenames, `send_push`, `PROVEN`(Realtime),
`decision.reason`, poll-don't-sleep, and don't-claim-done-until-user-confirms. *Fail on any miss.*

**AC-4 (git recoverability).** Given the change is one commit, when `git show --stat` is run on it,
then every `CLAUDE.md` deletion has a corresponding addition in the same commit, and
`git log -p -- CLAUDE.md` still reaches the pre-split content. *Fail if content was removed in a
commit that did not add it elsewhere.*

### B. The saving is real and measured on the right thing

**AC-5.** Given the pre-change injected payload from `CLAUDE.md` is ~15.3 k tok, when a **fresh
session** is started after the change, then the injected `CLAUDE.md` block measures **≤ 5,200 tok**
(§1.4's honest ceiling). *Fail if >5,200. Do **not** accept a `wc -c` of the file as evidence.*

**AC-6.** Given `@imports` are inlined at load (§1.2), when the new `CLAUDE.md` is inspected, then
`grep -c '^@' CLAUDE.md` returns **0** and no pointer is written as an `@path` import. *Binary.*

**AC-7 (V2 — duplication).** Given 21,558 bytes of `/root/.claude/CLAUDE.md`'s global-rules block are
verbatim inside `eds-claude-skills/CLAUDE.md`, when de-duplication is done, then the paragraph-overlap
script reports **< 2,000 bytes** of verbatim overlap between those two files, and every rule heading
present before is still present in **exactly one** of them. *Fail if a rule vanished from both.*

**AC-8 (V1 — the hook).** Given the SessionStart hook currently emits **98,897 bytes** from
`actions.md`, when the `head` bound is added, then the total SessionStart stdout is **< 20,000 bytes**
measured by running the hook command directly and piping to `wc -c`. *Binary, measurable today,
before any file surgery.*

### C. Nothing became unreachable

**AC-9 (pointer integrity).** Given each moved section leaves a pointer, when a link-check script
runs, then **every** `docs/…​.md` path referenced from `CLAUDE.md` **exists on disk**. *Fail on any
dangling pointer.* (Guards R3.)

**AC-10 (matcher contract).** Given the SessionStart hook greps `## Active work`, `## Open`,
`## Closed`, when rotation is complete, then in the working files: `grep -c '^## Active work'
memory.md` == **1**; `grep -n '^## Open' actions.md` and `grep -n '^## Closed' actions.md` both return
exactly one line, with `## Open`'s line number **less than** `## Closed`'s. *Fail on any other
result — this is R-a/R-b from §3.4.*

**AC-11 (Bug A).** Given the hook takes the **first** `## Active work` match, when rotation is
complete, then the emitted memory extract's date is **within 7 days of today**. *Fail if it is again
serving a month-old section.*

**AC-12 (Bug B).** Given the hook's label promises Hardening, when the hook is run, then its output
contains at least one `## Hardening` heading. *Currently FAILS — this is a pre-existing defect the
change must fix, not introduce.*

### D. Durability

**AC-13 (version bump).** Given `setup.sh:745` holds `CURRENT_VERSION = 16`, when any of
`SESSION_CMD` / `STOP_PROMPT` / a hook command is edited, then `CURRENT_VERSION` is **≥ 17** in the
same commit. *Fail otherwise — the change would be silently inert everywhere.*

**AC-14 (it actually landed).** Given a live session, when `sync-setup-script` is run, then
`jq '.hooks.SessionStart[0].hooks[0]._eds_version' /home/user/.claude/settings.json` returns the new
number. *Fail if it still reads 16 — "the script ran" is not evidence.*

**AC-15 (no net token growth from item 4).** Given item 4 adds habits via `setup.sh`, when the new
SessionStart prose is measured, then its byte count is **not greater** than today's. *Fail if the
"efficiency" change made the per-session payload larger (§4.3).*

### E. Edge / error states

**AC-16.** Given a repo with **no** `.claude/memory.md`, when the hook runs, then it prints
`(no memory.md yet)` and exits 0 — the session still starts. *Regression guard on the `2>/dev/null ||`
path.*

**AC-17.** Given a rotated archive, when an agent is asked a question whose answer is only in the
archive, then it can locate it — i.e. the working file contains an explicit index line naming the
archive path. *Guards R4 (graveyard).*

---

# ITEM 7 — Ranked risks (adversarial)

| # | Risk | Likelihood | Impact | Score | Mitigation |
|---|---|---|---|---|---|
| **R1** | **A hard rule that exists because of a documented expensive failure becomes unreachable.** 14 of 28 sections are MUST-STAY; each traces to a named, dated incident (prod overwrite race; live-board pollution; split-brain DB; unconfirmed "fixed"). A moved rule is read only if the agent already suspects it applies — and every one of those incidents happened *because it did not.* | **HIGH** | **SEVERE** | **1** | AC-3 + §1.5: keep the rule sentence in `CLAUDE.md`, move only the anecdote. Never move a rule and rely on a pointer. |
| **R2** | **The saving is measured on the wrong artifact and is illusory.** Two ways: (a) `@imports` re-inline the moved content (§1.2) so the injection never shrinks while `wc -c CLAUDE.md` looks great; (b) the harness re-injects `CLAUDE.md` on its own schedule (≥4× in one session, per the brief), so it is **injection count × file size** — and nothing in this plan touches the count. | **HIGH** | HIGH | **2** | AC-5/AC-6 measure the *injected payload in a fresh session*, not the file. **And note the multiplier cuts the other way too: at 4 injections/session, a 10 k-token reduction is a ~40 k-token saving — so the plan's upside is 4× larger than a naive read suggests, on exactly the same evidence.** |
| **R3** | **Wrong ordering: the risky change is done first (or instead).** V1 (hook `head`) + V2 (de-dup) are ~28–30 k tokens at near-zero risk. The split is ~10 k (×injections) at R1 risk. A session that starts with the split spends its budget on the dangerous half. | **HIGH** | MED | **3** | Sequence: **V1 → V2 → (measure) → split.** V1 and V2 may make the split unnecessary this quarter. |
| **R4** | **The archive becomes a graveyard nobody reads.** Already happening and **provable today**: `.claude/` holds **18 `.md` files totalling 988 KB (~247 k tok)** of AC/VERIFY docs, plus **21 files / 359 KB** in `docs/` — none auto-read, and `.claude/NEW-SESSION-BRIEF.md` is a *session brief* that no session reads. Rotation adds two more such files. | **CERTAIN** | MED | **4** | AC-17: an index line in the working file. Accept that archives are for *humans and git*, not agents — do not justify the change by "the agent can still look it up." |
| **R5** | **Rotation silently breaks the SessionStart matcher.** §3.4 R-a: moving `## Closed` to the archive makes the unbounded `sed` run to EOF, so the payload **grows**. R-b: renaming a heading yields **empty output with no error**, because the `\|\|` fallback fires only on a sed *error*. | MED | HIGH | **5** | AC-10 + AC-8. Add a non-empty assertion to the hook so silence becomes loud. |
| **R6** | **A handed-off standalone `.md` goes stale or is applied blindly to a repo it does not fit.** The findings here are Huddle-specific (`eds-postgresql` pin, 4 named workflows, this hook's exact `sed` strings). A detached copy has no update path, no version, and no owner — and item 5's "downloadable `.md` for other sessions" is precisely how a stale copy propagates. | MED-HIGH | MED | **6** | **Recommend AGAINST item 5's standalone file.** Put the reusable half in the versioned skills (§5) where `sync-setup-script` propagates it; keep the repo-specific half in this repo. |
| **R7** | **Condensing to imperative form removes the *reason*, and the rule stops being obeyed.** The anecdotes are not decoration — the org rules say so explicitly ("the embedded examples are the guardrail, not decoration"), and the repo has a documented case of a prose rule being violated *twice while it was already written down*. A bare "always fetch first" is weaker than one carrying its cost. | MED | MED-HIGH | **7** | Keep a one-clause cost marker per rule (`(cost: rebuilt shipped work, 2026-08-10)`). This is why §1.4's honest floor is ~4.6–5.2 k, not 3 k. |
| **R8** | **The split is done by an agent under the same token pressure it is trying to relieve**, editing a 61 KB file it must hold in context — the classic condition for silent truncation. | MED | HIGH | **8** | Do it section-by-section with AC-1/AC-2 run after **each** section, not once at the end. |
| **R9** | **`CLAUDE.md` re-grows.** Nothing in the plan prevents the next 20 sessions appending. `actions.md` reached 99 KB of "open" items with no size rule anywhere (§5: zero hits for `size\|prune\|trim`). | **HIGH** (long-term) | MED | **9** | A budget in `remember.md`/`track-actions.md` + a CI check failing the build if `CLAUDE.md` > N bytes. Without this the whole exercise repeats in 3 months. |
| **R10** | **Deleting the `psql` install breaks the only route to prod DB** if a future runner image drops the package (§2.4c). Silent until an ops workflow is dispatched. | LOW | HIGH | **10** | The `command -v psql \|\|` guard. Never plain deletion. |
| **R11** | **De-duplicating the two `CLAUDE.md`s (V2) deletes from the wrong copy.** `eds-claude-skills/CLAUDE.md` is the repo that `setup.sh` *regenerates* `/root/.claude/CLAUDE.md` from. Cutting the block from the wrong side could be undone — or doubled — at the next environment build. | MED | MED | **11** | Read `setup.sh`'s CLAUDE.md-append logic before cutting; keep the canonical copy in the file `setup.sh` *writes*, and cut from the one it *reads*. AC-7 asserts every heading survives in exactly one. |

---

# ITEM 8 — What ELSE would cut tokens that this plan misses

Ranked by (saving × ease). **The top three are all cheaper and safer than the `CLAUDE.md` split.**

**8.1 ★ Bound the SessionStart `actions.md` extract — ~22 k tok/session, one word.**
Covered as V1/§3.2. Add `| head -80`. Nothing is deleted from disk. **Highest-value single character
change in the system.**

**8.2 ★ De-duplicate the two global-rule blocks — ~5.4 k tok per injection, zero rule loss.**
Covered as V2. 91 % verbatim overlap, measured. See R11 for which copy to cut.

**8.3 ★ Fix `psql` OUTPUT FORMAT in `azure-pg-query.yml` — the plan touches this exact file and
optimises the wrong line.**
Line 104 is `psql … --pset pager=off -c "$SQL"` — **default *aligned* output**. psql pads every column
to the width of its widest value, so a query returning a JSON `replies` column emits header/separator
rows of **~1,500 spaces and ~1,500 dashes per query**, plus padding on every row. In the single job
log I read (run `33022226224`), that formatting was **the majority of the ~5 k tokens the read cost
me**. Adding `-A -F'|'` (unaligned) or `-t` would cut a typical job-log read by **50–70 %**.
> This is the sharpest finding in §8: **item 3 of the proposal edits this file to save 9 seconds of
> runner time and 0 tokens, while the line directly beneath it is a large, recurring token leak.**

**8.4 ★ MCP tool results are an unmanaged token sink — measured in this very review.**
`actions_list(list_workflow_runs, per_page=3)` returned **98,011 characters (~24.5 k tok)** — it
ignored `per_page` and returned 30 fully-hydrated run objects, overflowing to a spill file. That is
**larger than the entire Huddle `CLAUDE.md`**, from one call. The GitHub MCP server documents a
`minimal_output: true` parameter that nothing in `CLAUDE.md` tells an agent to use.
**Add to `CLAUDE.md`/the skills: always pass `minimal_output: true` and an explicit small `per_page`
to GitHub MCP list calls, and prefer the raw REST `curl` loop (already documented in the
"Waiting on deploys/CI" section) over MCP list tools for polling.**

**8.5 Cap `get_job_logs` reads.** Always pass an explicit small `tail_lines`, and grep the spill file
rather than reading log content into context. Combined with 8.3 this is a large recurring saving,
since job-log reading is the documented primary way this project inspects its own DB and CI.

**8.6 Trim the `.claude/` AC/VERIFY sprawl — 988 KB across 18 files (~247 k tok).**
Not auto-injected, so it costs nothing per session — but it is *already* the graveyard R4 warns about
(9 near-duplicate `ac-*`/`verify-*` files, several >34 KB). It is also the corpus an agent greps.
Move completed AC/VERIFY docs to `docs/archive/` and keep an index. **Do this instead of creating new
archive files for memory/actions, so the count of unread archives does not grow.**

**8.7 Attack injection *frequency*, not just size (the R2 multiplier).** The brief's own datum — the
same unchanging 61 KB file injected ≥4× in one session — means frequency is worth as much as size and
is entirely untouched by this plan. Worth one investigation: what triggers re-injection (compaction?
`/clear`? cwd change across the multi-repo session?) and whether any of it is avoidable. **Potentially
the largest remaining win after 8.1–8.2, and nobody has measured it.**

**8.8 The `## LIVE STATUS BOARD (surface this every check-in)` header in `actions.md`.** It sits at
line 4, *above* `## Open`, so it is not in the extract — an instruction to surface something the hook
structurally cannot surface. Same class as Bug B. Either move it inside the extracted range or drop
the directive; do not leave a standing instruction that cannot be honoured.

---

# CLOSING: recommended sequence

1. **`| head -80` on the actions.md hook extract** (+ bump `CURRENT_VERSION` to 17, + `sync-setup-script`). ~22 k tok/session. Minutes. Zero risk. **AC-8, AC-13, AC-14.**
2. **Fix Bug A + Bug B** (§3.3) in the same hook edit — the extract is currently stale and Hardening-free. **AC-11, AC-12.**
3. **De-duplicate the two global-rule blocks** (V2). ~5.4 k tok/injection. **AC-7, R11.**
4. **`-A -F'|'` on the psql line + `minimal_output` habit** (§8.3, §8.4) into `query-azure-pg-mcp.md`. **AC-15.**
5. **Re-measure.** Steps 1–4 plausibly deliver more than the split, at a fraction of the risk.
6. **Only then** do the `CLAUDE.md` split — section by section, targeting **~5 k tokens, not 3 k**, with AC-1…AC-6 run after each section.
7. `psql` guard in the 4 workflows (§2.5) whenever convenient — it is an ops tidy-up, not part of this plan.
8. **Skip item 5's standalone `.md`** (R6). Extend the existing skills instead (§5).

**Status of this document: COMPLETE.** Nothing was implemented; no file outside this document was
modified; nothing was pushed.
