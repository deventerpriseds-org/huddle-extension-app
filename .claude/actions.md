# Action Tracker — huddle-extension-app
Last updated: 2026-07-31 (ACT-huddle-12 problem #1 — Transcript/Chat tabs — implemented + deployed + verifier PASS, awaiting user live confirmation; also closes the mechanism for ACT-huddle-6 same-brain 1:1 chat/voice)

> Enforced by `.claude/settings.json` (SessionStart surfaces this; the Stop gate blocks
> claiming any item "done" without ACs + the verifier subagent / observed evidence).
>
> **Numbering note:** `ACT-huddle-3/4/5` appear TWICE in this file — once here in Open (the
> enqueueHuddleTurn-500s / barge-reliability / cross-talk-caption items from 2026-07-30) and once
> under Closed (an unrelated, earlier capability-handoff fix, closed 2026-07-30). Pre-existing
> collision, not fixed here — new items below continue from ACT-huddle-6 to avoid making it worse.

## Open

### ACT-huddle-6: Cross-modality "same brain" — 1:1 chat vs. 1:1 meeting-room (voice) give different answers/capabilities
**Requested:** 2026-07-31 — user's own words: "the outcomes I get from a one-on-one chat versus what
I get when I hit the record button and I'm in the one and one meeting room [are] totally different
so if I ask Iris... for what the day['s] schedule is she can return that to me when I do the same
thing in the 1:1 meeting room they say they have no clue how to do that which tells me something's
broken and that they're not the same brain... whether in a chat or meeting room or phone call etc
it's all the same brain and the same person on the same personality same tools etc."
**Expected outcome:** asking the same question (e.g. "what's on my schedule today") gets the same
capability/answer regardless of modality — 1:1 text chat, 1:1 meeting-room (voice/recorded), or
phone call — because it's the same agent, same tools, same personality underneath.
**Investigation needed:** why does the meeting-room voice path (`useGroupVoiceRealtime` /
ceremony voice pipeline) not have the same tool access (e.g. journey proxy tools like
`get_calendar_events`/schedule lookups) or system-prompt parity as the normal chat turn path
(`runHuddleTurn`)? Likely candidates: the voice path may route through a different/thinner prompt
assembly or a restricted tool list, or the Realtime API session config doesn't register the same
tool schemas the Responses-API chat path gets.
**Status:** open — ACs pending `/define-acceptance-criteria`; not yet investigated.

### ACT-huddle-7: Finish the ceremony voice rebuild — replace push-to-talk/MP3 with the working WebRTC mechanism
**Requested:** 2026-07-31 — user's own words: "we talked about repairing a bad attempt at fixing the
ceremony to use the successful [WebRTC] we've used other places instead of this push to talk option
[that] is in place right now and a recorded MP3 that does not allow me to barge and when I do barge
it's sitting in between the speakers so[,] supposedly[,] the answer[,] it's a bad design[,] it's not
what I asked for so we talked about fixing that in great detail[.] [T]ake a look at the notes to see
what was intended and we need an action to finish up that work."
**Context (from this session/prior notes):** the ceremony transcript/voice path
(`MeetingBar.tsx`'s `runCeremony`/`emit`/`speakCeremonyTurn`) still uses recorded-MP3 TTS with
between-speaker-only barge handling — full text renders before audio plays, and a barge is queued
and answered between speakers rather than truly interrupting mid-utterance. A first fix attempt was
explicitly rejected by the user (skip-to-next-speaker instead of true resume; proportional-estimate
captions instead of real timestamps) and was abandoned/lost. Separately, a concurrent session built
`useGroupVoiceRealtime` (OpenAI Realtime WebRTC + VAD, ≤200ms barge detection, same-agent resume from
the interrupted sentence, per-sentence EL TTS) for the live 1:1 voice-call path — already deployed
and working. User wants that SAME mechanism extended to cover ceremonies instead of a from-scratch
rebuild of the old approach.
**Expected outcome:** during a ceremony, the user can barge in mid-sentence, the agent stops exactly
where it is, answers the interruption, then resumes the SAME turn from the exact interrupted point
and continues through its remaining checklist items — using the proven WebRTC mechanism, not the
MP3/push-to-talk one.
**Reference:** `docs/plan-ceremony-conversational-realism.md` (handoff summary section), the 30 ACs
previously drafted for the mid-utterance-interrupt work, ACT-huddle-5 above.
**Status:** open — ACs pending `/define-acceptance-criteria`; needs a design decision (extend
`useGroupVoiceRealtime` to ceremonies vs. a ceremony-specific variant) before implementation.

### ACT-huddle-8: Stop agents' own process/test tasks from polluting the user's personal board — agents need their own work-tracking
**Requested:** 2026-07-31 — user's own words: "we need to have a guard against these test tasks and
also just miscellaneous tests that are created by the agents for doing their own work[. I]t's
polluting my board[. I] should be the only thing added to my personal board... things that I myself
[added] or things that I've said that I want us to work on[. T]hey may need their own table where
they can track items to be done[,] similar to our actions list... so they're not forgetting work and
so that things are continuing to get done[,] but also not adding to my board which I'm supposed to
be the center of focus and attention for... maybe that's something they should be aware of in their
prompt[s]."
**Already done today (narrower fix):** `create_huddle_task`'s capability meta-task guard now also
blocks an agent from filing a card that restates ITS OWN just-performed exclusive-capability action
(previously only blocked non-owners) — commit `a9bc974`, deployed, and 6 existing pollution rows
(`Groom backlog`, `Assign tasks`, `Review backlog grooming outcomes`, `Add review gate check to
write-up`, `Confirm review gate inclusion in write-up`, `Add a poll in Microsoft Teams`) deleted from
journey's canonical `public.tasks` per user confirmation.
**Still open — the fuller ask:** design and build a SEPARATE agent-internal work-tracking mechanism
(a distinct table, analogous to this project's own `.claude/actions.md` concept) so agents can track
their own multi-day/multi-week to-dos WITHOUT ever writing to the user's personal board, and update
agent prompts/instructions so every agent is aware of this distinction (its own scratch list vs. the
user's board). The user's board should contain ONLY items the user created or explicitly asked to
have tracked.
**Expected outcome:** the user's board is never touched by agent-internal process work again (not
just the exact titles caught by the capability-trigger guard — general agent to-do/reminder content
too), and agents have somewhere real to track their own ongoing work so nothing gets silently
dropped across days/weeks.
**Status:** open — ACs pending `/define-acceptance-criteria`; the narrower guard fix (above) is
CLOSED, but this broader mechanism is NOT built yet.

### ACT-huddle-9: Standup ceremony tiered test plan — Tier 1 (lightweight, screenshot-proven) then Tier 2 (full scripted UAT)
**Requested:** 2026-07-31 — user's own words: "continue with the stand up[. T]here were a couple
tests that we decided to do[,] like a tier one test [and] a tier 2 test[. T]he first test was
supposed to do a lightweight[,] cheaper approach to making sure that the conversations between two
or three agents and myself can go smoothly[,] whether via chat or voice[,] making sure the
interruptions and everything else [go] fine[,] then going through a full UAT with a script that we
have put together that should make sure we can capture all the screenshots we need[. T]he lower tier
was supposed to have screenshots as well[,] but before [U]AT[,] screenshots to prove that this thing
works before I jump into it and get the same errors I've been receiving right away."
**Expected outcome:** Tier 1 = a cheap/lightweight check (chat AND voice, 2-3 agents + user,
including interruption handling) that produces real screenshot evidence BEFORE Tier 2 runs — so
Tier 2 isn't started blind into the same recurring errors. Tier 2 = the full scripted UAT capturing
every screenshot the existing script calls for.
**Status:** open — needs to look back at `docs/plan-ceremony-conversational-realism.md`,
`.claude/memory.md`, and this file's ceremony-related entries (ACT-huddle-3/4/5/7 above) to resume
exactly where the tiered plan left off. ACs pending `/define-acceptance-criteria`.

### ACT-huddle-10: New skill — draft email replies via existing Graph/Outlook access (draft-only, never auto-send)
**Requested:** 2026-07-31 — user's own words: "drafting skills... if I tell him I need to respond to
the email from Bridget [Compter] he... should have access to my inbox through our [G]raph that we
set up through Microsoft Outlook[. H]e should be able to review that email[,] confirm it's the right
one[,] and put together a draft for me with a single click[/]a single copy [option]... to drop the
right [reply] to my email... [it should] confirm the person or the email I was speaking of and draft
a response[,] sitting in draft[,] and never... send[. T]hat should be [a] hard guard against sending
emails out[. I] will do that for the moment[;] we can revisit that later[,] but for now no [auto-]
sen[ding] on emails[,] just drafting."
**Expected outcome:** user says something like "reply to the email from Bridget," the agent uses the
existing app-only Graph client to find/confirm the right email, composes a reply, and saves it to
the mailbox's Drafts folder only — with an easy one-click/copy path for the user to review and send
themselves. Hard requirement: the agent must NEVER send an email on its own; sending is explicitly
out of scope for now, to be revisited later per the user.
**Status:** open — ACs pending `/define-acceptance-criteria`; not yet designed/built. Reuse the
existing Graph app-only client (`email/graph-email.server.ts`, same one calendar reads already use)
per this repo's "extend, don't duplicate" rule — do not mint a new Graph integration.

### ACT-huddle-11: New skill — correspondence watcher/triage + reply-tracking (email + text), with drafting and "clean this up" rewriting
**Requested:** 2026-07-31 — user's own words: "anything that the watcher picks up as [correspondence]
— an email from my wife[,] an email from a co-worker[,] an email from someone at my bank — it needs
to... notify me that I have a message... and [have] prepared a response[. I] can talk it through how
to fix that or... just edit it myself from the draft[. B]ut... more importantly I just need to make
sure that I don't get messages that I don't reply to or that I... go too long with a message I know
about that I didn't miss but I'm just not responding in time[. H]e should be able to draft responses
to emails[,] responses to text messages... if I give him specific text for a draft... he should be
able to[,] like [Gr]ammar[ly] or... ChatGPT[,] clean it up and give me a version that is better
suited." User is unsure whether this belongs in huddle-extension-app or journey-voice.
**Expected outcome:** for correspondence from real people relevant to the user's life (wife, coworker,
bank, education, bills, family, friends — and sensibly expanded categories), the user gets notified a
message arrived, a draft reply is prepared for review/edit, and — most importantly — outstanding
replies are TRACKED so the user never silently misses a message or lets a reply go stale without
knowing it. Same drafting extends to text messages, and to general "clean this up" rewriting of
user-supplied rough text into a better-suited version.
**Open question (needs resolving, not guessing):** does "the watcher" here refer to the
`mail-and-appointments` middleware app (per this repo's CLAUDE.md, M365 + Google email/calendar) —
if so, is the correspondence-triage/reply-tracking logic better owned there, in journey-voice, or in
huddle-extension-app? Investigate before designing ACs.
**Status:** open — ACs pending `/define-acceptance-criteria`; not yet designed/built. Related to but
distinct from ACT-huddle-10 (drafting mechanism may be shared; tracking/notification is the new part).

### ACT-huddle-13: Jira-style task tags (research) — a "parking lot" tag/lane that opts a task OUT of all automation
**Requested:** 2026-07-31 — user's own words (lightly cleaned up): "how to add tags to the tasks similar
to Jira (research). When I tell Iris to parking lot an item it should go back to the backlog with a
parking lot tag, this should be a toggleable lane on the board that is default off. Only items that are
NOT parking lot should be going through the automated workflow or scheduled in Huddle or nightly
scheduling. Anything that has the parking lot tag should NOT be prompted to push through the work
pipeline nor added to the nightly builder queue. Figure out how we can achieve this."
**Expected outcome:**
- General tagging capability on tasks (Jira-style), not just a single hardcoded "parking lot" value.
- Telling Iris (or any agent) "parking lot this" moves the task back to `BACKLOG` status and applies a
  `parking-lot` tag.
- The board has a Parking Lot lane/column that's **toggleable and OFF by default** — hidden until the
  user turns it on.
- Any task carrying the `parking-lot` tag is **fully excluded** from: (a) Huddle's automated per-agent
  work pipeline (BACKLOG→UP_NEXT→DOING promotion + auto-research turns), (b) any Huddle-scheduled/
  cadence job that would act on it, and (c) journey's nightly scheduling/planner run. It should never be
  silently picked up and pushed forward again once tagged.
**Investigation already done this session (extend, don't duplicate — real prior art exists):**
- **Tagging is NOT a new concept — `tags TEXT[]` already exists** on `tasks.journey_tasks`
  (`tasks.server.ts:48,56`), already synced from journey's grooming write-back, already used for at
  least one real tag (`blocked-on-capability`, per ACT-4's residuals). The "Jira-style tags" ask is
  substantially about GENERALIZING and exposing this existing column/mechanism, not building a new one
  — confirm whether journey's `public.tasks` already has a parallel `tags` column or whether it only
  exists Huddle-side today (check before assuming).
- **Toggleable board lanes are NOT new either** — `BoardView.tsx` already drives columns off a
  data-driven array (`statuses` per column, e.g. the existing "Ready for review" column keyed off
  `IN_REVIEW`, `BoardView.tsx:31`) and already has swimlane collapse/toggle state
  (`toggleLane`/`collapsed`, `BoardView.tsx:88-94`). A Parking Lot lane is very likely a new column
  entry in that same array plus a visibility flag, not a new UI system.
- **Per-user toggle infrastructure already exists** — `agent_workflow_config` (this session's own
  ACT-57: schema + resolver + Settings UI) is the natural home for a "show Parking Lot lane"
  default-off preference, rather than inventing a second settings mechanism.
- **Automation entry points that MUST filter out `parking-lot`-tagged tasks** (concrete, not
  hypothetical — these are the actual candidate-selection sites):
  1. `autowork.server.ts`'s per-agent bucketing query (where BACKLOG/UP_NEXT/DOING candidates are
     selected for promotion — `autowork.server.ts:207+`) — needs a `NOT ('parking-lot' = ANY(tags))`
     condition, or equivalent, at candidate-selection time.
  2. `scheduler.server.ts`'s job dispatch (`fireJob`, e.g. the `auto-work`/grooming/standup cadence
     jobs) — confirm whether any of these act on individual tasks directly (vs. just kicking off
     `run-autowork`, which would already inherit the fix from (1)).
  3. **journey's nightly scheduling/planner** (referenced in this repo's own `taskToolInstructions`:
     "the nightly planner can still move it overnight") — this lives in journey-voice, not here; needs
     its own investigation into where it selects candidate tasks for overnight placement.
**Status:** open — this is explicitly scoped by the user as RESEARCH first ("figure out how we can
achieve this"). Do not start implementation until a design (schema decision, exact filter sites in both
repos, and the toggle UI) is written up and signed off — same discipline as every other feature this
session (`/define-acceptance-criteria` after the design, not before).

### ACT-huddle-16: Rewire ceremony voice to Realtime-as-EAR-ONLY + Huddle's real router/snapshots + ElevenLabs voices
**Requested:** 2026-07-31 — user: current ceremony barge approach "is known not to work"; keep the
brains/routing from the 1:1 chats (snapshots, semantic targeting awareness, owner awareness), use
"elevenlabs voices tacked on to openai brains." No A/B testing wanted — build the right thing.
**Ground-truth established this session:**
- OpenAI Realtime + ElevenLabs voices DO compose (journey/Iris `RealtimeVoiceAssistant.ts`; see
  memory.md "voice architecture"). Realtime text-mode + muted OpenAI audio + native VAD/barge
  (`response.cancel` on `speech_started`) + ElevenLabs voices the text. Single-voice-per-session is moot.
- **Root cause of the observed failures (Cole answering for Terry; generic 1:1 "upload your resume"
  replies; Korean hallucination; same sentence re-spoken):** the ceremony barge in `MeetingBar.tsx`
  `runBargeSequence` BYPASSES `routeMessageLLM` — it uses a crude `parseMentions(text) ?? currentSpeaker`
  and forces `scope:"one-to-one"` with that agent, so the semantic addressing/owner-awareness that the
  chat path (`routeMessageLLM`) has is never consulted, and the reply has no ceremony context.
**Design (settled):** Realtime **AS EAR ONLY** (`create_response:false`) for VAD/STT/barge; every barge
utterance routes through Huddle's OWN pipeline — `routeMessageLLM` (semantic "terry"-vs-mentioned +
owner/capability awareness) → winning agent's snapshot + tools, **with ceremony context** (scene/agenda/
prior speakers) → reply → ElevenLabs per-agent voice. Reuse the `useVoiceCallRealtime` pattern.
**Status:** open — ACs being written by an independent AC subagent (2026-07-31); build to follow, then
independent verifier. Supersedes the parseMentions/forced-1:1 barge path and the freeze/re-speak hack.

### ACT-huddle-14: Decide GPT-4o → GPT-5.6 Luna/Terra migration — cost AND performance, not just cost
**Requested:** 2026-07-31 — user's own words: "you need an act to determine if we should be going from
gpt4o to gpt 5.6 luna or if that is going to hurt performance."
**Research already done this session (WebSearch, since no Tavily connector is wired up — see the
Decisions log entry on that):**
- Pricing per 1M tokens (post the 2026-07-30 price cut): GPT-4o $2.50 in/$10.00 out; GPT-5.6 Terra
  $2.00 in/$12.00 out (roughly a wash vs GPT-4o); GPT-5.6 Luna $0.20 in/$1.20 out (~92%/~88% cheaper).
- Performance: OpenAI's own framing is that Luna is "the biggest step change in agentic behavior since
  putting GPT-4o mini into production" — beats GPT-5.5 on Agents' Last Exam/HealthBench Professional/
  DeepSWE, sits only 2.4 points behind the flagship Sol tier on Agents' Last Exam at ~1/5th the output
  cost, and specifically strengthened tool-calling (moved OpenAI from single structured-output calls to
  a full tool-calling agent loop; prompt-cache reuse jumped 24%→90%).
- Confidence caveat: these figures come from convergent SECONDARY reporting (Yahoo Finance, CNBC,
  VentureBeat, artificialanalysis.ai, Axios, qz.com all independently citing the same numbers) — two
  direct WebFetch attempts at OpenAI's own pricing/announcement pages 403'd (bot-protected). High
  confidence via convergence, not confirmed against the primary source directly.
**Expected outcome:** a concrete per-agent model assignment (not a blanket swap) — e.g. Luna for
high-volume/routine agents and tool-calling-heavy turns, Terra reserved for agents whose output quality
matters more than routine chat (Terry's grooming/prioritization judgment, Sam's strategic replies) since
Terra isn't meaningfully cheaper than GPT-4o. Decision must be backed by a LIVE quality comparison, not
just published benchmarks — benchmarks are a starting hypothesis, not proof for Huddle's specific
15-persona voice/tone/tool-use requirements.
**Status:** open — ACs pending `/define-acceptance-criteria`. Suggested first step (not yet done): pick
1-2 agents, run identical real turns against GPT-4o vs Luna vs Terra side-by-side (reply quality, tone
fidelity to the persona snapshot, tool-call correctness, latency), before deciding on a broader swap.

### ACT-huddle-15: Research — OpenAI Voice Agents SDK adoption + real API-cost-reduction levers (prompt caching, Batch API)
**Requested:** 2026-07-31 — user's own words: "add an act for researching should we be using the concept
of an openai voice agent? and also should we be using sandbox agents to avoid draining my api quota?"
**Answered live this session (WebSearch) — logged here so the follow-through isn't lost:**
- **OpenAI Voice Agents SDK** — a higher-level TypeScript layer over the same Realtime API
  `useGroupVoiceRealtime.ts` already talks to directly, providing pre-built `RealtimeAgent`/
  `RealtimeSession` abstractions plus tool-calling, guardrails, handoffs, and session-history helpers —
  categories of code Huddle currently hand-rolls (WebRTC setup, the `oai-events` data channel, VAD barge
  detection, the `AudioQueue` class, same-agent resume, the generation counter). Worth adopting IF it
  doesn't force OpenAI's own TTS output — **unresolved open question:** does the SDK allow swapping in
  ElevenLabs for output (which Huddle needs for its 15 distinct per-agent voice IDs) while keeping OpenAI
  for STT/VAD/turn-detection, or does it assume OpenAI TTS end-to-end? This is the crux of whether
  adoption is a clean win or fights the SDK's assumptions, and needs real investigation (read the SDK
  source/docs, not another web search) before any decision.
