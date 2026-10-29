<!--
WHAT:          Build log for FEATURE 2 -- a Nexus WRITE tool (`write_nexus_assignments`) Huddle agents
               call to add/update the owner's dated, graded Nexus assignments, with Elle (elle-rowan)
               and Iris (iris-chase) as the prime responders.
WHY:           Huddle's Nexus bridge was read-only (nexus.server.ts, "READ-ONLY BY CONSTRUCTION"), so
               "add my MGT-782 assignments" had no route; and the offline router sent "update the due
               date on my research paper" to Eli (0.32) and, in a 1:1 with Elle, laneOwnerFor handed
               it to Eli too. Owner: "the nexus tool should be among a pool of tools but elle and iris
               should be prime to use it immediately if i request it."
SUPERSEDES:    nothing
SUPERSEDED-BY: nothing -- current
EVIDENCE:      ACs: nexus-hub docs/cross-app-agent/AC-syllabus-deliverables-write-tool.md Part B +
               RESOLUTIONS (OQ-9 = W1, X-UAT-Token). Tests: scripts/nexus-write-tool.test.ts
               (npm run test:nexus-write). Commits on branch worktree-agent-a5321d2fac007d47a.
-->

# BUILD — Nexus write tool for Huddle agents (Feature 2)

Base: huddle-extension-app `origin/main` 4809e2e (fast-forwarded before any edit).
Nexus contract read from a fresh clone of nexus-hub `origin/main` a3683ab.

## Step 0 — facts read before writing anything

