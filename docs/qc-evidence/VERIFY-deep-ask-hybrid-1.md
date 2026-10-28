# VERIFY-deep-ask-hybrid-1

<!--
WHAT:       Independent verification of commit 7ad609f (deep 1:1 asks: act now or answer + offer).
WHY:        Owner-chosen replacement for the produce-vs-quick hold; verifier pass required before ship.
SUPERSEDES: nothing
SUPERSEDED-BY: nothing -- current
EVIDENCE:   this file; commands below run against detached HEAD 7ad609f in an isolated worktree.
-->

Commit: 7ad609f on claude/intelligent-hawking-qj88qu, diffed against 7ad609f~1 (d618114).
Worktree: detached HEAD, no branch created/pushed, no DB or deployed service touched.

## Diff stat
7 files: package.json, scripts/ask-shape.test.ts (new), scripts/verdict-memory.test.ts,
huddle.functions.ts, routing.ts, tasks/ask-shape.ts (new), tasks/deep-confirm.server.ts.

## Progress log
- diff read.
- Commands run (worktree, node_modules symlinked from main checkout):
  - `npx tsc --noEmit -p .` -> no output, exit=0
  - `bun scripts/ask-shape.test.ts` -> 32 PASS, "ALL PASS", exit=0
  - `bun scripts/verdict-memory.test.ts` -> "ALL PASS", exit=0 (incl. new STRUCTURAL block: 4 PASS)
  - `bun scripts/green-light.test.ts` -> "ALL PASS", exit=0
  - `bun scripts/router-winners.test.ts` -> "20 passed, 0 failed", exit=0
- 1:1 routing: `canLLMRoute` requires `data.scope === "group"` (huddle.functions.ts:1151-1154), so 1:1 uses
  `routeMessage` (no difficulty) and `scoreAskLLM` runs at :1229-1240 when backend=openai + key. Shape is
  therefore populated on the real 1:1 path. With backend=lovable or no key, askShape stays null and the
  heuristic (:1245-1254) sets difficulty -> a deep 1:1 ask goes to answer-with-offer (never act-now).
- TIER OBSERVATION (bun, model-policy.resolveByDifficulty):
  - act-now, live o3 cap   : {"model":"o3","effort":"high","needsConfirm":false}
  - act-now, sol ceiling   : {"model":"gpt-5.6-sol","effort":"high","needsConfirm":false}
  - offer, manual terra-med: {"model":"gpt-5.6-terra","effort":"medium","needsConfirm":false}
  => the comment at huddle.functions.ts:1726 ("the persona site keeps it on the budget tier, never Sol")
     is FALSE. An act-now turn keeps difficulty 3, so the persona site (:4725-4736) resolves o3-high by
     default (agent-backends.ts:138 DEFAULT_AGENT_CEILING="o3") and Sol-high when an agent is capped to
     "sol" (capping clears `deep`, so needsConfirm is false, model-policy.ts:222-227). The old gate held
     these turns precisely to avoid the inline o3 spend (comment at :1569-1573).
- Client merge: HuddleView.tsx:1403-1435 upserts replies BY INDEX and rewrites text when it changed, so
  an offer appended at the final save replaces the streamed text in place. appendProduceOffer keeps
  indices (slice + replace), so message ids `a-<turn>-<i>` are stable.
- Chunk boundary: `produceOffer` is a local set only when `!resume` (:1590-1591, :1739) and is not in
  `buildResumeState` (:6793-6805). If a 1:1 turn returns `partial:true` (:7111-7117), the resumed
  execution has produceOffer=null -> the reply ends WITHOUT the offer and NO row is written. That is
  consistent (no unseen offer can be accepted), only the offer is lost.