- **"Sandbox agents" — clarified, does NOT do what the name suggests for this use case.** In OpenAI's
  current terminology this means isolated CODE-EXECUTION compute environments for agents that write and
  run code (auto-provisioned containers via E2B/Modal/Daytona/Cloudflare/etc.) — infrastructure
  convenience for coding agents, not a token/API cost-reduction mechanism. Huddle's agents are chat/
  tool-calling agents, not code-execution agents, so this feature doesn't apply to the quota-drain
  problem as asked.
- **The REAL cost levers found (not yet exploited by Huddle):**
  1. **Prompt caching — automatic, no opt-in.** Any repeated prompt prefix ≥1,024 tokens seen in the
     last 5-10 minutes bills at 25% of normal input rate (75% savings). This is the EXACT thing already
     flagged as backlog item #1 in this repo's CLAUDE.md ("Prompt-payload efficiency via provider prompt
     caching") — Huddle hasn't reordered its prompt assembly (stable prefix: snapshot+house-style+tool
     schemas+roster; volatile suffix: scene+memory+user msg) to actually earn the cache hits yet. Highest
     leverage, lowest risk, no new adoption needed — just the reordering already on the backlog.
  2. **Batch API — 50% off input+output, non-real-time only.** Doesn't apply to live chat turns, but
     DOES apply to Huddle's already-async work that doesn't need an instant reply: nightly grooming, the
     research/`create_artifact` turns, standup/review digests, the 48h review-recheck job. Currently none
     of these are batched — real, unexploited savings on work that's already async by design.
