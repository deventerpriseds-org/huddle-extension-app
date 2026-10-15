# VERIFY inbound-email-watch loop 1

WHAT: independent verifier verdicts for PR #82 (claude/festive-bardeen-ao1ghj @ 65ab157).
WHY: owner never heard about Amy Corriveau's email; PR adds an inbound email watch.
SUPERSEDES: nothing. SUPERSEDED-BY: nothing -- current.
EVIDENCE: bun probes in verifier scratchpad; file:line refs below.

## AC-1 Screen — CONFIRMED (core) with false negatives
Probe of screenMessage(mode=needs-reply): Amy -> keep. list-unsubscribe / list-id / Precedence bulk /
Auto-Submitted auto-replied -> bulk-header. no-reply@ -> automated-sender. inference "other" -> other-folder.
Upper-case owner address -> self.
False negatives (all dropped, all plausibly real people):
- hello@ / info@ / team@ / support@ local parts (inbound-email.ts:58) — founder at hello@startup, law firm info@.
- PREFIX bleed: regex suffix `([-_.+].*)?` drops `team.lead@`, `info.sarah@`, `news.anchor.jones@`.
- Calendar invite with no "?" -> no-ask. "Send me the deck by Friday." -> no-ask. "I need you to sign..." -> no-ask.
False positive: a reply whose only "?" is in quoted history ("> Can you send it?") -> keep.

## AC-2 Once-per-email — REFUTED (production path)
enqueueTurn (turns.server.ts:202-209) is ON CONFLICT (id) DO NOTHING -> repeat id returns false. Correct.
BUT scheduler fireJob passes `runId: slotId` (scheduler.server.ts:176) where slotId = `${job.id}-${local hour}`
(scheduler.server.ts:270-280), and inboundEmailTurnId appends runId (inbound-email.ts:122-123).
Repro: same message id, slots ...T09 vs ...T10 -> `inbound-email-1d6aa4e067386e77-...T09` vs `...-T10`, equal=false.
With a 12h lookback and hourly 7-22 cadence, ONE email is re-announced (with a phone push) every hour for up to 12 hours.
Fix: in runInboundEmailWatch use `inboundEmailTurnId(m.id)` with no runId for scheduled fires (e.g. ignore runId unless
an explicit `force`/manual flag), or drop runId from the id entirely.

## AC-3 Wiring — CONFIRMED
JOB_ROWS row `inboundEmail/inbound-email` (scheduler.server.ts:98); fireJob branch posts /api/public/run-inbound-email
(scheduler.server.ts:210-213); SCHEDULING_DEFAULTS.inboundEmail hours 7-22 (scheduling-config.server.ts:102);
JobTypeKey union + Zod JOB_TYPE_KEYS (scheduling-config.functions.ts:26); SchedulingPanel label + key list;
routeTree.gen.ts registers '/api/public/run-inbound-email' in all 6 maps; route returns 503 without JOURNEY_PROXY_TOKEN,
401 on x-webhook-secret mismatch (run-inbound-email.ts:25-29).

## AC-4 Owner mailbox — CONFIRMED (code path), live value UNPROVEN
inbound-email.server.ts:74-75 uses resolveCalendarMailbox (journey get_my_config calendar_connections Outlook,
journey/identity.ts:154-174). Caveat: on journey failure it falls back to resolveTaskEmail/entra_email, which can be the
data-scope login (dev@) — then the watch silently reads the wrong inbox and the `self` screen compares against it.
No live run observed from this session (no JOURNEY_PROXY_TOKEN here).

## AC-5 Graph correctness — UNPROVEN (encoding risk flagged)
Shape is right: $filter receivedDateTime ge <ISO Z> + $orderby receivedDateTime desc (same prop, allowed);
$select incl. internetMessageHeaders on a list; Prefer outlook.body-content-type="text"; createReply {comment} expects 201.
RISK: both new queries are built with URLSearchParams (graph-email.server.ts:192, 261), which emits `%24filter` and encodes
spaces as `+`. This same file's calendar read (graph-email.server.ts:368-369) deliberately hand-builds the query
"so the OData $-params stay literal (URLSearchParams would percent-encode "$select" to "%24select")". The cited probe run
(graph-permission-check.yml section 4) used a HAND-BUILT query with no $filter, no internetMessageHeaders and no Prefer
header, so it does not prove these calls. Fix: build qs by hand with encodeURIComponent per value (as calendarView does),
or run the route with dryRun:true once and read scanned>0.
Minor: createDraftForTool fallback (graph-email.server.ts ~322) drafts via createGraphDraft in the DEFAULT from mailbox,
not the owner's mailbox the tool description promises.

## AC-6 reply_to wiring — CONFIRMED
Identical schema text + createDraftForTool({...,replyTo}) at huddle.functions.ts:3535/4391 (OpenAI), 5828/5845 (Lovable),
realtime-tools.server.ts:407/584 (voice). `data.caller`/`ctx.caller` type-check (tsc 0 errors). createReplyDraftInMailbox
only POSTs createReply (draft) — never /send; fallback is createGraphDraft (draft). Drafting never sends.

## AC-7 Security — PARTIAL
Body fenced as "----- EMAIL (untrusted data) -----" with a do-not-follow line (inbound-email.ts:150-158).
No-tool-calls is INSTRUCTION ONLY: the alert turn is an ordinary internal 1:1 turn; create_email_draft is offered
unconditionally (huddle.functions.ts:3481 comment) and other non-journey tools remain. Bounded by: journey disabled
(no board writes), send_email offered only when email_send_enabled AND non-owner recipients are saved as draft.
Route result: no subject/body/name/address fields per message (fromDomain only) — BUT the top-level `mailbox` (owner's
address) and raw Graph `error` text are returned and run-inbound-email.yml prints the full response with jq to PUBLIC logs.
Fix: drop `mailbox` from InboundEmailRunResult (or mask it) before returning from the route.

## AC-8 Build/tests — CONFIRMED (with a test gap)
bun scripts/inbound-email.test.ts 27/0; priority-check 20/0; scheduler-one-user 7/0; npx tsc --noEmit -p . rc=0, 0 errors.
Gap: inbound-email.test.ts:121-123 only tests inboundEmailTurnId WITHOUT runId, but the scheduler always passes one —
so the suite is green over the AC-2 defect.
