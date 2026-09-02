# Token-efficiency review brief — for a second opinion

**Purpose.** A session burned ~164k tokens on one piece of work. This documents what was measured,
what has already been fixed, what is proposed next, and three decisions the owner has not made. It is
written to be handed to a *different* Claude session for an independent opinion.

**Repo:** `deventerpriseds-org/huddle-extension-app` (+ the org repo `deventerpriseds-org/eds-claude-skills`).
**Written:** 2026-09-02. **Author:** the session that did the work, so treat its self-assessment sceptically.

**What I want from a reviewer:** challenge the three open decisions in §6, and tell me whether §5's
remaining items are worth doing at all. Disagreement is more useful than agreement.

---

## 1. The goal

Reduce tokens consumed per session **without losing any rule whose absence causes a costly failure.**
That second clause is the whole difficulty. Most of the token weight is instruction and memory files
that exist *because* something went wrong once. Deleting them is trivially "efficient" and actively
harmful. Any proposal that cannot say which rules survive is not a proposal.

Secondary goal: make the fixes durable. A CCR container is reclaimed regularly (this session saw it
**5+ times in one day**), and anything written only to the live filesystem is lost. Durable means
`eds-claude-skills/setup.sh`, which runs at container build and is version-gated.

---

## 2. What was measured (evidence, not estimates)

| Thing | Measurement | How |
|---|---|---|
| `huddle-extension-app/CLAUDE.md` | 61 KB / **~15,300 tok**, 28 `##` sections | `wc -c` |
| `eds-claude-skills/CLAUDE.md` (upstream) | 73 KB / ~18,400 tok | `wc -c` |
| `/root/.claude/CLAUDE.md` | 48 KB / ~12,000 tok | `wc -c` |
| Overlap: global vs eds CLAUDE.md | **96% of the global file is duplicated in the eds file** (45.5 KB of 47.5 KB) | `difflib.SequenceMatcher` |
| `.claude/memory.md` | 302 KB / ~76k tok | `wc -c` |
| `.claude/actions.md` | 292 KB / ~73k tok | `wc -c` |
| Old SessionStart `actions.md` extract | **98,897 bytes (~24.7k tok) every session start**, unbounded | ran the exact `sed` |
| `psql` install in CI | ~9s/run; apt unpacked only the *metapackage* | run log `33022226224` |
| One `actions_list` MCP call | **98,011 chars (~24.5k tok)** in a single tool result | observed |

**Observed but not proven:** Huddle's `CLAUDE.md` appeared **in full at least 4 times** in one
session's context (~61k tokens on an unchanging file). I did not establish *why* the harness
re-injects, or on what schedule. **A reviewer should treat the re-injection frequency as unverified** —
it materially changes the value of §5.2.

---

## 3. Already fixed and verified

- **SessionStart brief**: was either 98.9 KB or *silently empty* depending on cwd. Now bounded and
  correct — **27,352 bytes**, multi-repo discovery by scan, per-file caps, absent files labelled.
- **Two silent bugs closed**: the memory extract matched the *first* `## Active work` in a
  newest-first file (briefing month-old work), and `## Hardening` sat above the `sed` start so it was
  **never delivered** despite the Stop gate requiring it. A third: `||` bound to a pipeline whose exit
  status is always `head`'s, so one fallback had **never once fired**.

---

## 4. The correction a reviewer should know about (it changes how much to trust §5)

**I rebuilt something that already existed.** I hand-wrote a bounded, multi-repo session-brief script.
`eds-claude-skills/setup.sh` **already had one** — `eds-session-memory.py` — and better than mine.

Root cause: this session was pinned at hook **v16** while upstream was at **v30**, *and* the local
`eds-claude-skills` clone was also stale at v16. So both I and the AC subagent I spawned were reading a
14-version-old baseline. The AC review's two headline findings were **already fixed upstream**.

Two consequences for the reviewer:
1. **Re-verify any claim in this doc against `origin/main` and against `/workspace/eds-claude-skills`,
   not against a local clone.** Staleness is the default failure here.
2. The correct first move was the **`sync-setup-script`** skill. I've deleted my duplicate and run the
   real `setup.sh`; hooks are now v30.

---

## 5. Proposed remaining work

Ordered by measured value. Effort is expressed as scope + risk, not time.

### 5.1 De-duplicate global vs eds `CLAUDE.md` — **largest remaining win**
- **Saving:** ~45 KB / **~11.4k tok per injection**. Both files auto-inject every session.
- **Effort:** small edit, large blast radius. One file becomes the source; the other references it.
- **Pros:** zero rule loss — the content is *identical*, so nothing is dropped, only stored once.
- **Cons / risk:** these are **org-wide files other sessions depend on**, and v30 deliberately rewrote
  both today, so someone is actively maintaining them. A concurrent edit could clobber their work.
  Also unproven: whether the harness injects the eds file when the repo is merely *attached* vs
  registered — if only one actually injects, the real saving is smaller.