**Status:** open — the "should we" QUESTIONS were answered live above; what remains is (a) resolving the
Voice-Agents-SDK/ElevenLabs-TTS compatibility question, (b) actually implementing the prompt-cache
prefix reordering (backlog item #1), and (c) actually batching the eligible async jobs. ACs pending
`/define-acceptance-criteria` once the ElevenLabs compatibility question is resolved.

### ACT-huddle-12: Ceremony UI redesign — Transcript tab + Chat tab; remove "Passing your message"; true mid-sentence barge stop
**Requested:** 2026-07-31 — user's own words (paraphrased, full detail below): "we need both tabs —
transcript which is simply what's said by anyone in order — and chat which is a text place for
discussion with non-speakers and interruption if the current speaker. the concept of passing a
message doesn't exist in the real world in live virtual meeting. it is nonsensical and counters my
requirement of stop mid sentence if you are the current speaker and respond using your usual tools.
the agent answered but we can't tell how long that took and the answer has nothing to do with the
original message. there's a lag from clicking the button and the actual start. if terry was really
speaking her transcript text should be seen."
**Three distinct problems identified:**
1. **UI is missing Transcript tab.** Ceremony currently only shows a chat-style panel. Real meetings
   show a live running transcript of everything spoken (by all speakers) in chronological order. When
   the test showed "is speaking…" with no visible text, there was no way to confirm Terry was actually
   mid-sentence vs. loading.
2. **"Passing your message" UX must be removed.** This concept has no equivalent in a real meeting.
   A participant does not "pass" a message — they barge in and the current speaker stops. The label
   is misleading and counters the core requirement.
3. **True mid-sentence stop is not proven to work.** The test shows the agent eventually replies but:
   (a) we can't tell how long it took; (b) the reply content didn't acknowledge the barge message
   specifically; (c) it appeared to be the normal ceremony opening, not a barge response; (d) there
   was no return-to-ceremony after the barge answer. Real barge-in requires: TTS stops the instant
   the user sends chat input → agent acknowledges the specific barge content → agent resumes the
   ceremony from exactly where it stopped.
**Expected outcome:**
- Ceremony view has **two tabs**: **Transcript** (chronological log of all spoken text — agent TTS
  lines appear as the agent speaks them, timestamped, speaker-labeled) and **Chat** (text input area
  for discussion and barge-in that works whether or not a speaker is currently talking).
- "Passing your message" label/concept is completely removed from the UI and any relevant code.
- A true barge-in demonstration is verifiable: (a) transcript shows agent mid-speech, (b) user chat
  input stops TTS immediately, (c) agent's reply references the specific barge content, (d) timing
  is visible (screenshots with timestamps or elapsed time), (e) ceremony resumes from the interruption
  point after the barge is answered.
- The test / screenshot proof shows all five of the above — not just "transcript grew from N to N+1."
**Status:** PARTIALLY DONE (2 of 3 problems) — remainder open.
- **[DONE — deployed to prod `main`, automated UAT PASS, NOT yet user-confirmed live]** Problem #2
  ("Passing your message" removal) and problem #3 (true mid-sentence stop + barge-content reply):
  `MeetingBar.routeTurn` now calls `ceremonyVoiceRef.current.stopListening()` (clears AudioQueue +
  kills the voiceTurn loop) and `setPhase("")` before the async `bargeCeremony` call — the label is
  gone and the current speaker goes quiet the instant the user cuts in. Commit `e20903b` (feature
  branch merged fast-forward into `main`, deployed via `deploy-swa.yml` run 30644156945 = success).
  Independent AC subagent wrote 10 ACs (user approved "go ahead"); `ceremony-barge-tier1.e2e.mjs`
  rewritten to prove all three of the user's complaints. GHA run **30644546674 = 11 passed / 0 failed**:
  transcript sentence text visible before barge ("longest 31 chars"), audio `pause()` fired within
  500ms of the barge (`pauses 0→1`), Tess answered the barge specifically ("Seven times eleven is
  seventy-seven."), and "Passing your message" never appeared. Screenshots 00–06 on branch
  `ceremony-barge-screenshots`. **Still needs the user to confirm live in their own browser.**
- **[IMPLEMENTED — deployed to `main`, mechanism UAT PASS 8/9, content BLOCKED on OpenAI quota, NOT
  user-confirmed]** "Option 1 + interrupted marker" for the immediate barge answer (commit `0d5ca1e`).
  Root cause found first (user was right): a prior commit `5b89cfe` PROMISED mid-utterance barge but
  only shipped the audio-stop half — the ANSWER still went through the server `handleBarges` which is
  explicitly "between speakers, never mid-speaker" (`huddle.functions.ts:3417`), and the client resume
  waited for that between-speakers reply. Fix decouples the barge answer from the server queue:
  `useCeremonyVoice.bargeFreeze()` (stop audio + keep freezeRef + keep mic), render the user's message
  immediately (voice path too — it never did before), fetch ONE answer via a scoped 1:1
  `sendHuddleMessage(targetAgentId)` (scope MUST be one-to-one — `routeMessage:86` ignores targetAgentId
  under "group"), speak it via `speakInterjection` (doesn't clobber freezeRef), mark the cut row
  `[interrupted]`, then `resumeFromFreeze`; `emit()` parks via `bargeActiveRef` so no scripted speaker
  slips in; freeze-time watchdog unparks if STT yields nothing. New testids on TranscriptRow. Independent
  AC subagent wrote 12 ACs. GHA run **30648927649 = 8 passed / 1 failed**: AC-1 visible user barge row ✔,
  AC-3 speaker cut ≤500ms (pause fired) ✔, AC-5 `[interrupted]` marker (count=1) ✔, AC-6 the answer row
  (kind="answer", Terry) appeared BEFORE any scripted speaker ✔, no "queue politely"/"Passing your
  message" ✔. **The 1 failure is AC-8 (answer contains "77") ONLY because the app's OpenAI account is
  out of quota — every agent (barge answer AND all scripted speakers) returned "(couldn't respond —
  OpenAI is out of API quota)".** That is an environment blocker, NOT a code defect (per CLAUDE.md
  "fail fast on quota — don't interpret results until restored"). Screenshots 01–04 on branch
  `ceremony-barge-screenshots` (02-barged shows the visible message + `[interrupted]` marker + corrected
  hint copy).
  **[2026-07-31 UPDATE — user topped up OpenAI; RE-RAN with live agents → run 30650682960 (post-hardening)
  = ALL PASS.** Real content: `AC-8: answer — "Terry: Seven times eleven is seventy-seven."` and `AC-6:
  barge-answer row BEFORE any scripted speaker`. Full behavior proven end-to-end with live agents (visible
  message + mid-sentence cut + `[interrupted]` + immediate on-topic answer BEFORE the round-robin + resume).
  Screenshot 03-answered shows it in one frame. Hardening (commit `a7f42c1`, from the independent verifier's
  review): AC-6 ordering decoupled from AC-8 content in the test; barge-answer `sendHuddleMessage` raced
  against a 30s timeout so a stalled fetch can't leave `emit()` parked. Deployed to `main`, tsc+vite clean.
  **STILL per org rule NOT writing "fixed" — awaiting the USER's own live browser confirmation.** Option 3
  (true broken-WORD transcript text) remains the agreed pivot if the sentence-seam cut isn't crisp enough
  live.**
- **[IMPLEMENTED — deployed to `main`, independent verifier PASS 8/10 + PARTIAL 2/10 (browser-click-only,
  code trace unambiguous), NOT yet user-confirmed live]** Problem #1 — the two-tab **Transcript** + **Chat**
  meeting-pane UI. `MeetingRoom`'s existing live-transcript panel now has a `role="tablist"` Transcript/Chat
  tab bar (`chatTab` state, default `"transcript"`); the Chat tab's compose box is gated on `chatTab==="chat"`
  (independent of the room-control `panel` state) and — for 1:1 — sends through a NEW
  `useVoiceCallRealtime.sendText(agentId, text, opts?)`, which calls the same internal `runTurn` (same
  `enqueueHuddleTurn` payload shape) that 1:1 voice already uses. This is also the direct mechanism for
  ACT-huddle-6 ("same brain"): 1:1 chat and 1:1 voice now provably share one send path into the OpenAI turn
  engine — the two were NOT unified before this. Ceremony/group `sendMessage` branch is byte-identical
  (confirmed via diff-hunk boundary check against `routeTurn`/`runBargeSequence`/`runCeremony`, all
  untouched). ElevenLabs backend (`VOICE_1ON1_BACKEND !== "openai"`) disables the Chat tab's compose box
  with a real message (`composeAllowed`/`composeDisabledReason`) instead of crashing. Commit `f11a289`
  (merged with upstream `b3467b4` as `d83c254`), deployed via `deploy-swa.yml`. `tsc --noEmit` clean,
  `bun run build` succeeded, `eslint` shows only pre-existing noise (confirmed no new warnings by diff-hunk
  line-range check). Independent verifier found 0 FAIL; the 2 PARTIAL items (tab click, room-control button
  click) are pure UI-interaction claims the verifier couldn't click a real browser to confirm — code-level
  trace is deterministic/unambiguous. **STILL per org rule NOT writing "fixed"** — needs the user's own live
  browser confirmation, and per the user's explicit plan, using the new Chat tab to impersonate them via text
  and directly compare 1:1 chat vs 1:1 voice answers is the next step once they confirm the tab renders.
  Also open: pivot to Option 3 (true broken-WORD text) if the sentence-granularity cut isn't crisp enough live.

### ACT-huddle-3: Standup ceremony hang — root cause is HTTP 500s on enqueueHuddleTurn/getTurnUpdates
**Requested:** 2026-07-30 — "use the new uat skill to finally experience what i am experiencing with
the standup." User has repeatedly complained about a multi-minute standup-ceremony hang; a prior
session's `sinceMs` fix (see memory.md) addressed a DIFFERENT bug (a silent client-side poll-window
cutoff) but was never confirmed live.
**What was done:** built and dispatched the first-ever real browser-driven UAT of the actual
Meeting → Daily stand-up → Start click flow against production, via the new generalized
`run-uat.mjs` + `huddle-checks.mjs` (`gha-playwright-uat` skill). Iterated through several harness
bugs (see memory.md Hardening) to get trustworthy evidence.
**Found (real evidence, workflow run 30587309137, commit 78182f7):** the flow opens fine, but after
clicking Start, **zero new transcript turns render for 150+ seconds**, and the browser network log
shows **two HTTP 500s**: `enqueueHuddleTurn` (the fn Start calls) and `getTurnUpdates` (the client's
poll fn) — both throwing server-side. Ruled out the known DB-discovery-drift issue (deploy log
confirmed `Assembled AZURE_PG_URL for eds-postgresql/RAG_AI_Agents`).
**CORRECTED 2026-07-30 (was wrong above):** the "~45s hosting ceiling, plan not built" hypothesis was
WRONG — `docs/plan-incremental-turn-streaming.md` is **already implemented**, not just designed:
`CHUNK_BUDGET_MS = 30_000`, a persisted `progress` column (`remainingQueue`), and a resumable driver
loop with `chunkBudgetHit()` checks already exist in `huddle.functions.ts` (confirmed by direct grep,
not the stale CLAUDE.md backlog note calling it "NEXT"). That mechanism exists specifically to avoid
raw request-timeout 500s. **New, narrower leading hypothesis:** `enqueueHuddleTurn`'s handler
(`huddle.functions.ts:3999-4001`) calls `executeClaimedTurn(claimed)` with **no try/catch** — an
uncaught exception there bypasses the chunking safety net entirely and returns an opaque 500. Same
gap in `getTurnUpdates` around `getTurnsSince`. This is a real bug (something is throwing), not a
timeout — but the actual thrown error is still unknown; `createServerFn` masks handler exceptions to
a generic 500 client-side, and this session has no Azure Function App / Application Insights log
access.
**ACs (independent subagent, cold-read of the code):**
- AC-1: Given an error thrown inside `executeClaimedTurn`'s own catch path (e.g. `failTurn` itself
  throws), when `enqueueHuddleTurn` runs, then the handler returns a structured response (not a raw
  500) whose body includes the real thrown error's message.
