# Huddle — working rules

## Agent prompts are ADDITIVE-ONLY (hard rule)

The agents' instruction content is a canonical asset. Do **not** replace, thin, shorten,
or delete existing agent/assistant prompt content without **explicit user approval** for
that specific subtraction.

This applies to all three places agent instructions live:
- **Platform assistants** on OpenAI (edited via `scripts/push-assistant-instructions.ts`).
- **`src/features/huddle/data/openai-assistant-snapshots.json`** — the snapshot the runtime reads.
- **In-repo `p()` personas** in `src/features/huddle/data/agents.ts`.

Rules:
1. The original journey-voice prompts are the best/canonical source — preserve them. When a
   role changes, **layer** the change on top; never overwrite the rich prompt with a thin one.
2. Cross-agent concerns — **house-style/formatting, lane ownership, handoffs** — belong in the
   **shared runtime layer**, not baked into a specific agent's prompt. Change them in one place.
3. Any subtractive prompt edit (removing/replacing content, re-scoping by deletion) requires
   explicit user sign-off first. When in doubt, add — don't cut.
4. **Do not silence flags or error traps to make an issue disappear.** Fix the root cause
   (architecture/design/logic). A firing trap is signal, not noise.

### How agent instructions compose at runtime
Two content sources exist per agent: the **platform snapshot** (rich, canonical) and the
in-repo **`p()` persona** (compact fallback). The role split (who answers what) is enforced by
**routing** (`domains`/`themes`/`special` in `agents.ts`), NOT by prompt text — so restoring a
rich prompt does not change routing. The snapshot is the domain layer; shared house-style and
handoffs are a separate always-appended layer (`SHARED_COORDINATION` in `huddle.functions.ts`).

## Prompt source of truth (code-authoritative)
`src/features/huddle/data/openai-assistant-snapshots.json` is the **authoritative,
git-versioned source** of every agent's instructions. Edit it directly and commit — git
history IS the version record, so a degrading change is reverted with `git revert`/restore.
OpenAI is sunsetting BOTH the Assistants API and reusable Prompt objects (their guidance is to
keep prompts code-managed), and Huddle's runtime is already 100% Responses API reading this
snapshot — so the OpenAI platform `asst_…` objects are legacy and must NOT be treated as the
source of truth. Vector stores (file_search) are separate Files/vector-store API objects and
remain valid.

## FROZEN platform workflows (do not run)
These are disabled (each has a `Frozen — refuse to run` guard) because they would push to or
pull from the deprecated platform objects and could clobber the authoritative snapshot:
`sync-assistants.yml`, `snapshot-refresh.yml`, `provision-assistants.yml`, `revert-assistants.yml`.
To change an agent's instructions, edit the snapshot JSON directly.

## Assistant IDs
`src/features/huddle/data/assistant-ids.json` maps agent → legacy `asst_…` id. Kept for
reference/vector-store bindings; not the prompt source of truth.
