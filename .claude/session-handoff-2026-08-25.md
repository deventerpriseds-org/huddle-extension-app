# Session handoff — 2026-08-25 (setup.sh live sync)

> Written incrementally as work happened. Primary task: apply the latest central
> `eds-claude-skills` `setup.sh` live to this session, per the `sync-setup-script` skill.

## Plan (stated before execution, per the standing rule)
1. Fresh-clone `eds-claude-skills` to `/tmp/eds-claude-skills-sync` (`git clone`, never
   `raw.githubusercontent.com` — that 404s for this private repo even with a valid Bearer token).
   Two stale clones exist at different commits (`/workspace/eds-claude-skills` e87a708,
   `/home/user/eds-claude-skills` 61b8652) — neither is authoritative, hence the fresh clone.
2. `bash /tmp/eds-claude-skills-sync/setup.sh` (idempotent, non-fatal by design).
3. Read the live config BACK and confirm `_eds_version` is present and equals `CURRENT_VERSION`
   in the freshly cloned script. "Ran without error" is NOT verification.
4. Report before -> after + what the diff actually changed.
No builds, no deploys, no test harnesses. Scope is the sync + this write-up only.

---

## PRE-SYNC STATE (observed, before running anything)

`/root/.claude/launcher-settings.json` (716 bytes, mtime **Aug 25 12:16** — i.e. TODAY):

```json
{
  "hooks": {
    "SessionStart": [{ "hooks": [{ "type": "command", "command": "~/.claude/session-start-git-identity.sh" }] }],
    "Stop":         [{ "matcher": "", "hooks": [{ "type": "command", "command": "~/.claude/stop-hook-git-check.sh" }] }]
  },
  "permissions": { "allow": ["Skill"] }
}
```

**CONFIRMED: zero `_eds` hook entries.** No `_eds_version` anywhere. The Stop-hook verification
gate (AC-subagent / verifier-subagent / plan-before-risky-action enforcement) was **NOT active**
in this session at the moment I was spawned.

### Observation vs interpretation on WHY

**Observed (file mtimes):**

| Path | mtime | Notes |
|---|---|---|
| `/root/.claude/CLAUDE.md` | Aug 21 15:51 | contains the eds skills-overview block |
| `/root/.claude/skills/*.md` (all 14) | Aug 21 15:51 | bootstrap, verify-work, define-acceptance-criteria, … |
| `/root/.claude/agents/verifier.md` | Aug 21 15:51 | |
| `/root/.claude/eds-git-guard.sh` | Aug 21 15:51 | |
| `/root/.claude/eds-agent-guard.sh` | Aug 21 15:51 | |
| **`/root/.claude/launcher-settings.json`** | **Aug 25 12:16** | **no `_eds` entries** |
| `/root/.claude/stop-hook-git-check.sh` | Aug 25 12:16 | harness-owned, not eds |
| `/root/.claude/session-start-git-identity.sh` | Aug 25 12:16 | harness-owned, not eds |
| `/root/.claude/stop-hook-reply-gate.py` | Aug 25 12:16 | harness-owned, not eds |

**Interpretation (inference, confidence high — the mtime split is the evidence):** `setup.sh` DID
run at container-build time on Aug 21 15:51 — every artifact it writes to disk (skills, agents,
CLAUDE.md, both guard scripts) carries that exact timestamp and is present. But
`launcher-settings.json` was **rewritten by the harness at session start today (12:16)** with only
its own git-identity / git-check hooks, which **wipes the `_eds` hook merge**. The other
harness-owned hook scripts share that same 12:16 mtime, which is what points at the harness as the
writer rather than a stale-image explanation.

**Consequence worth flagging to the user:** the `_eds` Stop gate does not survive a session start,
even in an environment where `setup.sh` has been correctly applied at build time. The skills and
guards persist (they live in the image); the *hook registration* does not. That makes running the
`sync-setup-script` skill a **per-session** necessity, not a one-off after a `setup.sh` change.
This is a gap the skill's own docs do not currently mention.

### …and the upstream repo had ALREADY diagnosed and fixed this (found in the fresh clone)

Before running anything I read the freshly-cloned `setup.sh`. Commit **`d481bca` "Merge PR #18 —
relocate eds hooks out of the regenerated launcher-settings.json"** fixes precisely the failure
mode above. From `setup.sh`'s own header comment (lines 468-486), verbatim intent:

- The CCR launcher **regenerates `/root/.claude/launcher-settings.json` from a bare stock template
  on every launch**, wiping any hooks merged into it. Other setup.sh artifacts in the same session
  (`eds-git-guard.sh`, `settings.local.json`) survive untouched — matching the mtime split I
  observed independently.
