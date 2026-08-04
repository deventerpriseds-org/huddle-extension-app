# Ceremony feedback log (living doc)

Running list of user-observed standup/ceremony issues, so they're captured while we work on other
things and folded in as appropriate. Add items as they come; update Status as they're addressed.
Status: `OPEN` · `IN PROGRESS` · `FIXED (branch)` · `DEPLOYED` · `USER-CONFIRMED`.

Categories: **driver** (playback/barge sequencing) · **content** (what agents say — prompts/directives)
· **round-robin** (who speaks / order / handoff / closer) · **lifecycle** (attended vs automated, resume).

| # | Item (user words) | Category | Root / where | Status |
|---|---|---|---|---|
| F1 | Left the app during a live ceremony → audio stopped and never returned when I came back. Backgrounding to save ElevenLabs cost is fine for an **automated** ceremony I'm not attending, but "tab backgrounded" is the WRONG signal — need a **data-driven "is this ceremony automated/unattended"** signal instead; a live attended ceremony must resume audio on return. | lifecycle | `useCeremonyVoice.ts:213` `synthOne` suppresses audio when `document.visibilityState !== "visible"` and never resumes. Replace the visibility signal with an explicit "automated/unattended" flag on the ceremony run (scheduled vs user-started). | OPEN |
| F2 | Cole came in and took over me during my barge (cross-talk during barge). | driver | Barge/`genRef`-abort race lets `emit` advance to the next speaker while the interrupted one resumes → two concurrent speakers. Phase 1 R5a (serialize-on-abort) targets this. | FIXED (branch, Phase 1 147f0c2) — verify live |
| F3 | Cole Blake said to himself that he was up. | content | Agent narrates its own handoff/turn ("he was up") — meta/self-narration. Tighten the owner directive to forbid narrating the handoff. | OPEN |
| F4 | Agents speak as if the tasks are **for them**, not things they do **for me**. | content | Persona/directive framing — updates should read as "work I'm doing for you," not the agent owning the task. Fix in the shared standup directive layer (`ownerDirective`/house-style), not per-agent. | OPEN |
| F5 | Sam opens with performative theatrics ("let's keep…") — he can just deliver without the flourish. | content | Standup directive should suppress performative openers; deliver the update directly. | OPEN |
| F6 | Tess adds no value saying she's "ready for her update" instead of just giving it. | content | Same as F5 — kill the "ready to give my update" preamble in the directive. | OPEN |
| F7 | Elle consistently sounds lost / asks questions as if she got a different setup than everyone else, like the prep skipped her. | content | Investigate Elle's snapshot/persona vs the others — she may be missing the standup context/lane data the others get. Check `openai-assistant-snapshots.json` + how her lane facts are built. | OPEN |
| F8 | Faith fabricates work not on the board ("coordinating family calendar events" she didn't do). | content | Agents invent updates when they have no real board items. Directive must ground strictly in board facts; "nothing to report" is required when the lane is empty — no fabrication. | OPEN |
| F9 | Faith's segue added no value; if she had no work there was no reason for her to be in the round-robin at all. | round-robin | Participant selection should skip agents with no real lane work (don't force an empty-lane agent into a slot where they'll invent). | OPEN |
| F10 | Faith passed to Eli, who never goes. | round-robin | Handoff to an agent who then never speaks — broken handoff/participant mismatch between who's named and who's actually in the round-robin. | OPEN |
| F11 | Tess closes the meeting instead of the host (Terry). | round-robin | Closer selection is wrong — the host should close, not an arbitrary member. Check closer assignment in the round-robin plan. | OPEN |

## Latest transcript evidence (run pulled 2026-08-04, `chat.ceremony_transcript`)
- **F3 CONFIRMED** — Cole's block literally repeats Terry's handoff: seq 5–6 Terry says *"I'll hand it over to Cole Blake for the career updates. / Cole Blake, you're up."* then seq 7–8 **cole-blake** opens with the SAME two lines verbatim, and again at seq 14 *"Cole Blake, you're up." / "Thanks!"* before his real update. The owner's generated update is swallowing the host's handoff text. (This same echo drives F4/F5/F6 — the performative/self-referential preamble.)
- **F8 CONFIRMED** — seq 41 faith-hartley: *"I'm currently coordinating family calendar events, and there's nothing else in progress, in review, or blocked."* (fabricated; not a real board item).
- **F10 CONFIRMED** — seq 42 faith-hartley: *"How about you, Eli?"* → no Eli rows follow → Terry closes. Eli was named but never in the round-robin.
- **F11 NOT reproduced in this run** — here **Terry** closed (seq 43 *"Let's close the daily stand-up."*), not Tess. May have been a different run, or the closer is nondeterministic. Re-check before treating "Tess closes" as the rule; the underlying issue (closer should deterministically be the host) still stands.
- **F2** — the barge worked functionally this run (user barge seq 10/12 → Terry ran real web searches for the UPenn course link, seq 14–20), but Cole's rows interleave with the `interrupted` markers (seq 9/11/13) — consistent with the resume/advance race.
- **Latency persists** — seq 1→2 is a ~22s gap before the first real block; Cole handed at 39s, spoke at ~52s. (Phase 1 cache/parallel targets this.)

## Notes
- **F3–F11 are largely CONTENT/round-robin** = the standup generation (`buildCeremonyReport` + `openerDirective`/`ownerDirective`/`closerDirective` in `ceremonies.ts`, and the round-robin participant/closer plan in `huddle.functions.ts`). Because Phase 1's `current-optimized` fan-out reuses these SAME directives, fixing the directives improves BOTH engines at once — do it in the shared layer, not per-agent (systematic-capability rule).
- **F1 (lifecycle)** is independent of the engine — it's the attended-vs-automated signal.
- **F2 (driver)** is addressed by Phase 1 R5a; confirm live once Phase 1 is deployed.
- Ground-truth: each item should be checked against `chat.ceremony_transcript` for the run before marking FIXED/confirmed.
