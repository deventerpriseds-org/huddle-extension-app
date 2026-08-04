# Plan — ceremony content + barge-answer fixes (F3–F12)

Groups the standup-quality issues by the shared layer they live in. All fixes go in the **shared**
directive / round-robin-plan / barge-answer layer (not per-agent), so they cover BOTH engines
(`current` and `current-optimized`, which reuse the same directives). Systematic, data-driven — no
per-agent hardcoding.

## Workstream D — Barge answer MUST speak (F12) — do FIRST, highest priority
**Problem:** a barge that needs a tool executes the tool but says nothing. (Terry ran 3 web searches for
the UPenn link, spoke zero words — no ack, no result, no deferral.)
**Root:** barge-answer path `MeetingBar.runBargeSequence` → `sendHuddleMessage({ceremonyBarge:true})` →
agent turn. When the turn makes tool calls, the final spoken reply comes back empty / isn't voiced by
`speakInterjection`. A silent barge is worse than a slow standup.
**Fix:**
1. Generation: the barge turn must ALWAYS end in a spoken reply after tools — (a) acknowledge what was
   asked, (b) deliver the result inline if a tool produced it, or (c) say explicitly it'll follow after
   the standup and (if appropriate) defer via a task/reminder. Never tool-only-and-silent.
2. Voicing: confirm `speakInterjection` voices that reply; if reply text is empty, surface a minimal
   spoken ack rather than nothing.
**Files:** `MeetingBar.tsx` (runBargeSequence), the ceremony-barge branch of `sendHuddleMessage` /
`runHuddleTurn` in `huddle.functions.ts`, `useCeremonyVoice.ts` `speakInterjection`.
**Also covers:** the earlier "Terry never responded to my end action" (same family).

## Workstream E — Tool-usage progress narration ("thinking out loud") to kill dead air (NEW)
**Problem:** while a tool runs (a barge search, any tool call) there's dead silence — the user hears
nothing and doesn't know anything is happening. Robo-support solves this with staged spoken cues.
**Goal (user's model):** *"Yes sir?… let me check that… I'll run a web search… okay, some results…
one more moment, I'm pulling it together… here's what I found."* — the agent narrates its own progress
in ITS cloned voice, so the gap is filled naturally.
**Mechanism (general — D is its first consumer):**
- Staged, VARIED filler phrases (not one repeated line), templated so they're instant + free (no LLM):
  - **ack:** "Yes sir?" / "On it." / "Sure — let me check that."
  - **working:** "Let me look that up." / "Running a quick search." / "One moment, pulling this together." / "Almost there."
  - **handoff to result:** the real answer (Workstream D) lands here.
- **Cadence:** emit one cue when a tool starts; if it runs long, another every few seconds; stop the
  instant the real answer is ready.
- **Voice:** ElevenLabs in the agent's `voiceId` (same `voiceTurn`/synth path).
- **Suppression (user's hard constraint):** only when this agent holds the ACTIVE audio floor. If the
  answer is DEFERRED (coming later, not now) → skip the narration (at most a single "I'll pull that
  together and send it after standup"). NEVER talk over the next scripted speaker — reuse the driver's
  park/serialize + genRef so if the floor moves on, narration stops immediately.
**Requires:** the client to observe the tool lifecycle (tool-start / results-in / answer-ready). For a
barge this means either streaming the barge turn's tool events to the client, or the server emitting
interim "narration" markers the client voices. Scope the hook during implementation.
**Files:** `useCeremonyVoice.ts` (a `narrate`/filler path alongside `speakInterjection`), `MeetingBar.tsx`
(drive it off the barge/tool lifecycle), the `ceremonyBarge` turn path in `huddle.functions.ts` (surface
tool-lifecycle signals).
**Composes with D:** D guarantees the answer is spoken; E fills the wait before it. Together = ack →
progress → result/defer, no dead air, no silence.

## Workstream B — Round-robin plan: who speaks, handoff, close (F9, F10, F11)
**Problems:** F9 empty-lane agents get a slot and then invent work; F10 handoff to Eli who never goes;
F11 premature close (Eli named, never went, Terry closed anyway).
**Root:** participant/opener→owners→closer plan assembly (`huddle.functions.ts` round-robin +
`buildCeremonyReport`). Participant list, the per-update handoff target, and the closer trigger are out
of sync.
**Fix (data-driven):**
- **F9:** build the owner list from agents that actually have open lane items (from `getStandupTasks`
  per lane). No real work → not a speaking slot. (Removes the fabrication incentive at the source.)
- **F10:** any "over to you, X" handoff must target the ACTUAL next participant in the plan, or be
  dropped entirely and let the driver sequence — never name an agent who isn't scheduled.
- **F11:** the closer (host) runs as the final slot ONLY after every planned participant has spoken —
  the close can't fire mid-plan.
**Files:** `huddle.functions.ts` (participant selection + plan), `ceremonies.ts` (`buildCeremonyReport`).

## Workstream A — Standup content directives (F3, F4, F5, F6, F8)
**Problems:** F3 Cole repeats the host's "you're up" as his own opener; F4 agents talk as if tasks are
THEIR work, not work done for the user; F5 Sam's performative opener; F6 Tess's "ready to give my update"
preamble; F8 Faith fabricates ("coordinating family calendar events").
**Root:** the shared standup directives (`openerDirective`/`ownerDirective`/`closerDirective` +
standup house-style) — additive constraints only (prompts are additive-only; this adds rules, doesn't
cut canonical persona content).
**Fix (one shared layer):**
- **F3:** never repeat the host's handoff line ("<name>, you're up") — start with your actual status.
- **F5/F6:** deliver directly — no performative opener, no "I'm ready to give my update" preamble.
- **F4:** frame updates as work done FOR the user / toward their goals, not "my task."
- **F8:** ground STRICTLY in the board facts provided; if the lane has no open items, a brief
  "nothing to report" — NEVER invent work. (Pairs with F9 removing empty agents entirely.)
**Files:** `ceremonies.ts` (the directive builders) + the shared standup house-style layer.

## Workstream C — Elle sounds lost / asks questions (F7) — INVESTIGATE (likely folds into B)
**Hypothesis:** Elle's lane (Education) has no mapped/open tasks, so instead of "nothing to report" she
asks for input — the empty-lane symptom. If so, **B (F9)** removes her from the round-robin and A (F8)
covers the wording. Also check her snapshot in `openai-assistant-snapshots.json` vs peers for a real
config difference before assuming.
**Action:** confirm via a transcript + her lane data + snapshot diff before writing any Elle-specific fix.

## Proposed sequence
1. **D + E together (F12 + narration)** — the full barge experience (ack → progress narration → result/
   defer). Silent barge is the worst; this is the headline fix.
2. **B (F9/F10/F11)** — structural; also kills the fabrication incentive.
3. **A (F3–F6/F8)** — content polish on top of B.
4. **C (F7)** — verify it's just the empty-lane case (probably resolved by B), else targeted.

Each workstream: independent ACs → implement in the shared layer → independent verifier → live re-test
(voice/perceptual items need the user's live confirmation, per repo rule). Both engines covered at once.
