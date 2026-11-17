# VERIFY handoff-confirm-flow loop 7 -- C2 (urgency) pass
# WHAT:       independent verification of C2: classifyAsk(text).urgency never reads a deferral/refusal as "now"
# WHY:        loop 4 REFUTED C2 (8 unsafe, 5 over-match); fix 7f88135f redesigned askIsUrgentNow
# SUPERSEDES: nothing (loop 4 C2 section is the predecessor evidence)
# SUPERSEDED-BY: nothing -- current
# EVIDENCE:   docs/qc-evidence/verify-handoff-confirm-flow-7-c2-probe.ts; base origin/claude/modest-brown-2hdt5n @ 28d0ab3b

## VERDICT: C2 REFUTED (5th time)

The probe was run with `bun docs/qc-evidence/verify-handoff-confirm-flow-7-c2-probe.ts` and reported `unsafe=45 over=7`.

### 1. Loop-4 rows re-run against the fix
- All 15 loop-4 rows that must read `default` (including all 8 that were unsafe before) now read **`default`**. The fix closes them.
- The 5 loop-4 over-match rows still read `default`, because each one contains a time word. These are the v4-O safe-direction misses the fix accepts by design, so they are not counted.
- 4 urgent positives still read `now`.

### 2. New UNSAFE inputs: deferral or refusal read as "now", with intent=perform (type slow)
I checked each of these with `classifyAsk`. Every row below returned `urgency=now intent=perform`. That means `oneToOneNowKeeps` (huddle.functions.ts:2077) keeps the work, and `followupMode` (huddle.functions.ts:7413) starts it in "now" mode without a confirm.

| class | input | why it leaks |
|---|---|---|
| unicode apostrophe | `Book the flight but don‘t do it right now` (U+2018) | NEGATION_RE only accepts `'` and `’` |
| unicode apostrophe | `donʼt do it right now` (U+02BC), `don`t…` (backtick), `don＇t…` (U+FF07) | same |
| typo | `dnt do it right now`, `Write the brief; dnt start it right now`, `nto right now` | not in the closed apostrophe-less list |
| idiom removal hides the rebuke | `Can't you see I'm driving right now?` | `can't you` is removed before the vetoes run |
| idiom removal | `I don't care right now`, `Research vendors, I don't care if it gets done right now` | `i don't care` is removed, which strips the only negator |
| idiom removal | `Never mind, I'll do it myself right now`, `Never mind, right now` | `never mind` (a cancellation) is removed |
| idiom removal | `Don't wait for me, I'm handling it myself right now` | `don't wait` is removed |
| owner does it himself | `I'll do it myself right now`, `Let me think, I'll get back to you right away` | no veto word |
| wait request | `Hang on, I'm checking something right now`, `Hang on right now` | `hang on` is not in DEFERRAL_RE (`hold` is) |
| refusal word | `Nah, right now I'm good`, `Nope. Right now I'm good.` | `nah`/`nope` are not in NEGATION_RE |
| busy reason | `Right now I'm tied up`, `…driving`, `…at the gym`, `…travelling` | busy list is closed |
| time word missing | `Do it tmrw, right now I'm drained`, `Draft the report, tmrw is fine, right now I'm drained`, `tomorow`, `afterwards`, `someday`, `Give me a sec`, `In a moment`, `Next time` | DEFERRAL_RE is closed; `\bafter\b` does not match "afterwards" |
| now as a noun | `Now is a terrible time`, `Now is the worst time` | leading `now\s` counts as urgency; only `bad time` is vetoed |
| asap negated without a negator | `Asap is overkill`, `It's low priority, asap would be overkill` | no veto word |

Also read as now (intent=query, so only `laneHandoffSuppression` is affected): `Do I need it right now? Nah.`, `Is it needed right away? Nope.`

DEBATABLE (not counted toward the verdict): `Stop right now`, `Cancel it right now`, `Skip it right now`, `Pause it right now`, `Just forget it now`, `Scrap that now`, `Drop it now`, `That's enough now`. Each reads now/perform. When the ask itself is a stop, doing it now may be what the owner wants. A product owner should decide.

### 3. Over-match on plain urgent asks (safe direction)
- `Please handle this now, thanks`: reads `default`. Trailing "now" fails because of ", thanks".
- `Start now?`: reads `default`. Trailing "now" only allows `!` and `.`.

### 4. Second urgency matcher
None found. Both consumers in src (huddle.functions.ts:2077 and :7413) read `classifyAsk(data.text).urgency`. handoff-followup.ts and capabilities.ts:235 go through `laneHandoffSuppression`, which also uses `classifyAsk`. The `now|asap` at agents.ts:183 is a courtesy tail on the Nexus-write parser, not an urgency check.

### 5. Mutation
- **Guard:** the `&& !DEFERRAL_RE.test(rest)` veto in askIsUrgentNow.
- **mutate.sh run 1:** using the wrapper the brief prescribes (`bash -c "bun test … | sed …"`), mutate.sh reported **INERT**. That result is a **false INERT**: without pipefail, the pipeline's exit code is sed's, so it is always 0. **The wrapper in the brief cannot prove anything.**
- **mutate.sh run 2:** with `bash -o pipefail`, mutate.sh reported **UNDETERMINED (exit 4)**. The suite failed, but mutate.sh could not parse the failure line.
- **Manual mutation:** I applied the same mutation by hand, copying the file first. These tests fail: `(fail) … S-U12`, `S-U13: "right now is a bad time" -> default`, `v3-C2: "just leave it for now"`, `"keep it on the backlog for now"`, `"park it for now"`. I restored the file and `git status` is clean. **The guard fires.** This was not a mutate.sh-controlled run, so there was no comment-line control.

### 6. Radius challenge
C1's "now" rows inherit every unsafe input above, through `oneToOneNowKeeps` and the now-mode follow-up. The sibling pass 7-rest should treat C1's "now" behaviour as only as safe as C2.

Status: COMPLETE
LOOP-7-C2-COMPLETE