- AC-2: Given `enqueueTurn`/`claimTurn`/`getTurn` (calls outside `executeClaimedTurn`) throw, when
  `enqueueHuddleTurn` runs, then the same structured-error handling applies — no unguarded call site.
- AC-3: Given `getTurnsSince` throws inside `getTurnUpdates`, then it returns a structured error
  instead of an opaque 500.
- AC-4: Given any of the above, then the real error message/stack is logged server-side
  (`console.error`), visible in the App Service log stream independent of the client response.
- AC-5: Given no error occurs (happy/partial/queued paths), then the returned shape is byte-for-byte
  unchanged from current behavior — zero behavioral change on success.
- AC-6: Given the fix is live, when a real ceremony 500 next occurs in production, then the network
  log shows a non-500 or a 500 whose body carries the real error — verified live, not inferred.
- AC-7: No newly-added `catch {}` silently swallows — every catch logs or returns the error.
- AC-8: The existing chunking/resumable mechanism (`CHUNK_BUDGET_MS`, `progress`, `remainingQueue`)
  is untouched — this is diagnostic visibility only, not new chunking behavior.
**Status:** CLOSED (the visibility fix) 2026-07-31 — implemented (commit `f8d07bb`), deployed
(run 30592726001, success), and independently verified live by a cold `verifier` subagent:
- AC-1/2/3/6: PASS — verifier found a genuine way to trigger a real backend exception (a huddleId
  with an embedded NUL byte, which Postgres rejects as invalid UTF8) against LIVE production, and
  confirmed both `enqueueHuddleTurn` and `getTurnUpdates` now return HTTP 200 with the real Postgres
  error message in the body, instead of an opaque 500.
- AC-4/7: PASS — diff-confirmed both new catches call `console.error` with the real `err` object
  before returning; no swallowed catch.