- **Open question for the reviewer:** is the duplication deliberate (belt-and-braces so a session
  missing one file still gets the rules)? If so, this is a bad idea and should be dropped.

### 5.2 Split `huddle-extension-app/CLAUDE.md`
- **Requested target:** under 3k tokens. **I do not believe that is achievable honestly.**
- **Why:** `docs/` is **not auto-injected** — proven by observation: all three `CLAUDE.md` files appear
  verbatim in a subagent's context while a `docs/` file *referenced by* `CLAUDE.md` does not. Moving a
  rule to `docs/` converts it from guaranteed to discretionary. There is also an **`@import` trap**:
  imports are inlined, so "move to docs/ + `@import`" saves **exactly zero** while `wc -c` looks great.
- **Honest floor:** ~3.2k stripped bare; **~4.6–5.2k** keeping the cost markers (the "this rule exists
  because X broke" anecdotes) that make rules stick. Of 28 sections: **14 MUST-STAY** (11 of those
  split — keep the imperative, move the story), 14 safe to move.
- **Pros:** ~10k saved per injection if re-injection is as frequent as observed.
- **Cons / risk:** **this is where a rule gets lost.** Anything under 3k should be treated as evidence
  something load-bearing was cut. Rules at risk: deploy-only-from-`main`, the Azure DB pin,
  ADDITIVE-ONLY prompts, `Test-` prefixes, don't-claim-done-until-confirmed, fetch-first.

### 5.3 Memory / actions rotation
- **Saving now: ~zero.** v30 caps the brief at 60 lines/file, so file size no longer drives session
  cost. This was worth ~22k *before* v30; it is worth ~0 after.
- **Effort:** file surgery on 302 KB + 292 KB of accumulated lessons.
- **Cons / risk:** the extraction is `sed`-range based; moving `## Closed` to an archive makes the
  range run to EOF (payload gets **bigger**), and renaming a heading yields **empty output with no
  error**. Archives also become a graveyard nobody reads.
- **My read: skip it**, or do it purely for human readability, not tokens.

### 5.4 Cheap, no shared-file risk — I'd just do these
| Item | Saving | Risk |
|---|---|---|
| Drop the redundant `psql` install in 4 workflows (`command -v psql \|\|` guard, not deletion — 5432 is blocked from sessions so these are the only route to prod DB) | ~9s/run wall-clock, **0 tokens** | very low |
| psql `-t -A` instead of default aligned output | ~3,000 padding chars **per query read** | very low |
| `minimal_output: true` on MCP list calls | one call measured at ~24.5k tok | very low |
| Batch SQL: one dispatch, many statements | ~12 dispatches → ~3 in the observed session | none |

**Note the honest framing:** the psql item is a *latency* fix, not a token fix. It was mis-filed in a
token plan. The `-t -A` item on the very next line of the same file is the real recurring token leak
and was nearly missed.

### 5.5 Durability
Anything behavioural must land in `eds-claude-skills/setup.sh` **with `CURRENT_VERSION` bumped**, or it
is silently inert on every already-provisioned environment. Confirmed durable-path facts:
`launcher-settings.json` is regenerated every launch; `/home/user/.claude/settings.json` does **not**
reliably survive reclaim; repo-level `.claude/settings.json` is **not loaded** in multi-repo sessions.

**Tension worth flagging:** making habits durable means printing *more* prose into the per-session hook
output — which is the thing we are trying to shrink. §5.4's habits may belong in an existing skill
(`query-azure-pg-mcp`, `remember`, `track-actions`) rather than the always-on brief.

---

## 6. The three open decisions

### Blocker 1 — de-dup the org CLAUDE.md files: edit live, or PR?
- **Edit live:** ~11.4k/session immediately; risks clobbering active maintenance.
- **PR it:** reviewable, safe, slower.
- **My recommendation: PR it.** The value is real but it is shared infrastructure someone changed today.

### Blocker 2 — split Huddle CLAUDE.md to ~5k (not 3k), or skip?
- **Do it:** ~10k/injection.
- **Skip:** no risk of losing a rule.
- **My recommendation: do it at ~5k, not 3k** — but only *after* Blocker 1, and only with a
  before/after section-accounting diff proving no `##` section vanished silently.

### Blocker 3 — memory rotation: still worth it?
- **My recommendation: drop it** for token reasons. v30 removed the benefit; the risk (silent empty
  extraction) did not go away.

---

## 7. What I'd most like challenged

1. **Is CLAUDE.md really re-injected ~4× per session?** Everything in §5.2 rests on this and I only
   *observed* it — I never established the mechanism. If it injects once, the split is not worth the risk.
2. **Is the global/eds duplication deliberate redundancy?** If yes, §5.1 is wrong.
3. **Is ~5k the real floor**, or did I keep sections in MUST-STAY that are actually reference?
4. **Am I still measuring the wrong thing?** The single largest observed item was one MCP tool result
   at ~24.5k tokens — bigger than the whole Huddle `CLAUDE.md`. Tool-result hygiene may dominate
   instruction-file size entirely, in which case most of this document is a distraction.