- ATTACK PROBE (bun, /tmp/claude-0/-home-user/610b35f9-2a9d-5a40-a21b-4f41f313c8ed/scratchpad/probe.ts):
  routeDeepAsk("deliverable", <real asks containing incidental idioms>) -> 6/6 returned "produce":
    "Write me a guide on how to get started with Medicare Part D ..."      -> produce
    "Compare ... whether I should proceed with the Austin move ..."        -> produce
    "Research which CRM ...; we want to carry on using Gmail ..."          -> produce
    "... Draft it — he loved to say 'just do it' ..."                      -> produce
    "... tell me whether to take it on as a full time job"                 -> produce
    "Build a strategy for the launch. How should we run it across ..."      -> produce
  => runProduce returns ONLY the ack "Done — I've put “…” on the board as a produce task ..." (:1647-1666):
     a NON-ANSWER for an ask the user wanted answered. isGreenLight is a SHORT-REPLY matcher
     (green-light.ts:30-48) applied here to a whole long ask. (Pre-existing: the old code also fed
     data.text to hasGreenLit, but then the alternative was a question; now it is the only non-answer path.)
  isOfferAccepted(<replies that do NOT accept the offer>) -> 8/9 returned TRUE:
    true  "Which local farms produce the most organic eggs near me"
    true  "ok and what about the full version of the vitamin list you mentioned earlier"
    true  "Can you make it a task for Thursday to call the dentist"
    true  "put it on the board for Finn to look at"
    true  "thanks. the produce aisle at Kroger was empty today lol"
    true  "no, produce nothing — I just wanted the summary"
    false "Produce?"
    true  "nah. maybe produce later"
  => each of these, on the message right after an offer, runs runProduce with the ORIGINAL ask text
     (:1674-1677): the new request (e.g. the dentist task) is swallowed and an unrelated produce task is
     created. isNegatedOrAsked (green-light.ts:62-65) does not cover "no", "nah", "nothing", "later".
- Legacy classifyConfirmReply (unchanged in diff) observed: produce->produce, quick->quick,
  cancel->cancel, "go for it"->produce, "Okay knock it out"->produce, "just a quick take"->quick,
  "nevermind"->cancel, "what's the weather"->unrelated.
- decision.reason (bun, routeMessage 1:1 target iris-chase, "plan my day" text): base reason "1:1"
  (3 chars) -> tagged "1:1 [deep-ask: act-now]"; tag survives `.slice(0,220)`. No assignment to
  `routed.decision` after :1741 (others at :1137/1183/1210/1508/1545 all precede it).
- AC6 SQL sweep (deep-confirm.server.ts): BOOTSTRAP adds `kind TEXT NOT NULL DEFAULT 'ask'` via
  ADD COLUMN IF NOT EXISTS (constant default -> existing rows read 'ask'). `kind` is written only by
  setPendingDeepConfirm (INSERT col list + ON CONFLICT SET kind=$6) and read only by getPendingDeepConfirm
  (both SELECT branches). recordDeepConfirmVerdict UPDATE/INSERT and getRecentDeepVerdict SELECT do not
  name `kind`, so they default/leave it. Degraded mode: if the ALTER ever failed, the SELECT naming `kind`
  throws -> caught -> getPendingDeepConfirm returns null (offers AND legacy asks silently ignored).
- AC8: `scoreDifficultyLLM` has NO remaining src callers (grep: only its definition at routing.ts:465
  plus a comment at huddle.functions.ts:6688); it is now a wrapper over scoreAskLLM. `scoreAskLLM` has one
  caller (huddle.functions.ts:1232). Schema: both properties in `required`, `additionalProperties:false`,
  sent with `strict: true` (openai-responses.server.ts:34-37). tsc clean.
- AC9 sweep (grep, excl node_modules): produceVsQuickAsk still EXPORTED (deep-confirm.server.ts:271), used
  only by scripts/green-light.test.ts (passes). getRecentDeepVerdict now has NO src caller (dead export;
  used by scripts/deep-confirm-store.probe.ts, a DB probe, not run). hasGreenLit has no src caller
  (only green-light.test.ts). STALE HARNESS: `.claude/skills/test-agent-serverfn/scripts/qa-produce-quick.mjs`
  :79, :89, :96 assert the reason contains "deep-confirm: produce-vs-quick" (the old hold). It would now
  FAIL against the deployed build. Not run (live service; out of scope for writes).

## Verdicts