- So as of **v9** the hooks were relocated to **`/home/user/.claude/settings.json`** (`PROJ`,
  overridable via `EDS_PROJECT_DIR`). Claude Code reads the PROJECT-ROOT settings file, and in a
  CCR session the project root is `/home/user` (repos are `--add-dir`'d beneath it). The repo
  states this was verified by planting marker `PostToolUse` hooks.
- A **repo-level** `.claude/settings.json` is explicitly NOT loaded in a multi-repo CCR session —
  the same probe showed huddle-extension-app's own pre-existing `.claude/settings.json` never fired.
- `launcher-settings.json` now intentionally keeps **only** `permissions.allow` + `autoMode.allow`.
- v9+ also carries a **migration** that strips stale `_eds` hooks left in `launcher-settings.json`
  by v8-and-earlier, to prevent every hook firing twice.

**So the caller's pre-check of `launcher-settings.json` was reading the file that is correct for
v8 and earlier only.** I checked the v9+ target too:

```
/home/user/.claude/settings.json   ->  No such file or directory
```

**Verdict (ground-truthed against BOTH candidate paths): the `_eds` hooks were installed NOWHERE
in this session.** Not in `launcher-settings.json` (regenerated at 12:16), not in
`/home/user/.claude/settings.json` (never created). The build-time run on Aug 21 15:51 was a
v8-or-earlier script that wrote to the launcher file, and that write did not survive.

---

## THE SYNC — executed

Fresh clone (`git clone --depth 20 https://github.com/deventerpriseds-org/eds-claude-skills`
→ `/tmp/eds-claude-skills-sync`), HEAD **`c96d2c6`** "Phase tag: enforce it on EVERY turn, not only
after a human prompt". Then `bash /tmp/eds-claude-skills-sync/setup.sh` from `/home/user`.

Script's own closing output:
```
Skills registered: 16
Agents registered: 1
eds-git-guard.sh installed (autosave + rewind detector).
eds-agent-guard.sh installed (orphaned-subagent reporter).
launcher-settings.json: allowlist + autoMode only (hooks deliberately NOT here -- it is regenerated every launch).
autoMode.allow: ['$defaults', 'Bash(git push*)']
/home/user/.claude/settings.json: eds hooks installed (version 12 ). Events: ['PostToolUse', 'SessionStart', 'Stop', 'UserPromptSubmit']
```
It also fast-forwarded the `/workspace/eds-claude-skills` clone `1d68993..c96d2c6`.

### VERIFICATION (read back from disk — not the script's success message)

`grep '^CURRENT_VERSION' /tmp/eds-claude-skills-sync/setup.sh` → **`CURRENT_VERSION = 12`**

`/home/user/.claude/settings.json` read back:

| Event | `_eds_version` | type | hook |
|---|---|---|---|
| SessionStart | **12** | command | mandatory-dev-discipline echo + bootstrap auto-clone + git-guard check + memory/actions/accuracy-log dump |
| Stop | **12** | agent | the hard verification gate (phase tag, completion-claim classification, AC/verifier subagents, feasibility, integration trace) |
| PostToolUse | **12** | command | `eds-git-guard.sh autosave` |
| UserPromptSubmit | **12** | command | `eds-git-guard.sh check` + `eds-agent-guard.sh` |
| UserPromptSubmit | **12** | command | phase-tag reminder |

**5 `_eds` hooks, all `_eds_version=12`, matching `CURRENT_VERSION = 12`. MATCH CONFIRMED.**

`/root/.claude/launcher-settings.json` after: contains **no** `_eds` hooks (correct for v9+ — it is
deliberately allowlist-only now), retains the harness's own `session-start-git-identity.sh` /
`stop-hook-git-check.sh` hooks untouched, and gained
`permissions.allow += [mcp__github__create_repository, mcp__github__fork_repository]` plus
`autoMode.allow = ['$defaults','Bash(git push*)']`.

Other artifacts refreshed (all now mtime Aug 25 12:25, previously Aug 21 15:51):
16 skills in `/root/.claude/skills/`, 1 agent (`verifier.md`), both guard scripts.

### VERSION: before → after

**Effective installed hook version BEFORE: NONE — the gate was not installed at either path.**
**AFTER: 12.**

Nuance worth stating precisely rather than overclaiming: because nothing was installed, there was
no recorded "old version" to read. What I *can* ground-truth is that a `setup.sh` ran at container
build on **Aug 21 15:51**, and repo HEAD at that timestamp was `aef8402`, whose
`CURRENT_VERSION = 9`. But the CCR "Setup script" field is an out-of-band pasted copy that may lag
the repo, so I cannot prove the build-time script was itself v9. Either way the observable outcome
is the same: **zero `_eds` hooks were active when this session started.**

### What v9 → v12 actually changed (from `git log`, not inferred)

| Commit | Ver | Change |
|---|---|---|
| `a893149` (08-21) | 9 | close silent-failure paths the verifier found in the hook-filtering fix |
| `2938bb3` (08-21) | 9 | `_atomic_write`: preserve file mode, clean up temp files |
| `6709cb0` (08-25) | **10** | **Mechanize the phase tag** — adds the UserPromptSubmit phase-tag reminder hook; corrects the docs claim that sent the hook to a volatile file |
| `a5de2aa` (08-25) | **11** | **Feasibility BEFORE implementation: make it a gate, not an intention** — new Stop-gate requirement (h) |
| `c96d2c6` (08-25) | **12** | **Phase tag enforced on EVERY turn**, not only after a human prompt |

Substance of the three behavioral additions, quoted from the installed `STOP_PROMPT`/`SESSION_CMD`:

- **v10/v12 — phase tag (Step 0, runs on EVERY turn before any other check).** Each assistant turn
  must OPEN with one of: `Fact Finding:` `Ready for AC:` `Writing AC:` `Ready to Implement:`
  `Implementing:` `Ready to Verify:` `Verifying:` `Ready to Merge:` `Merged:` `Deploying:`
  `Deployed:` `Blocked - needs you:`. No tag on the first line ⇒ `continue=false`. v12's rationale,
  in the prompt itself: the UserPromptSubmit reminder fires only on a **human** prompt, so turns
  woken by Stop-hook feedback or a task/agent-completion notification never got it — "exactly the
  turns where the tag was observed to lapse (2026-08-25, twice in a row, owner: *'you stopped usign
  your turn qualifiers'*)". The Stop hook fires at the end of every turn regardless of what began
  it, so it is the only place the requirement can be complete.
- **v11 — feasibility gate, new requirement (h), CODE changes only.** For each dependency the work
  names, the transcript must show the **producer** and the **consumer** located by an actual
  grep/read, with a verdict of **EXISTS / ABSENT / EXISTS-BUT-CONSTRAINED**. It explicitly BLOCKS
  the inverse failure too: any assertion that something is *blocked / absent / not built / "there is
  no X"* must itself be backed by a producer **and** consumer sweep — "a single-file grep, a
  single-name grep, or a quoted code comment DOES NOT COUNT, because a control defined in an
  imported component has none of its strings in the file that mounts it, and a comment describing a
  limitation is a claim about the code rather than the code." Also: anything reported to the owner
  as OPEN must be reconciled against `.claude/actions.md` and `.claude/DEFERRED.md` first — a row
  already built or already decided must not be presented as outstanding.

**Direct relevance to this repo's open items:** requirement (h) now governs how the two parked
items get reported. ACT-61's deferred half rests on the claim *"there is NO `POST /v1/files`
anywhere in the repo"* — under v11 that claim needs a producer+consumer sweep on record, not a
single grep, before it can be restated as blocking. Same for ACT-60's "nothing is outside a clipped
ancestor."

---

## CAVEAT I CANNOT RESOLVE FROM HERE (owner-corrected, dated today)

The repo's `CLAUDE.md` was amended on **2026-08-25** (commit `6709cb0`) with an explicit owner
correction that materially limits what this sync achieves. Quoting it:

> **`/home/user/.claude/settings.json` loads, but it does NOT survive a container reclaim.**
> *CORRECTED 2026-08-25 by the owner: "gets wiped when the container is reclaimed so that's not the
> best place to put it."* … **Never hand-write a hook into it and consider the job done.** The
> durable path is `setup.sh`, which runs at container BUILD and is captured in the environment
> cache: put the hook there, bump `CURRENT_VERSION`, then run `setup.sh` to apply it to the live
> session too.

So: **v12 is live in THIS session and will persist across ordinary restarts, but a container
reclaim wipes it.** Two failure modes remain open, neither fixable from inside a session:

1. **The CCR environment "Setup script" field is out-of-band and may be stale.** If it still holds a
   pre-v12 copy, every future container build re-installs the older gate (or, if pre-v9, installs
   into `launcher-settings.json` where it is wiped at launch — the exact state I found today). Only
   the user can update that field (claude.ai/code → environment → edit).
2. **Re-running `sync-setup-script` is therefore a per-session action**, not a one-off after a repo
   change — which the skill's own docs do not yet say.

Note this is also why `setup.sh` now ships a **launcher-reset detector** (`check` mode writes
`/root/.claude/eds-launcher-reset-log.jsonl` + `.eds-launcher-lkg`). Neither file existed pre-sync,
confirming the `check` hook had never run this session; they will be created on the next
UserPromptSubmit.

### One thing that did NOT propagate (checked, and it is correct)
The repo `CLAUDE.md` gained 8 lines, but `/root/.claude/CLAUDE.md` changed by only 1 byte
(md5 `25bcd4a0…` → `d5fb4601…`). Not a bug: `setup.sh` copies only the
`<!-- GLOBAL-RULES-START -->`…`<!-- GLOBAL-RULES-END -->` block, and the 8-line owner correction
sits at ~line 504, outside that block. The phase-tag requirement likewise does not appear in
`/root/.claude/CLAUDE.md` (grep count 0) because it lives in the hook prompts, not the rules block.

---