| Fact | Source | Consequence |
|---|---|---|
| `POST /api/d1/assignments` inserts one row per transaction; body `{rows:[...]}` or a bare row; returns `{rows:[row]}` | `api/src/functions/d1.ts:1199-1241` | one POST per item, read `rows[0].id` |
| `PATCH /api/d1/assignments?id=` updates owner-scoped row; 404 when not owned | `d1.ts:1243-1300` | update needs the assignment id |
| Writable columns: course_id, title, description, type, status, due_date, priority, points, … program_id, canvas_meta | `d1.ts:400-412` | tool sends only course_id/program_id (from the course row) + title/description/type/status/due_date/priority/points |
| UAT write auth: `x-uat-token` equal (timingSafeEqual) to Function App `UAT_BYPASS_TOKEN`; owner = `?owner=` | `api/src/lib/auth.ts:131-137` | Huddle sends `X-UAT-Token` and sets `?owner=` from `NEXUS_OWNER_ID` |
| **PATCH always writes a preimage** (op='update', complete prior row, same tx) | `d1.ts:1272-1294` | no reversibility gap on UPDATE |
| POST writes an op='insert' preimage **only when `x-agent-tool` is sent** | `d1.ts:1136-1143`, `preimage.ts:175` | tool always sends `X-Agent-Tool` + `X-Agent-Ref` |
| Huddle server runtime had **no** `UAT_BYPASS_TOKEN` app setting — only the client build gets `VITE_UAT_BYPASS_TOKEN` | `.github/workflows/deploy-swa.yml:201` vs `:413-437` | add `UAT_BYPASS_TOKEN="${{ secrets.UAT_BYPASS_TOKEN }}"` (same org secret Nexus's `api-deploy.yml:125` syncs; no new secret) |
| Nexus `normTitle` = lowercase, non-alphanumerics → space, trim | `api/src/shared/canvasIngest.ts:128` | spelled identically in Huddle (cannot import across repos — see gaps) |
| Nexus `normCode` drops every separator | `api/src/shared/courseLink.ts:46` | same |

## Progress

### Step 1 — the tool (commit 500d015)

- `src/features/huddle/lib/nexus/nexus-write.server.ts`: the tool definition, `nexusWriteConfigured()`
  (URL + owner + `UAT_BYPASS_TOKEN`), and ONE outbound call site `nexusWriteFetch` (POST/PATCH of
  `/api/d1/assignments` only, `?owner=` set last from `NEXUS_OWNER_ID`, headers `X-UAT-Token`,
  `X-Agent-Tool: write_nexus_assignments`, `X-Agent-Ref: huddle:<id>:turn:<id>:agent:<id>`).
  Pure parts: `resolveDueInstant` (the one dated-only predicate, Intl tz, two-pass DST),
  `classifyNonDeliverable` (meeting/session, administrative), `findDuplicate` (exact normalised title
  after a grade weight is dropped, OR same instant within 60 s + one title's words a subset of the
  other's), `resolveCourse` (exact code, then exact name; two hits = `course_ambiguous`; no
  containment guess).
- `nexus-write-shared.ts`: tool name, result type, `enforceNexusWriteHonesty` (pure, so the
  synchronous reply assembly can import it statically).
- `nexus.server.ts`: only `export` added to `nexusOwner`/`nexusBase`/`nexusGet`/`TIMEOUT_MS` and a
  comment. `nexusFetch` is untouched.
- Wiring: text pool + text dispatch (with a per-turn `claimAction` on identical args, and the FULL
  result in `recordToolUse.detail`), reply assembly runs `enforceNexusWriteHonesty`, voice toolset +
  NATIVE + dispatch.
- `deploy-swa.yml`: `UAT_BYPASS_TOKEN="${{ secrets.UAT_BYPASS_TOKEN }}"` added to the SWA app
  settings (the existing org secret; no new secret).

### Step 2 — routing (commit aa971c6)

Data, not names: `NEXUS_ASSIGNMENTS_CAPABILITY` (agents.ts, `exclusive:false`, `triggers` + new
`triggerPairs` co-occurrence field) attached to Iris and Elle; Elle gains themes `assignments,
syllabus, deliverables, due date`. Generic code: `sharedCapabilityMatches`/`sharedCapabilityHolders`/
`primeMarker` (capabilities.ts), `routeMessage` step 1b picks a holder, `primeLaneDecision` drives both
`laneOwnerFor` and the 1:1 owner follow-up (decided BEFORE `resolveOwnerLLM`), and the LLM router
roster + both router prompts gain a `[prime for: …]` marker / PRIME RESPONDERS rule. Agent prompts
untouched; the roster header sentence was EXTENDED (additive).
`git diff origin/main` adds **0** `"elle-rowan"`/`"iris-chase"` literals to routing.ts,
huddle.functions.ts or nexus.server.ts (AC-F2-44).

Measured offline (`routeMessage`, group, all agents):

| phrase | before (origin/main) | after |
|---|---|---|
| add my assignments | iris 0.03 | elle |
| update the due date on my research paper | **eli 0.32** | elle (prime) |
| log my DBA deliverables | **ezra 0.26** | iris (prime) |
| add my school assignments | elle (faith runner-up) | elle |
| fix the due date on my strategy paper | **liam 0.11** | elle (prime) |
| laneOwnerFor(due-date phrase, elle / iris) | **eli / eli** | null / null |

### Step 3 — tests (commits 0b64452, 7ef68de, cf2f61f)

```
bun scripts/nexus-write-tool.test.ts     ALL PASS: 115 passed, 0 failed   (npm run test:nexus-write)
bun scripts/router-winners.test.ts       39 passed, 0 failed  (was 20; +19 prime-responder cases)
bun scripts/nexus-read-tools.test.ts     ALL PASS: 190 passed, 0 failed   (unchanged file)
bun scripts/cross-app-turn-gate.test.ts  92 passed, 0 failed
bun scripts/voice-toolset-hidden.test.ts 36 passed, 0 failed
npx tsc --noEmit -p .                    clean
```
All offline: `fetch` replaced by an in-memory fake Nexus; no live Nexus/Huddle/DB/board call.

### Step 4 — mutation proofs (`mutate.sh`, anchors from files; verdicts verbatim)

Every run also printed `restored: <file> matches HEAD` and `tree clean: … passes again`.

| id | defect reinstated | named test | verdict |
|---|---|---|---|
| M01 | `parseTimeToISO`'s month-only DST heuristic | RG-3 2026-03-07 23:59 ET (EST, day before the switch) | FIRED |
| M02 | guess the year for "Oct 30" | F2-10 a date with no year is ambiguous-date, never guessed | FIRED |
| M03 | update sends `due_date:null` | F2-12 an update cannot make a row undated | FIRED |
| M04 | meeting refusal removed | F2-11 Residency 4 is rejected as meeting/session | FIRED |
| M05 | same-instant subset rule off | F1-11 'Research Paper Proposal' (same instant) is the stored 'Research Proposal' | FIRED |
| M06 | subset rule ignores the instant (over-match) | F1-12 'Research Paper Proposal' is NOT swallowed by a different-date 'Research Paper' | FIRED |
| M07 | grade weight kept in the title | F2-14 a grade weight is not part of the title | FIRED |
| M08 | duplicated code → first hit | F2-18 a duplicated code is course_ambiguous, not the first hit | FIRED |
| M09 | foreign/demo courses not filtered | F2-17 unknown course (a foreign demo row is NOT his) -> course_not_found | FIRED |
| M10 | model item spread into the POST body | F2-33 outbound body carries only whitelisted keys | FIRED |
| M11 | `?owner=` not applied | F2-33 ?owner= is the configured owner, never the model's | FIRED |
| M12 | batch cap ×10 | F2-23 over the limit -> batch_too_large | FIRED |
| M13 | 2xx without a row id → persisted:true | F2-34 post200noid -> persisted/error | FIRED |
| M14 | timeout → persisted:false | F2-34 timeout -> persisted/error | FIRED |
| M15 | success claim not replaced | F2-35 a success claim is REPLACED, not decorated | FIRED |
| M16 | honesty guard unwired from reply assembly | F2-35 the guard is applied in the reply assembly | FIRED (static) |
| M17 | write gate ignores the token | F2-30 token missing -> no write tool | FIRED |
| M18 | `nexusFetch` gains method + token header | RG-6 nexusFetch is still a bare GET | FIRED (static) |
| M19 | write name dropped from voice NATIVE | F2-31 (4a) voice NATIVE set holds the name (never journey-proxied) | FIRED (static) |
| M20 | `X-Agent-Tool` header dropped (insert not undoable) | F2-33 X-Agent-Tool names the tool (makes the insert undoable in Nexus) | FIRED |
| M21 | 1:1 follow-up skips the prime decision | F2-42 1:1 follow-up consults primeLaneDecision before the LLM resolver | FIRED (static) |
| M22 | wall-clock read as SERVER-local time | F2-13 identical under TZ=Asia/Tokyo | FIRED |
| R01 | routeMessage prime step off | F2-41 group fallback: Elle/Iris lead 10/10 | FIRED |
| R02 | holder not kept in its own 1:1 | F2-42 1:1 with elle-rowan keeps all 10 (no lane hand-off) | FIRED |
| R03 | capability removed from Iris (agents.ts) | F2-42 1:1 with iris-chase keeps all 10 (no lane hand-off) | FIRED |
| R04 | bare "paper" added as a trigger | F2-45 'buy paper towels' is not a coursework ask | FIRED |
| R05 | trigger matched as a 6-char substring | F2-45 'assign the grocery run' is not captured by 'assignment' | FIRED |

"(static)" = the guard asserts source shape (wiring), not runtime behaviour.

## AC status (Part B, read against the RESOLUTIONS: W1 auth)

| AC | status | evidence / note |
|---|---|---|
| F2-01/02/03 | MET BY NEXUS (unchanged code) | auth.ts:131-137: no/mismatched/empty token never verifies -> `requireWrite` 401; length guarded before `timingSafeEqual`. Not exercised live. |
| F2-04 | MET at Huddle's boundary | model cannot supply identity (schema + whitelist read, M10/M11). Under W1 Nexus itself honours any `?owner=` a token-holder sends — that is W1's accepted property. |
| F2-05 | REPLACED by OQ-10 | owner = Huddle's server-held `NEXUS_OWNER_ID`. |
| F2-06 | N/A under W1 | no JOURNEY_PROXY_TOKEN endpoint was built. |
| F2-07 | MET (tool side) | no DELETE in the module (RG-2 static); only whitelisted columns sent. |
| F2-08 | MET | d1 PATCH 404s a foreign id (d1.ts:1281); tool maps it to `not_found`, persisted:false (tested). |
| F2-09 | PARTIAL | pre-image `actor_tool`=write_nexus_assignments, `actor_ref`=huddle/turn/agent; `actor_source` is still `'uat'` (W1 cannot change that). |
| F2-10 | MET in Huddle | one predicate for ADD and UPDATE; 10-input vector. Cross-repo sharing with F1 impossible — see gaps. |
| F2-11/12/13 | MET | tests + M02/M03/M04/M01/M22. |
| F2-14/15 | MET | fixture uses the live ids; M05/M06/M07; retry-after-timeout returns the first id. |
| F2-16..19 | MET | five spellings; MGT-999; TST-701 ×2; NULL-code exact name; M08/M09. |
| F2-20 | PARTIAL | PATCH carries only changed fields (tested). Pre-image + undo is d1.ts:1272-1294 (always logs op='update'); not exercised here. |
| F2-21 | MET (by contract) | `X-Agent-Tool` sent on POST (M20), which is what makes d1 log op='insert' (d1.ts:1136). |
| F2-22/23 | MET | tested. |
| F2-30..34 | MET | tested; M13/M14/M17/M19. |
| F2-35 | PARTIAL | runtime guard on the TEXT path (M15/M16). The live 5-trial harness was not run (offline-only brief). VOICE has no post-reply guard. |
| F2-36/37 | MET | tested; M18. |
| F2-38 | PARTIAL | tool description says it is not a board task; no code enforcement; not verified live. |
| F2-39 | N/A | no live checks were run. |
| F2-40 | NOT RUN | live LLM router; `[prime for: …]` marker + PRIME RESPONDERS rule added. |
| F2-41/42/43/44 | MET (offline) | router-winners.test.ts; R01-R03; 0 literals added. |
| F2-45/46 | MET for "unchanged" | every regression phrase routes as on origin/main. Two of the AC's examples did NOT route as the AC says BEFORE this change either ("assign the grocery run to Iris" -> charleston-lewis, "fix the typo in the email draft" -> cam-post); pinned to baseline, not fixed. |
| F2-50 | NOT MEASURED | timeout = read TIMEOUT_MS (15 s) -> persisted:'unknown'. |

## Gaps found (for the owner / the next lane)

1. **The W1 credential is in Huddle's public client bundle.** deploy-swa.yml:201 writes
   `VITE_UAT_BYPASS_TOKEN=${{ secrets.UAT_BYPASS_TOKEN }}` into `.env.production`, so the value
   ships in the browser JS. Nexus's auth.ts:131 accepts that same secret as a verified write
   identity for ANY `?owner=`. Pre-existing (not created here), but it means the Nexus write key
   is readable by anyone who loads Huddle. Inference from reading both files: both read the SAME
   org secret name; the values were not compared.
2. **Deploy dependency:** the tool is absent in prod until a deploy carries the new
   `UAT_BYPASS_TOKEN` SWA app setting (deploy-swa.yml change on this branch).
3. **`get_nexus_assignments` filters with `eq.<value>`, which d1 does not parse** (d1.ts:606-637
   has no `eq` branch, so the value is bound literally). `course_id eq.<uuid>` -> Postgres uuid
   error; `status eq.pending` -> silently zero rows. The class-schedule branch of the same file
   already records this as measured 2026-10-15. Pre-existing READ bug, not fixed here; it matters
   because an agent finds an `assignment_id` for UPDATE through that tool (title search still works).
   The write module uses bare values.
4. **AC-F2-09 / RG-4 under W1/cross-repo:** `actor_source` stays `'uat'`; `normTitle`/`normCode`/
   the dated and dedup rules are spelled identically in Huddle but cannot be IMPORTED by Nexus F1.
   When F1 lands, two copies exist — moving them behind a Nexus endpoint is the structural fix.
5. **Race:** `claimAction` stops IDENTICAL args twice in one turn; two agents in one parallel wave
   writing EQUIVALENT-but-different titles could both read "no duplicate" and both insert. No unique
   constraint backs it in Nexus.
6. d1's `assignments` route has no `verifyCourseOwner`; unreachable from this tool (it only writes
   to courses resolved from the owner's own list), noted for any other caller.
7. Voice path: no reply-honesty enforcement (the realtime model speaks the result itself).