| AC | Verdict | Evidence |
|---|---|---|
| 1 act -> runs normally, no question/task/offer, reason has `[deep-ask: act-now]` | CONFIRMED (code + unit), with a defect in the claim around it | routeDeepAsk("act",…) -> "act-now" (ask-shape.test PASS); produceOffer only set for answer-with-offer (:1736-1740); tag observed surviving slice. BUT the act turn keeps difficulty 3 and resolves to **o3/high** by default (Sol/high under a sol ceiling); the comment at :1726 "persona site keeps it on the budget tier" is false. Requires an openai backend + key; otherwise askShape is null and act asks go to answer-with-offer. |
| 2 deliverable/null -> terra-med, difficulty 2, offer appended, row only if appended | CONFIRMED, with a gap | :1736-1739 sets deepManual="terra-med", difficulty=2; resolver observed -> gpt-5.6-terra/medium. ensureProduceOfferDelivered (:6870-6879) returns before the DB write unless `out.appended`. Gap: on a chunked turn that goes `partial` (:7111-7117), the resumed execution has produceOffer=null, so there is no offer and no row (consistent, but the offer is lost). Also appends to any non-empty reply of that agent, including a `hardReply` model-failure fallback (:6439-6444), so the offer can sit under an error message. |
| 3 green-light in current msg, shape≠act -> runProduce | CONFIRMED as specified, but **unsafe** | :1731-1734; unit PASS. Probe: 6/6 real deliverable asks with incidental idioms ("get started", "proceed", "carry on", "run it", "take it on", quoted "just do it") -> "produce". The user gets only the board-task ack (:1653-1657), a NON-ANSWER. |
| 4 offer: explicit produce phrase -> runProduce(original); else clear + route; bare yes/go ahead/sure don't produce | **REFUTED** | Bare yes/go ahead/sure -> false (PASS). Original ask text is used (:1677, `pending.askText`). But "anything else clears" fails: isOfferAccepted returned TRUE for 8/9 unrelated or declining replies, including "no, produce nothing — I just wanted the summary", "nah. maybe produce later", "Can you make it a task for Thursday to call the dentist", "Which local farms produce the most organic eggs near me". Each runs runProduce on the OLD ask and swallows the new message. |
| 5 legacy 'ask' rows handled as before | CONFIRMED | Legacy branch :1680-1720 is byte-identical to before apart from the `else if`; classifyConfirmReply untouched in the diff; observed verdicts unchanged; getPending maps a null/'ask' kind -> "ask". Note: an 'unrelated' reply to a legacy ask falls through and a fresh deliverable then overwrites the row with kind='offer' (ON CONFLICT), which is acceptable. |
| 6 migration safe; SQL consistent | CONFIRMED | See AC6 sweep above. |
| 7 both terminal paths deliver offer before save/return | CONFIRMED for the drained path; streaming is harmless; the partial path loses the offer | Chunked: :7119-7123 (ensure -> saveTurnChunk); sync: :7131-7135 (ensure -> finalResult). streamChunk/mid-reply streaming (:6959-6966, 1:1 streamReplies default on at :4841) shows the reply first without the line; the final poll rewrites it in place by index (HuddleView.tsx:1403-1435), so the user ends up seeing the line. The 1:1 conversation-object memory stores the model output without the line (inference: the model will not know it offered). Early `finalize` returns (:1468, :1756) run with no produceOffer set or no winners, so nothing is lost there. |
| 8 scorer callers + strict schema | CONFIRMED | See AC8 above. |
| 9 nothing else depended on old hold | **REFUTED (minor)** | `.claude/skills/test-agent-serverfn/scripts/qa-produce-quick.mjs` asserts the old hold tag (:79, :89, :96) and will now fail. getRecentDeepVerdict and hasGreenLit are now dead in src (not harmful). |

## Non-answer / bad-acceptance paths found (try-to-break)
1. Incidental go-ahead idiom inside a long deliverable ask -> runProduce ack only (AC3 row).
2. Any next message containing "produce", "full version", "make it a task", "put it on the board",
   "work it up" (even when declining or asking something new) -> accepts the offer (AC4 row).
3. Offer persistence beyond "the very next message": the clear at :1679 only runs inside the 1:1 block,
   which skips internal / ceremonyBarge / appContext / resume turns (:1591). A user message carrying
   appContext does not retire the offer, so it can be accepted up to 2h later (getPending expiry). (Code read; not exercised.)
4. Act asks spend o3-high inline (cost/latency), contradicting the commit comment.

## Not run
- No live turn (sendHuddleMessage) was driven: no writes to DB or the deployed service, per brief.
  So AC1/AC2/AC7 behaviour on the deployed build is code-traced + unit-observed, NOT live-observed.
- qa-produce-quick.mjs (live harness) not run.

Verdict: CONFIRMED 7 (AC1,2,3,5,6,7,8; AC1, AC2 and AC7 with noted gaps, AC3 flagged unsafe) | REFUTED 2 (AC4, AC9) | UNPROVEN live: AC1, AC2, AC7 (no live turn driven).
