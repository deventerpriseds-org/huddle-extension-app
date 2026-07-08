## Root cause found

The five "404" agents (Iris, Tess, Faith, Ezra, Troy) are not missing in OpenAI — their IDs in the codebase were transcribed with a capital `I` where the real IDs have a lowercase `l`. All five assistants exist in this project and match the personas exactly:

| Persona | Real assistant | Correction |
|---|---|---|
| iris-chase → Daily Itinerary Agent | `asst_BcZBxlx9zH8VIPvfJrhPP3EF` | `l` for `I` (twice) |
| tess-sutton → Task Tracker Agent | `asst_KnIB4EMkB5ziEwZZdwEFzoIl` | trailing `Il` not `II` |
| faith-hartley → Family Scheduler | `asst_gY8usQlJelYXLZzQm08Z0C2x` | `Ql` not `QI` |
| ezra-miles → Home & Errands | `asst_FldoVvUYjszVEei8QBo2LFoO` | `Fl` not `FI` |
| troy-lennox → Travel Agent | `asst_AqTwFwQx5RlCAH3OPYVPCG5Q` | `5Rl` not `5RI` |

## What I'll build

**1. Correct the assistant IDs**
- Update `ASSISTANT_IDS` in `src/features/huddle/lib/agent-backends.ts` and the parallel map in `scripts/fetch-openai-assistants.ts` with the five corrected IDs.
- Re-run `bun run fetch:assistants`. Expected outcome: `openai-assistant-snapshots.json` grows from 7 entries to all 12. Verify with a diff summary printed by the script.

**2. New hard rule — every fallback must be user-visible (commit to project memory)**
- Add a `Core` rule to `mem://index.md`: *"Any runtime fallback must surface a visible alert to the user — never degrade silently."*
- Wire it in three places:
  - **Inline tag on the message** — when an agent's reply comes from anything other than its authored path, append an italic muted line: `(fallback: <reason>)` — e.g. "no OpenAI snapshot, using in-repo prompt", "OpenAI unreachable, replied via Lovable AI", "router LLM failed, using keyword routing", "RAG store unavailable, replied without memory".
  - **Persistent status banner** in `HuddleView` header — badge listing every currently-degraded subsystem, click to expand details. Driven by a shared `useFallbackStore` (Zustand) that server functions populate via the reply envelope.
  - **Activity-tab entry** — each fallback event becomes a row (timestamp · agent · subsystem · reason) so history is auditable.
- Extend the `sendHuddleMessage` return type with `fallbacks: FallbackEvent[]`, and thread the events through router, agent-model call, tool dispatch, and RAG paths so every silent degrade is captured.

**3. Agent settings viewer (click avatar → drawer, plus full page)**
- Make every `AgentAvatar` clickable — opens a right-hand drawer showing, for the selected agent:
  - Snapshot status: `authored (snapshot ✓)` or `fallback (in-repo prompt)`
  - Backend, model, tools (snapshot + RAG), RAG config
  - **Full system prompt** rendered in a monospace `<pre>` — exactly `snapshotInstructions + scene + ragInstructions`, i.e. what actually gets sent to the model
  - "Refetch snapshot" button (calls the server fn for that one assistant ID; requires OPENAI_API_KEY)
- Add a dedicated `/agents` route (TanStack file route) listing all 12 agents side-by-side with the same detail expandable; avatar-drawer's "Open full page" button navigates there.
- SettingsSheet's existing per-agent controls stay but are joined by a "View full prompt" link that opens the same drawer.

**4. Agents aware of one another**
- Add a compact roster block that gets appended to every OpenAI-backed agent's instructions server-side (and to Lovable-backed agents' system prompt):
  ```
  Team roster (use @handle to hand off):
  - @iris-chase — Daily Itinerary Agent (itineraries, day plans)
  - @tess-sutton — Task Tracker (queue, backlog)
  - ...
  ```
- Built from `AGENTS[]` at server start so it stays in sync when agents are added/removed. Excludes the speaking agent from their own roster.

**5. Activity-tab prompt/instruction history**
- Persist every user turn's outbound instruction bundle per agent (system + scene + roster + RAG hint + user transcript window) in a client-side ring buffer (Zustand, capped at 50 turns × per huddle) keyed by turn id.
- Activity tab gets a new "Prompts" section: each turn expandable, showing per-agent exact instructions and the resulting reply. Copy button per block.
- No server persistence yet — matches the current in-memory model of the app; can be promoted to DB later.

## Technical details

- ID fix is data-only, no API shape change.
- `FallbackEvent` shape: `{ id, ts, agentId?, subsystem: "openai" | "snapshot" | "router" | "rag" | "tool", reason: string }`.
- Server function returns `{ decision, replies, fallbacks }`; UI reducer merges into store.
- Roster string is memoised at module scope in `huddle.functions.ts`, computed from `AGENTS`.
- Avatar-click uses a `useAgentSettingsDrawer` store toggled by `AgentAvatar` `onClick`; the sheet mounts once in `HuddleApp`.
- `/agents` route file: `src/routes/agents.tsx`, with head() setting a real page title.

## Verification before finishing

1. `bun run fetch:assistants` — snapshot file contains all 12 entries with non-empty `instructions`.
2. Send a message to Iris; drawer shows the authored Daily Itinerary Agent prompt (not the `p()` fallback), and no inline fallback tag appears.
3. Temporarily break one agent's ID → confirm inline tag, banner entry, and Activity row all fire.
4. Click any headshot → drawer opens with settings + full prompt.
5. `/agents` route renders and links from drawer work.
6. Roster block visible in the drawer's rendered instructions for at least one agent.
