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

## Assistant IDs
Single source of truth: `src/features/huddle/data/assistant-ids.json`. Imported by
`agent-backends.ts` and the fetch/create scripts. Do not hand-copy the map elsewhere.

## Keeping platform ⇄ snapshot in sync
- `sync-assistants.yml` — push authored instructions up, then pull a fresh snapshot (manual).
- `snapshot-refresh.yml` — daily pull-only (preserves dashboard edits) + deploy on change.
- `provision-assistants.yml` — create assistants for any agent missing one.
