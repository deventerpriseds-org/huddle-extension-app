# New-session brief — Huddle continuation (written 2026-08-25)

> **If you are a fresh session:** read this file top to bottom, do STEP 0 and STEP 1, then report
> readiness and **stand by**. The owner will tell you what to work on. Do NOT start building on your
> own initiative.
>
> This file exists so a session can be brought up to speed without the spawning session having to
> paste a wall of context — point any new session at `.claude/NEW-SESSION-BRIEF.md`.

## STEP 0 — verify the eds hook gate is installed (do this FIRST)

A prior session found the `_eds` Stop-gate hooks were **entirely absent** at session start. Root cause
(upstream-confirmed): the CCR launcher **regenerates `/root/.claude/launcher-settings.json` on every
launch**, wiping any hooks merged into it. As of `setup.sh` **v9** the hooks live in
**`/home/user/.claude/settings.json`** instead.

Check `/home/user/.claude/settings.json` for `_eds_version`. **If missing or below 12**, run the
`sync-setup-script` skill:

```bash
rm -rf /tmp/eds-claude-skills-sync
git clone --depth 1 https://github.com/deventerpriseds-org/eds-claude-skills /tmp/eds-claude-skills-sync
bash /tmp/eds-claude-skills-sync/setup.sh
```

Then **read the config back** and confirm `_eds_version` equals `CURRENT_VERSION` in the fresh clone.
"Ran without error" is NOT verification.

**Gotcha:** never `curl raw.githubusercontent.com` for that private repo — it 404s even with a valid
Bearer token. `git clone` over https works with no manual auth.

**Caveat no session can fix from the inside:** the CCR environment's **Setup script field** is
out-of-band and may hold a pre-v12 copy, so a fresh container can come up with an older gate (or
none). Flag it to the owner — only they can update that field at claude.ai/code → environment → edit.

## STEP 1 — orient

- Repo: `/home/user/huddle-extension-app`. Working branch: `claude/iris-huddle-interaction-baj51c`.
- **`git fetch origin` FIRST.** Then read `.claude/actions.md` (top LIVE STATUS BOARD),
  `.claude/memory.md`, and `CLAUDE.md`. They are dense and current — read before forming an opinion.
- `.claude/session-handoff-2026-08-25.md` has the full setup.sh investigation. Read it.
- Deploys are **automatic on push to `main`**; `.claude/**` and `**/*.md` are in `paths-ignore`, so
  doc-only pushes correctly skip the deploy.

## Recently shipped (all deployed; NONE user-confirmed live)

- **Confirm-ask button contrast** — `bg-surface`+`border-hairline` measured **1.31:1** in light mode
  (pure white on a 0.985 background behind a 0.90 hairline). Now `bg-muted`+`border-foreground/65` =
  **5.17:1 light / 6.64:1 dark**. `/65` was chosen by measuring rendered pixels; `/35` and `/45` both
  failed WCAG's 3:1 minimum for UI boundaries.
- **Board-card status dropdown** — **ported, not merged.** The source branch predated months of
  BoardView work; merging it would have reverted the Ready-for-review column, parking-lot, artifact
  chips and mobile lanes.
- **Scheduling-redesign handoff doc** — merged with a staleness banner (design-only, never built,
  refs from 2026-08-11 will have drifted).
- **ACT-61 knowledge intake** — `saveMemoryItem`'s 4000-char cap → 20k/request + server-side chunking
  via the new pure shared `lib/rag/chunk.ts`; "Load file" (.md/.txt/.json/.csv) in the Agent Settings
  memory panel; live chars+chunk preview; batch progress. Chunker unit-tested 10/10 offline.

## Open / parked — read `actions.md` before touching either

- **ACT-60 (PARKED at the owner's request).** The chat pane shows ~388px of phantom scrollable height
  at a **680px-tall** viewport and **zero** overflow at **1117px**. Every DOM element was walked —
  nothing sits outside a clipped ancestor. Not app JS, not html/body CSS. Untested hypothesis:
  `h-dvh` interacting with `interactive-widget=resizes-content` in the viewport meta.
  **Do NOT start by hunting a runaway element** — that was done exhaustively and found nothing.
  Diagnostic script: `.claude/skills/test-agent-serverfn/scripts/scroll-overflow-diag.mjs`.
- **ACT-61 deferred half.** Per-agent OpenAI vector stores are provisioned AND bound, and
  `file_search` IS wired into the runtime — but the standing claim is there is no `POST /v1/files`
  anywhere in the repo, so they are empty. The gate's requirement (h) means an "X is absent/blocked"
  claim needs a **producer AND consumer sweep** on record, not a single grep. Re-establish that
  before restating it as blocking.

## How the owner wants you to work (amended 2026-08-25 — supersedes the blunter CLAUDE.md version)

CLAUDE.md carries a hard "confirm the plan before building or deploying" rule. **The owner's
correction: that rule was impeding progress by turning every step into a question.** Apply it as a
real gate, not a reflex.

**Do NOT stop and ask before building/deploying when any of these hold:**
- the work already cleared the **AC / verify floor** (criteria agreed, verification planned), OR
- it is **clear the owner is already up to speed** on what is being built, OR
- the owner has **signalled continuous operation** ("keep going", "go", "run with it").

**Still confirm first for:** genuinely new scope the owner has not seen, destructive or hard-to-reverse
actions, or a real fork in intent where different readings lead to materially different work.

Bias to action within work the owner already knows about. Don't narrate permission-seeking.

## Non-negotiables (NOT what is being relaxed)

- **Fetch-first** before answering any "is it deployed / done / built / live?" question — answer from
  `origin/main` or the deployed SHA, never the local working tree.
- **Never claim fixed/done without real evidence.** "Should work" is banned. Merge + deploy, THEN ask
  the owner for a live re-test, THEN write "fixed".
- **Any harness that could write to the owner's REAL board** must use a `Test-` title prefix or
  `journey:{enabled:false}`, and must clean up after itself.
- **Deploy only via `main`.** Never dispatch `deploy-swa.yml` at a feature branch.
- Open every reply with a phase tag (`Fact Finding:` / `Implementing:` / `Deployed:` /
  `Blocked - needs you:` …) — a hook enforces it.

## What to do now

1. Verify/repair the hook gate (STEP 0).
2. Read the docs above and orient (STEP 1).
3. Reply with: hook version before → after, current `origin/main` SHA, a 5-line summary of what you
   understand the open items to be, and anything that looks wrong or stale to you.
4. **Then stand by.**