- AC-5/8: PASS — diff-confirmed the three success-path `return` statements and the `getTurns`
  mapping are byte-identical to before (only re-indented); `CHUNK_BUDGET_MS`/`progress`/
  `remainingQueue` don't appear anywhere in the diff. Live-confirmed via a real 7-agent turn on
  production completing normally (`done`, all 7 agents replied, no drops).
**Important scope note — this closes the VISIBILITY gap, not the underlying standup-hang complaint.**
We now have a mechanism to see the real error the next time a ceremony 500s in production, instead
of an opaque failure. The original user-reported hang is still open until a real occurrence is
captured with this fix live and root-caused from the actual message it now returns.
**Evidence:** workflow runs 30587309137 (original repro), 30592726001 (this fix's deploy); verifier
subagent's live NUL-byte test and live 7-agent turn against https://icy-flower-0f415200f.7.azurestaticapps.net.

### ACT-huddle-4: Ceremony barge-in reliability — silent self-kick failure can strand a barge for ~60s
**Requested:** 2026-07-30, following ACT-huddle-3 — user asked why a barged mid-ceremony message
sometimes gets answered "overtop" the running script after a large delay, and pushed back that
"agents hearing each other" (the cross-talk fix under ACT-huddle-5) doesn't explain that on its own.
**Found:** `bargeCeremony` (`huddle.functions.ts:3572-3581`) queues the barge then fires
`kickNextChunk` fire-and-forget. `kickNextChunk` (3609-3626) wraps its self-POST in
`try {} catch { /* cron drain backstops within a minute */ }` with **zero logging on failure** — if
the same backend instability causing the ACT-huddle-3 500s also breaks this self-kick, the barge
silently rides the once-a-minute pg_cron backstop instead of being answered promptly. Not yet proven
this is happening (no failure logging exists to check), but it's a real, concrete gap independent of
cross-talk.
**ACs (independent subagent, cold-read of the code):**
- AC-1: Barge-to-reply latency (successful kick) is measured end-to-end and materially faster than
  the 60s cron backstop, with the current unretried baseline documented for comparison.
- AC-2: A failed `kickNextChunk` fetch (throw or non-2xx) is logged server-side, distinguishable from
  a successful kick — replacing today's empty `catch {}`.
- AC-3: A failed self-kick retries a bounded number of times with backoff before deferring to cron,
  rather than deferring on the very first failure.
- AC-4: Missing `JOURNEY_PROXY_TOKEN`/`HUDDLE_APP_URL` (permanent misconfig, retrying can't help) is
  logged distinctly from a transient fetch failure.
- AC-5: Even with zero successful kicks, the cron backstop still eventually delivers the barge reply
  — never permanently lost (regression guard on `claimBarge`'s row-locked FIFO).
- AC-6: `appendBarge` called twice with the same barge id is idempotent — queued/answered once.
- AC-7: Barging a turn that's already `done`/`error` returns `queued:false`; the client falls back to
  a normal message rather than losing the text (regression guard on `MeetingBar.tsx:246-250`).
- AC-8: A barge is only answered between speakers via `handleBarges()`, never mid-response.
- AC-9: Multiple queued barges are answered FIFO; unspoken round-robin slots are preserved.
- AC-10: A barge still queued when `CHUNK_BUDGET_MS` is hit survives the chunk boundary — drained by
  the next chunk/resume, never dropped.
**Status:** CLOSED 2026-07-31 — implemented (commit `94cfc02`), deployed (run 30594156826, success),
independently verified live by a cold `verifier` subagent:
- AC-2/3/4: PASS at the code level — diff confirms `KICK_MAX_ATTEMPTS=3`, backoff `[250,750]ms`,
  distinct `console.error` lines for non-2xx / thrown-fetch / missing-config, and the misconfig
  branch returns before ever attempting a fetch. **Live `console.error` OUTPUT in Azure logs remains
  UNVERIFIED** — this session has no Azure Function App log-stream access, only code-level
  confirmation that the calls are correctly wired.
- AC-5/6/7/8/9/10 (regression guards): PASS — `git diff 94cfc02^ 94cfc02` touches only `kickNextChunk`
  (one hunk); `appendBarge`/`claimBarge`/`handleBarges`/`CHUNK_BUDGET_MS` are byte-identical. Live
  end-to-end confirmation via `ceremony-barge-test.mjs` against production: full 12-reply ceremony
  completed, barge answered between speakers (not mid-reply), barge idempotency confirmed (2nd
  identical send deduped), no dropped participants, no cross-huddle spill.
- AC-1 (latency baseline) was descriptive/measurement scope, not separately re-run this session —
  the live barge test's overall pass covers functional correctness, not a quantified before/after
  latency comparison.
**Evidence:** workflow run https://github.com/deventerpriseds-org/huddle-extension-app/actions/runs/30594156826;
verifier's live run of `.claude/skills/test-agent-serverfn/scripts/ceremony-barge-test.mjs` against
https://icy-flower-0f415200f.7.azurestaticapps.net (BARGE-IN: PASS, all sub-checks AC-6..AC-10 PASS).
**Open follow-up (not blocking closure):** confirm the new `console.error` lines actually appear in
Azure Function App logs the next time a self-kick genuinely fails in production — needs log access
this session didn't have.

### ACT-huddle-5: Ceremony conversational realism — cross-talk relaxation + caption-style reveal
**Requested:** 2026-07-30. User's core complaint, in their own words: it's "scripted with recordings
being read... not a natural group conversation at all," and proposed validating incrementally
(2-agent barge/return-to-checklist first, then 3 agents with real Q&A) before scaling to the full
15-agent roster. User explicitly asked NOT to have their suggestion rubber-stamped — wanted an
independent read of the actual architecture first.
**Found (independent Explore-agent investigation, cold-read):**
1. Ceremony turns are genuinely LLM-generated per agent via the OpenAI Responses API with full tool
   access (not templated/precomputed text) — grounded in real DB task data via a data-driven
   checklist (`buildCeremonyReport`), with the LLM told to phrase it naturally. The Responses-API +
   checklist architecture the user proposed is **already what's built** — not a gap.
2. **The actual gap:** ceremony participants are deliberately denied visibility into what other
   agents in the same run just said. The cross-talk block that exists for normal group turns
   (`buildPrior()`) is explicitly gated off whenever a ceremony directive is active
   (`priorInThisTurn && !ceremonyDirective`, `huddle.functions.ts:1250`), each directive says "do NOT
   comment on other lanes," and the @mention re-queue is hard-disabled during ceremonies
   (`ceremonyActive ? [] : parseMentions(...)`, `huddle.functions.ts:3255`). This is the concrete,
   surgical fix target — not a rebuild.
3. **Caption-style reveal (separate, additive UX finding):** in `emit()` (`MeetingBar.tsx:380-406`),
   the full turn text is pushed to the transcript BEFORE the TTS audio is even synthesized/played —
   confirmed by reading the code, not inferred. That's why it reads as "a script is already on
   screen, then a recording plays it." Fix: reveal text progressively, timed to the audio element's
   `timeupdate`/`duration`, not the full string up front.
**ACs for the caption-reveal piece (independent subagent, cold-read of the code):**
- AC-1: Text reveals progressively once audio starts, paced against `timeupdate`/`duration`.
- AC-2: On `onended`, 100% of the turn's text is visible — no trailing unrevealed text.
- AC-3: Revealed portion is monotonically non-decreasing — never flickers/hides shown text.
- AC-4: When `voiceOff` (TTS already failed this ceremony), full text renders immediately — no
  dependency on a nonexistent audio element, preserving the existing text-only fallback.
- AC-5: On `onerror` or ceremony teardown mid-turn, the transcript still ends up showing full text —
  never permanently truncated.
- AC-6: Across a 5+ turn ceremony, no cumulative desync — each turn's reveal timer is scoped to that
  turn's own audio duration, not a shared clock.
- AC-7: If `duration` is unavailable/NaN/Infinity, reveal degrades gracefully to full text immediately
  rather than hanging.
- AC-8: Assistive-tech consideration — DOM/ARIA strategy avoids announcing every incremental
  fragment (live-region gated to completion, or full text present in the a11y tree throughout).
- AC-9: When `showCaptions` is false, no error and no unnecessary work against a hidden element.
- AC-10: Reveal timing measured against actual audio playback stays within a stated tolerance
  (e.g. ≤300ms average offset) — not just "looks fine."
**Cross-talk relaxation ACs:** not yet written — needs its own staged plan doc first (see below) since
it's a genuine behavior change to how every ceremony sounds, not a pure bug fix.
**Status:** open. Plan doc `docs/plan-ceremony-conversational-realism.md` covers the staged
2-agent → 3-agent validation approach for the cross-talk relaxation specifically. Nothing implemented
yet — sign-off needed before touching any ceremony directive/prompt.

### ACT-huddle-5 partial / WebRTC voice pipeline — 2026-07-31, branch claude/setup-stop-hooks-skills-0h569y
**Implemented by this session (21 ACs, user "go" sign-off):** Replace the push-to-talk voice loop
(`useGroupVoice`: MediaRecorder→Whisper→TTS, 350ms rAF barge detection) with OpenAI Realtime WebRTC
for VAD/STT/barge-in detection + EL TTS per-sentence for audio output.
**Files created:**
- `src/features/huddle/lib/voice/realtime.functions.ts` — server fn minting ephemeral key via `POST /v1/realtime/sessions` (OPENAI_API_KEY stays server-side).
- `src/features/huddle/hooks/useGroupVoiceRealtime.ts` — new hook: AudioQueue class (base64 MP3, onStart trailing transcript), WebRTC RTCPeerConnection + oai-events DC, `input_audio_buffer.speech_started` ≤200ms barge detection, same-agent resume from interrupted sentence, generation counter for orphaned-op prevention.
- `e2e/voice-realtime-pipeline.e2e.mjs` — Phase 1 Playwright test (7/7 PASS against dev server).
**MeetingBar.tsx:** 2-line swap (import + `useGroupVoiceRealtime()`). `useVoiceCall.ts`: unchanged (AC-15 ✓). TypeScript: clean (0 errors).
**Verifier:** 19/19 PASS (independent cold-read subagent). Commits: `02981b6` + `cb98120` on branch.
**Status:** NOT YET MERGED TO MAIN / NOT YET DEPLOYED. Mid-merge (conflict in actions.md resolved, merge commit pending). NOTE: concurrent session closed "ACT-huddle-4" for kickNextChunk retry (`94cfc02`) — that is a DIFFERENT, complementary fix. Both belong in main.

### ACT-huddle-2: Agent avatar images 404 (Lovable-preview-only asset paths)
**Requested:** 2026-07-29
**Asked for:** fix the broken avatar photos across the app — every agent falls back to colored
initials because the real images can't load.
**Root cause (confirmed):** all 14 agent avatars were wired in `src/features/huddle/data/agents.ts`
via `src/assets/agents/*.png.asset.json` pointer files, whose `url` field is a Lovable-platform-
internal preview path (`/__l5e/assets-v1/...`) — only servable by Lovable's own hosting, never by
this app's actual Azure Static Web App deployment.
**Resolved 2026-07-30:** user provided the real 14 avatar images (zip upload). Resized/optimized
(1024×1024 PNG → 256×256 JPEG q85, ~21MB → ~0.18MB total), committed to `public/agents/*.jpg`,
`agents.ts` repointed at the local paths, old `.asset.json`/`src/assets/agents/` removed, stale
comment in `AgentAvatar.tsx` updated. Commit `0f88d6a`, deployed (workflow run 30585250169,
success), and **live-verified via the browser UAT harness** (workflow run 30587309137):
`✅ No avatar image 404s (ACT-huddle-2 regression guard) — all avatar images loaded`. A permanent
regression check (`avatarImage404s` in `huddle-checks.mjs`) now guards against this recurring.
**Status:** closed.

### ACT-huddle-1: Desktop layout bugs — sidebar/menu missing, meeting view, mic barge-in, standup gap
**Requested:** 2026-07-29
**Asked for:** user reported 4 live bugs on production (https://icy-flower-0f415200f.7.azurestaticapps.net):
(1) left sidebar/menu missing on desktop, meeting view not "snapping to place"; (2) mic says "in use by
Microsoft Edge", can't barge in; (3) ~30s gap after clicking Start on a standup ceremony; (4) asked whether
prior fix commits for these were pushed or orphaned.
**Found:** fix commits (`c04d070`, `d6661e6` + 2 more rounds) existed on branch `act5-autonomy`, sitting in
an already-OPEN, never-merged PR #15 — pushed, not orphaned, just never merged. Merged (`7cc5af9`),
manually triggered `deploy-swa.yml` on `main` (workflow_dispatch only — confirmed run completed/success).
**Status:** open — PARTIALLY resolved, one direct contradiction not yet explained:
- (1) desktop breakpoint/sidebar: **CONFIRMED FIXED LIVE by the user** (hard-refreshed production after
  merge `16fedb4` + deploy, Grammarly still active, sidebar renders correctly). CLOSED.
  [Prior text below retained for the investigation record.]
  ~~ROOT CAUSE IDENTIFIED, FIX IMPLEMENTED — NOT YET CONFIRMED LIVE.~~
  (Corrected 2026-07-29: an earlier version of this entry said "found and fixed" before the fix had been
  merged, deployed, or seen by the user — caught by the user, not self-caught. Downgrading the claim.)
  After retracting a premature "verified"
  claim (based on `vite dev`, not representative of the deployed Nitro build) and ruling out CSS
  range-syntax incompatibility (both `matchMedia` forms returned `true` in the user's very current Edge),
  the user's own DevTools Styles panel revealed the real cause directly: a third-party browser extension
  (`data-gr-ext-installed` on `<body>` — Grammarly's fingerprint) injects a global, non-namespaced
  `.hidden{display:none!important}` rule that collides with Tailwind's own generic `.hidden` utility
  class and beats it regardless of the (independently confirmed correct) media-query/cascade order.
  **Fix:** renamed every real `hidden`/`md:hidden` Tailwind usage (27 sites, 7 files) to a namespaced
  `app-hidden`/`md:app-hidden` custom utility (`@utility app-hidden` in `src/styles.css`) so no
  extension using the common word "hidden" can collide with it again — hardens against ANY such
  extension, not just Grammarly. Independently verified (AC-writing + verifier subagents, both separate
  from the implementing session): `tsc` clean, compiled CSS correct (unrelated `overflow-hidden` utility
  untouched), and a non-vacuous live proof — injecting the exact rogue rule via Playwright leaves the
  renamed sidebar/rail at `display:flex` while a control element still using the old bare class correctly
  breaks under the same injection. One PARTIAL: MeetingBar/BoardView-specific DOM paths couldn't be
  reached live in this sandbox (no Azure PG/voice backend access) — the mechanism is proven generically,
  not each specific component's live render.
- (2) mic / barge-in: CONFIRMED WORKING — user tested, mic works, barge-in stops audio. The original
  "in use by Microsoft Edge" wording was misleading; the real bug was the useEffect dep (`[groupVoice]`
  new object every render → stop() called on every state change). Fixed in commit `95708f6`, PR #19 merged.
  **Follow-on bug (standup ceremony voice chaos):** barge-in during a running ceremony sent a second
  `sendHuddleMessage(scope:group)` turn ON TOP of the ceremony's durable turn — both streams raced,
  producing overlapping, context-free agent replies mid-ceremony. `f618a04` attempted this fix but caused
  a 60s ceremony-start hang (root cause undiagnosed; reverted as `b927f72`). Re-implemented correctly
  as commit `864ea0e` this session (2026-07-29): `routeTurn` stable useCallback([]) reads live state via
  refs (`isCeremonyRef`/`ceremonyStatusRef`/`activeCeremonyTurnRef`), passed as `routeMessage` to
  groupVoice.start(); both typed and voice paths call it before sendHuddleMessage.
  **GHA live end-to-end barge-in test: 6/6 PASS (run 30555399322, `verify-ceremony-barge.yml`)**:
  AC-6 interjection answered ✓, AC-7a Terry opens ✓, AC-7b relay resumed + Terry closes ✓,
  AC-8 no participant dropped (count floor, not cross-run set) ✓, AC-9 barge idempotent ✓, AC-10 no 1:1 spill ✓.
  NOT YET CONFIRMED LIVE by user in their own session — please hard-refresh production and run a standup ceremony to confirm.
- (3) standup-start gap (93s hang): **ROOT CAUSE FOUND AND FIX DEPLOYED — NOT YET CONFIRMED LIVE by user.**
  Diagnosed 2026-07-30 as a pre-existing `getTurnsSince` LIMIT 20 cutoff bug — unrelated to the barge-in
  work. `ORDER BY updated_at ASC LIMIT 20` with `sinceMs:0` (epoch) returned the 20 OLDEST of 24 ceremony
  turns; the newest running turn was at position 21+, cut off by LIMIT. The poll (150×~700ms ≈ 105s)
  never found the active turn. Server was correct — DB confirmed turn `status=done`, 11 replies, 75s
  runtime. Fix: `pollSinceMs = stepStart - 5_000` before the poll loop; `sinceMs: 0` → `sinceMs: pollSinceMs`
  in the `getTurnUpdates` call (MeetingBar.tsx lines 433+446). Commit `dd5435e` on main, deploy run
  30544492729 conclusion=success. Independent verifier: AC-1/3/4/5 PASS statically; AC-2 (10s SLA)
  mechanism-only — live timing unconfirmed.
  **Next step: please hard-refresh production and click Start on a standup — replies should appear within
  10-15 seconds. That confirms the fix and closes this sub-item.**
- (4) button styling: fixed by PR #15, not independently re-verified but low-risk/cosmetic.
- **New bug found (not in original report):** independent `verifier` subagent found the "Meeting"
  dropdown button is physically overlapped by the ContextPanel's "Queue" tab at 768–850px specifically
  (click-intercepted, confirmed via Playwright error + bounding-box overlap), while ≥900px is clean.
  Untriaged, not fixed.
- (1b) meeting-view "not snapping to place" (the other half of the original (1) complaint, separate
  from the sidebar bug and NOT fixed by PR #15 or the Grammarly hardening): **root cause found, fix
  implemented, MECHANISM independently verified — NOT YET CONFIRMED LIVE by the user.** User confirmed
  via console (`window.innerWidth=1048`) this happens in BOTH Edge and Chrome — ruling out the
  Grammarly/extension explanation, since that was Edge-specific. Reproduced locally with Playwright at
  the user's exact 1048px width and measured the real bounding boxes: `MeetingBar.tsx`'s "stage" column
  div (`flex min-h-0 flex-col md:flex-1`) was missing `min-w-0` — the classic flexbox trap where a flex
  item won't shrink below its content's intrinsic width. The participant chip strip (up to 15 agents,
  `overflow-x-auto`) forced the stage column to ~2216px wide in a 1048px viewport, pushing the sibling
  `<aside>` (transcript/people panel, `md:w-[360px]`) entirely off-screen and shoving the centered avatar
  to the edge of the mostly-invisible column — an exact match for the user's screenshots (avatar clipped,
  no visible transcript panel). **Fix:** added `min-w-0` to that one div (one line). Independent
  `verifier` subagent re-derived everything from scratch: reproduced the BEFORE state itself (measured
  stage column at 2216px, aside at x=2216/off-screen), restored the fix and re-measured (stage column
  688px = 1048−360, aside fully on-screen at x=688, avatar centered at x=344 = exactly half the stage
  column), confirmed no regression in the mobile stacked layout at 500px, confirmed `tsc` clean — 7/7
  PASS. Per the standing rule from earlier in this session: NOT calling this "fixed" until merged,
  deployed, and the user has confirmed it live in their own browser.
**Evidence:** PR #15 (github.com/deventerpriseds-org/huddle-extension-app/pull/15), merge commit `7cc5af9`,
deploy run `30471382381` (conclusion success), verifier subagent report (git ancestry + deploy timestamp
+ independent Playwright repro), this session's own Playwright screenshots at real resolutions (not
committed — scratch files, removed after use).
**Next step:** waiting on user's hard-refresh + console-error report to resolve the live-vs-local
discrepancy on (1); (2) and (3) need dedicated follow-on investigation (not started).

_(ACT-1 moved to Closed 2026-07-24 — see below.)_

### ACT-2: Enforce mandatory skills (AC / verify / track / remember / verifier)
**Status:** done, ACTIVATED AND VERIFIED LIVE (2026-07-29) — the `claude/setup-stop-hooks-skills-0h569y`
branch (never previously merged) was fast-forward-merged into `eds-claude-skills` main, then `setup.sh`
was run in this session. **Evidence (read back, not just the script's own echo):**
`launcher-settings.json` shows `SessionStart -> _eds_version: 3` and `Stop -> _eds_version: 3`;
`/root/.claude/skills/` now has 12 files (added `bootstrap`, `remember`, `track-actions`, `uat`,
`uat-auth-bypass`, `design-library-uat`, `sync-setup-script` — none of these were present before);
`/root/.claude/agents/verifier.md` registered (Agent tool now exposes `subagent_type: "verifier"`).
This is a session-level (`/root/.claude/` home-dir) install, not repo-scoped — it's already active for
all work in this session across journey-voice and huddle-extension-app, not just eds-claude-skills.

### ACT-3: create_huddle_task cross-turn dedup (board-clutter prevention)
**Status:** open — deployed (PR #5) but **UNVERIFIED** (no verifier run yet).

_(ACT-4 moved to Closed 2026-07-25 — see below.)_

### ACT-5 (NEW): Agent autonomy — message-driven remote team
**Asked for:** agents do their assigned board work autonomously and communicate like a real remote team
(escalate blockers/decisions now, batch results to standup, right channel per urgency). Full vision +
locked policy (green/yellow/red autonomy, channel triage, email use-cases) + ACs in
**`docs/act5-autonomy-plan.md`**. Branch `act5-autonomy`.
**Gate 1 (research) — DONE, verified live + independent verifier (genuinely agent-driven).**
- `create_artifact` agent tool (both dispatch paths) + `autowork.server.ts` enqueues a real durable turn
  per assigned agent; the agent's OWN LLM plans, calls `tavily_web_search`, synthesizes, saves via
  `create_artifact`, replies in `dm-<agent>` (rides send_push). Rides the ACT-4 scheduler (`auto-work`
  job, 9/13/17 ET) + `run-autowork` route (reuses JOURNEY_PROXY_TOKEN, no new secret).
- **Live proof:** 4 agent turns `done`, finn-reid `called_web_search=t called_create_artifact=t`,
  agent-authored filenames, substantive lane-voice replies; 6 earlier SHORTCUT dumps deleted.
- **The shortcut lesson (memory.md 2026-07-26):** the FIRST build faked it (direct Tavily on the title,
  agent's name stamped on it) — rebuilt to be genuinely agent-driven. Never fake "an agent does X".
**Still open (increment 2 + later gates):** the communication-triage layer (urgency→channel: phone via
journey notification-delivery / push / chat / standup / email, per-task "notify me now" override);
broaden beyond research (finance/family drafts, then real deck/doc/sheet artifacts); roadmap+memory for
long projects; per-agent opt-in flag + spend caps. Plus the ACT-4 residuals (blocked-tag mirror
propagation is journey-side; verify).

### ACT-6 (NEW): Agile ceremonies actually fire + standup summaries delivered
**Asked for:** "I haven't received standup summaries or any of the things previously discussed to ensure
the agile leaders are aware of the ceremonies that need to take place and carrying them out."
Scrum master / team lead should track which ceremonies are due (standup, review, retro), run them, and
deliver the summary to the user.
**Status:** open — needs AC definition + design; ceremony infra exists (ceremonies.ts, run-ceremony) —
verify why summaries aren't reaching the user.

## Closed

### ACT-huddle-3: 1:1 capability handoff — intent-semantic false positive (Iris "Mark that done" → Terry)
**Closed 2026-07-30.** Root cause was LLM-level: Iris's prior reply mentioning "backlog grooming" caused the
model to apply `capabilityHandoffBlock`'s 1:1 deferral rule to the user's subsequent "Mark that done" — reading
across turns rather than scoping to the current message. Code-level check (`capabilityOwnerFor("mark that done")`)
was always null and correct; failure was purely in prompt interpretation.
**Fix (systematic, data-driven):**
- `capabilities.ts`: `classifyTurnIntent(text):TurnIntent` — trait-driven, zero per-capability config.
  Returns `"perform"|"status"|"query"|"acknowledge"|"inform"`. Conservative (defaults "perform" when uncertain).
- `huddle.functions.ts`: `TURN_INTENT_CLASSIFICATION = true` flag (instant rollback). `turnIntent` computed
  once per turn, gates both the `laneDirective` injection AND the `capabilityOwnerFor`/`laneOwnerFor`
  back-channel — both no-op when `turnIntent !== "perform"`. Group turns unaffected (`scope !== "group"` guard).
  `capabilityHandoffBlock` 1:1 rule gets IMPORTANT qualifier as secondary prose layer.
**Acceptance criteria:** 15 (define-acceptance-criteria subagent ran). Independent verifier: 14/15 PASS statically;
AC-12 (live LLM turn: Iris doesn't defer on "Mark that done") requires user to test in the deployed app.
**Evidence:** PR #20 (`claude/iris-huddle-interaction-baj51c` → main), commits 3b740bc + 7c64e52,
deploy run 30564150593 (conclusion: success). Verifier subagent 14/15 PASS.
**Pending user confirmation:** type "Mark that done" in dm-iris-chase → confirm Iris acknowledges/confirms
without deferring to Terry. That closes AC-12 and completes this ACT.

### ACT-4: Auto backlog grooming + assignment on a cadence
**Closed 2026-07-25.** Terry grooms/triages/assigns the backlog on a cadence (6×/day at 4/8/12/2/6/10 ET),
only when the backlog actually changed, and surfaces a proactive summary + push. Built ENTIRELY in the
Huddle app + Azure Huddle PG (no supabase change): a general recurring-job scheduler (`tasks.scheduled_jobs`
+ `runDueScheduledJobs`) driven by the existing every-minute run-turn heartbeat. Adding a future recurring
job = one row + one `fireJob` case (ceremonies/digests next).
**Acceptance criteria (independent verifier over live evidence):**
- AC-1: grooms + writes assignments back to journey. — **PASS** (force-run `groomed:15`; mirror shows 27/49
  open tasks now carry `assigned_agent` + priorities — writeback flowed journey→sync→mirror).
- AC-2: Terry-owned. — **PASS** (runScheduledGrooming attributes to Terry; non-owner grooming already
  blocked, ACT-1).
- AC-3: proactive summary in `dm-terry-locke` naming what was done + top priorities. — **PASS** (observed
  Terry turn, status done).
- AC-4: completion fires send_push. — **PASS by composition** (same executeClaimedTurn→send_push path proven
  in ACT-1; a device push not separately captured here).
- AC-5: route is server-to-server, rejects wrong/missing secret. — **PASS** (401 on bad + missing; 200 with
  the real JOURNEY_PROXY_TOKEN).
- AC-6: change-gate skips an unchanged backlog; force bypasses. — **PASS** (offline signature ALL PASS;
  live force:false → `skipped:true reason:unchanged`; force:true → groomed).
- AC-7: cadence wired, DST-correct, no manual step. — **PASS on registration** (heartbeat auto-registered
  `groom-<user>` with `next_run_at=04:00 ET` next slot + cadence `[4,8,12,14,18,22]`; `computeNextRun`
  DST-correct offline EDT+EST). Natural slot fire is by composition (same tick that drains turns/reminders).
**Evidence:** commits on `fix-1to1-capability-defer` (merged in PR #6: e003214 route+gate, e9918bd manual
trigger, 9d888e0 scheduler); live runs — force groom HTTP200 groomed:15, non-force skip, mirror writeback
read, scheduled_jobs auto-registration.
**Residuals (follow-ups, cluster with ACT-5 "blocked surfacing + coverage"):** (1) Terry's summary omitted
the 11 blocked-on-capability items the directive asked it to flag; (2) `blocked-on-capability` tag not
present in the mirror (0) despite the run reporting blocked:11 — blocked-tag propagation to verify; (3)
groom limit is 15 tasks/pass, and with skip-on-unchanged a static 49-task backlog leaves tasks 16-49
un-groomed until it changes — raise the limit or rotate batches; (4) AC-4 device push not separately
captured.

### ACT-1: 1:1 ownership hand-off — natural defer + proactive owner follow-up
**Closed 2026-07-24.** In a 1:1, when the ask belongs to another agent (exclusive tool OR domain/theme),
the addressed agent defers by NAME (no @ — group-only), and the runtime brings the owner in via a
deterministic back-channel: the owner posts a REAL durable turn in their own DM (`dm-<owner>`) — which
rides the existing send_push away-notification — acknowledging who passed it and asking to confirm first.
**Acceptance criteria (all PASS — independent verifier over live turns on the deployed SWA):**
- AC-1: 1:1 grooming ask → Iris defers to Terry by name, no grooming performed. — **PASS**.
- AC-2: 1:1 budget ask → Iris defers to Finn by name. — **PASS**.
- AC-3: In-lane ask → Finn answers self, no handoff. — **PASS**.
- AC-4: OWNER proactively messages in their OWN DM, names who passed it + context, natural
  "passed/mentioned by X" phrasing, asks to confirm before acting. Observed in dm-terry-locke +
  dm-finn-reid. — **PASS**.
- AC-5: Defer reads naturally, NO @handle in the 1:1. — **PASS**.
- AC-6 (regression guard): non-owner leaves NO meta-task card even if the tool is attempted
  (`capabilityOwnerFor(title)` code guard). RE-TEST: attempted, `tasks:[]`. — **PASS**.
**Evidence:** commits 2b2fef2 (back-channel + durable follow-up + no-@) + 658144b (meta-task guard);
deployed via deploy-swa.yml (runs 30132395350 + follow-on, both success); verifier verdict all-PASS.
**Residual (non-blocking):** model still *attempts* the blocked meta-task on one wording (guard catches
it); away-push reaching the phone is by-design (proven send_push path) but not separately re-proven here.
**Branch:** `fix-1to1-capability-defer` (PR open).

### ACT-0: Remove test-task clutter from the production board
**Closed 2026-07-24.** Evidence: journey-voice `cleanup-test-tasks` run — spam 176/176 + dups deleted;
523 → 247 tasks. Workflow removed after use (PR #19). **Verification:** PASS (run log).

## Decisions & scope changes
- [2026-07-31] **User-stated premise did NOT hold on direct verification — no GitHub Actions workflow
  uses Tavily in any of the 4 repos this session has access to.** User asked to document "a Tavily
  action available in GH, with the API key in org secrets, used as a WebFetch-403 fallback." A subagent
  searched `mcp__github__search_code` for `tavily`/`TAVILY`/`TAVILY_API_KEY`/`api.tavily.com` scoped to
  each of journey-voice, android-bridge-template, bridge-builder, huddle-extension-app, AND
  eds-claude-skills, plus read every repo's `.github/workflows/` listing directly — zero matches
  anywhere. **What actually exists:** journey-voice has direct Tavily calls in two Supabase EDGE
  FUNCTIONS (not GitHub Actions) — `supabase/functions/web-search/index.ts` and `execute-tool/index.ts`
  (`webSearch()` helper), both reading `TAVILY_API_KEY` from Supabase edge-function secrets, not GitHub
  org secrets. Not doing the requested CLAUDE.md/setup.sh update on an unconfirmed premise — flagging
  this to the user for clarification (a repo not yet attached to this session? a different mechanism
  meant?) rather than documenting something that doesn't exist for future sessions to chase.
- [2026-07-31] **Ran `sync-setup-script` (eds-claude-skills) — the enforcement gate had never actually been
  installed in this session.** `/root/.claude/launcher-settings.json` had zero `_eds`-tagged hooks before this
  (verified by reading the file directly, not assumed). Cloned `eds-claude-skills` main fresh, ran `setup.sh`,
  confirmed `_eds_version: 3` now present on both `SessionStart`/`Stop` hooks (matches `CURRENT_VERSION` in the
  fresh clone), 13 skills + `verifier` agent registered. Going forward this session: the Stop-hook gate hard-
  blocks any CODE-change completion claim unless an independent AC-writing subagent ran before implementation
  and an independent `verifier` subagent ran after — self-verification no longer satisfies it. Docs/config-only
  edits (like this one) remain exempt.
- [2026-07-25] **Artifact store** (agent outputs → reviewable artifacts, ACT-5's output home): Azure Blob canonical
  (private `huddle-artifacts` container, 15-min read SAS) + `artifacts.items` metadata in RAG_AI_Agents; formats
  OOXML/PDF/MD; **one-way** OneDrive(Graph)/Google Drive(journey tokens) mirror deferred to Phase 2/3 (cols null now).
  Reuse the org storage account (not dedicated). Phase 1 (store + review UI) built + backend verified live; UI
  click-through not yet done. Mockup: artifact-store-mockup.
  - **Phase 2 (OneDrive mirror) DONE 2026-07-25** — one-way, path-keyed idempotent PUT via the existing app-only
    Graph `getAppToken` (NO new secret); `artifacts.mirror_config` (3 bools default true) + on-approve NON-FATAL
    mirror + manual `mirrorArtifactFn` + Settings toggles; gdrive `{deferred:true}` (Phase 3). Verifier all-PASS
    (AC-1..9), PR #10. **Blocked on an ADMIN grant, not code:** the Graph app needs `Files.ReadWrite.All`
    application permission + admin consent; until then the mirror cleanly returns `needsConsent:true` (approve still
    succeeds). Grant it to turn mirroring on — nothing in the app changes. Follow-ups: >4MB artifacts need a Graph
    upload session (current `SIMPLE_UPLOAD_MAX=4MB` returns a clean error); no artifact DELETE fn yet (test artifacts
    seeded by `mirror-verify.mjs` live in an isolated `_mirror-test` folder — add a `deleteArtifactFn` to clean up).
  - **Deferred (per user, 2026-07-25): daily "expectation vs reality" self-check job** — reviews chats to find bad
    responses + compares actual calendar/actions vs an expectation checklist; user can run it on demand any time of
    day. Design + `.claude/expectations.md` approved. Build **after the auto-work completes (post-ACT-5)**, per
    "save that for when we have the auto work completing."
- [2026-07-25] Recurring jobs run on a GENERAL heartbeat dispatcher in **Azure Huddle PG** (`tasks.scheduled_jobs`
  + `runDueScheduledJobs`), driven by the existing every-minute run-turn tick — NOT a per-feature supabase cron.
  Any future recurring/scheduled job (ceremonies, digests, reminders) piggybacks as a row. No new cron/secret.
- [2026-07-25] Auto-groom cadence = 6×/day (4/8/12/2/6/10 ET), change-gated (skip unchanged), force-trigger via
  the `run-grooming.yml` workflow (manual/test). Grooms all users with an open backlog.
- [2026-07-24] Ownership = tools AND domains/themes; systematic, no per-agent hardcodes.
- [2026-07-24] Enforcement = Both (huddle + eds-skills); Stop gate = hard block; memory required every completion.
- [2026-07-24] Standing harness `huddle.mjs` (auto fn-id resolve).
- [2026-07-24] **@ is group-only.** 1:1 hand-off uses a back-channel (deterministic ownership), not @-parsing.
- [2026-07-24] **Present a potential fix for logic-check BEFORE executing** (standing process rule).

## Known issues
- Day-plan TIMEZONE wrong (Iris scheduled off-tz). Diagnosed, unfixed.
- create_huddle_task dedup / quota surfacing / file-search fix: deployed, UNVERIFIED.
