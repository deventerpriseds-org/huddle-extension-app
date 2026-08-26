# Scenario test — DO / ASSIST / REMIND against the real board (2026-08-26)

Purpose: before building a third task mode, walk REAL tasks through it and check the result is help,
not noise. Every task below is a live row from `tasks.journey_tasks` currently stuck at
`confirm_status='asked'` (34 open, oldest 21 days).

## The three modes

| Mode | Who does the work | What the agent owns | Confirm-ask? |
|---|---|---|---|
| **DO** | Agent, end to end | The deliverable itself | Yes — "is this the right deliverable?" |
| **ASSIST** | Split | A slice it can finish ALONE with what it already has | Yes — "is this the right slice?" |
| **REMIND** | User, entirely | The follow-up, so it isn't dropped | **No** — nothing to define. One question: *when?* |

The rule that decides the mode: **can the agent finish something real using only what it already has**
(its tools, your profile, memory, board/email/calendar data)? If it needs facts only you can supply
— your car's tire size, what's wrong with the vehicle, Veridian's records — it is NOT DO or ASSIST.

## How the 34 actually split

### DO — 8 tasks. Agent completes it; you consume the output.
Research Agentforce by Salesforce (Sam) · Research Slack AI Agents (Sam) · Research tools wealthy
people need (Sam) · Plan business architecture from holding company to DBAs (Sam) · Plan digital
learning assets to launch (Sam) · Define Reusable Playbook Template for Nexus App (Tess) · Find
sample enterprise AI consultants and teaching videos (Elle) · Become a professional advisor for
Claude Business (Cole)

These are already working correctly today — Tess's playbook-spec proposal was concrete and doable.

### ASSIST — 6 tasks. Agent finishes a real slice alone; you finish the rest.
| Task | The slice the agent can genuinely do alone |
|---|---|
| Reply to DBA email (Cole) | Reads the thread via Graph, drafts the reply. You send. |
| Import schedule from image or file (Eli) | You already uploaded the image — extract dates/commitments. |
| Update LinkedIn profile (Cole) | Drafts headline + summary from your Executive Profile. You paste. |
| Apply to the Trinnex position with Boost (Cole) | Drafts the tailored cover letter. You submit. |
| Transfer Jotform Resume Tool Suite to N8N (Elle) | Drafts the migration plan/config. You execute. |
| Confirm six courses in the MIT CTO program (Elle) | Assembles what's known, marks the gaps. |

### REMIND — 17 tasks. Agent can do NONE of it. It owns the nudge.
Go to church · Set reminder for church · Take son shoe shopping · Order replacement tire · Order a
new car tire · Order parts for wife's SUV · Cancel or take wife's SUV for repair · Wife's car repair ·
Order gold chains this week · Buy new cord for Ghost · Transfer bill account/Amex/SUV funds ·
Confirm HSA withdrawal arrives by mail · Investigate Veridian transfer issues · Start AI certification
course · Import MIT AI course assignments to Nexus · Work on Nexus application · Create a new project
in consulting app

**This is exactly where today's overreach lives.** Ezra proposing to "verify the tire specification"
without your car. Iris proposing to "reconstruct transaction details from available records" she
cannot reach. Under REMIND neither agent invents a deliverable — the honest job is the follow-up.

## THE NOISE QUESTION — the whole point of this test

| Scenario | Messages per day | Verdict |
|---|---|---|
| **Today** | 0 follow-ups; 34 items frozen and invisible | Silent failure |
| **Naive 24h re-ask on all 34** | **34/day** | Unusable — this is what we nearly built |
| **Three modes** | ~2–3/day, then near zero | Workable |

Three-mode math:
- **DO + ASSIST = 14 tasks → 14 one-time confirm-asks**, spaced 45–90 min inside the existing
  9am/1pm/5pm windows ⇒ ~3/day for ~4 days, then done. Each is a real question worth answering.
- **REMIND = 17 tasks → 0 confirm-asks.** Nothing to define, so nothing to confirm.
- **REMIND needs ONE thing: a date.** 17 separate "when?" messages would be 17/day — WORSE than today.
  So REMIND must **batch**: one message listing the undated items with a proposed date each, answered
  in bulk. After that, each fires as a normal scheduled reminder at the time you chose — which is the
  thing you actually wanted, not noise.
- **A 24h re-ask then applies ONLY to the ~14 DO/ASSIST confirms**, not to all 34.

## What this surfaces as a side effect — DUPLICATES on the live board
The categorisation exposed near-duplicate rows that should be merged, not separately reminded:
- "Order replacement tire" ≈ "Order a new car tire"
- "Wife's car repair" ≈ "Cancel or take wife's SUV for repair" ≈ "Order parts for wife's SUV"
- "Update LinkedIn profile" appears twice (both Cole, both asked 2026-08-21)
- "Apply to the Trinnex position with Boost" ≈ "Apply to Trinnex position with boost"
- "Go to church" ≈ "Set reminder for church"
Reminding on each separately would manufacture noise from a data problem. De-dup belongs in the
same grooming pass.

## Open questions for the user
1. **REMIND batching** — one digest listing undated remind-items with proposed dates, answered in
   bulk? (The alternative, asking per-task, is the noise failure mode.)
2. **Should REMIND items still occupy an agent's WIP lane?** They cost the agent no work, so they
   probably should NOT consume an UP_NEXT slot — otherwise 17 remind-items starve the real work.
3. **Recurrence** — "Go to church" is weekly; "Confirm HSA withdrawal" is a one-shot. Does REMIND
   need a repeat flag, or is one-shot enough for now?
4. **De-dup** — merge the near-duplicates above in the same pass, or handle separately?
