# VERIFY chat-format, loop 4
# WHAT:       independent verification of PR #149 at c57018f (loop 4)
# WHY:        loop 3 REFUTED B1 (directive over INTERNAL_TEXT_MAX) and A1 (link parens); re-derive both
# SUPERSEDES: VERIFY-chat-format-3-{A,B,CE}.md (for the claims below)
# SUPERSEDED-BY: nothing -- current
# EVIDENCE:   scratch tests scripts/zz-b1.ts, scripts/zz-a1.tsx (not committed), run at c57018f

Subject: deventerpriseds-org/huddle-extension-app c57018f, branch claude/vibrant-allen-p52snq.

## R1 suites / tsc / build — CONFIRMED
chat-format 66/0, schedule-brief 84/0, priority-check 47/0, inbound-email 72/0,
schedule-brief-dedupe 21/0, router-winners 39/0; `npx tsc --noEmit -p .` rc=0; `npm run build` rc=0.

## B1 payload size (FULL re-derivation) — CONFIRMED (one residual noted)
Payload built exactly as runScheduleBrief builds it, parsed with the REAL `Input` schema (copy of
huddle.functions.ts with only `const Input` -> `export const Input`). 6-day lookahead with the same
per-day count, tasks list of the same count.

| case | edition | kind | text len | appendBlock len | Input.parse |
|---|---|---|---|---|---|
| 19/day 58ch | morning | items | 5406 | 5791 | OK |
| 19/day 58ch | evening | items | 5401 | 5931 | OK |
| 25/day 58ch | morning | items | 5594 | 6730 | OK |
| 25/day 58ch | evening | items | 5589 | 6912 | OK |
| 40/day 58ch | morning | items | 5596 | 6858 | OK |
| 40/day 58ch | evening | items | 5591 | 7040 | OK |
| 5/day 255+255 | morning | items | 4930 | 5933 | OK |
| 5/day 255+255 | evening | items | 4925 | 5940 | OK |
| 40/day 255+255 | morning | items | 10225 | 7693 | OK |
| 40/day 255+255 | evening | items | 10220 | 7700 | OK |
| 200/day 255+255 | morning | items | 10228 | 7696 | OK (plateau: caps hold) |
| window 40/day 255 | morning | items | 7216 | 8319 | OK |
| empty day + 40/day week 255 | morning | nothing-scheduled | 3728 | 4262 | OK |

priorityCheckDirective: only 3 titles are named, so it is bounded except for title length
(500 priorities x 5000-char titles -> 16027; real titles are far shorter). inboundEmailDirective with
5000-char name/address/subject/received and 100k body -> 7199 (< 16000).

Delivered once at both endings: `ensureAppendBlockDelivered` is called at both returns of the chunked
driver (huddle.functions.ts ~7558 and ~7571) and is idempotent (`replies[i].text.includes(block)`).

RESIDUAL (attack, not a requested case): source ERROR text is not capped. `errors`, `tasksError`,
`upcomingErrors` are joined verbatim into the directive. 500-char errors -> OK (8779); 5000-char errors
-> 22279 / FAIL. Real sources observed: Nexus returns codes (`http_500`, `timeout`), Graph
calendarView slices raw bodies to 200 but passes Graph's own `error.message` unsliced; thrown
`err.message`. No observed source produces kilobyte errors, so this is a low-likelihood gap, not a
regression of the fix.

## A1 links (FULL re-derivation) — CONFIRMED
- `[docs](https://a.io/p_(q))` -> one link, href `https://a.io/p_(q)`, label `docs` (loop-3 bug fixed).
- `see [docs](https://a.io/p_(q)).` -> link + trailing "." outside.
- `[x](https://a.io/y))` -> link `https://a.io/y`, stray ")" as text.
- `[x](https://a.io/(y)` -> unbalanced: text `[x](` + bare link `https://a.io/(y)`.
- `[x](javascript:alert(1))`, `[x](data:text/html,<script>…)` -> plain text, no link.
- `[x](https://a.io/(javascript:alert(1)))` -> link only to `https://a.io/`, rest as text.
- `[x](https://a.io/"onmouseover=alert(1))` -> React escapes `"` to `&quot;` inside href; no attribute break.
- `[<img src=x onerror=alert(1)>](https://a.io)` -> label rendered escaped `&lt;img…&gt;`.
- `<script>` in text -> escaped. Nested `[a [b](https://e.io)](https://f.io)` -> two safe links, no crash.
- Minor (not a defect of the claim): parentheses nested TWO deep (`https://a.io/((y))`) are not
  supported; it degrades to a link to `https://a.io/` plus the rest as text (safe, rare).

## Re-checks (reduced depth) — all CONFIRMED
- A2: "1. one / 2. two / 10. ten" renders `<li value=1|2|10>`; "$1,200", "2*3=6", "a_b_c", "__init__" unchanged.
- A3: "a * star and 5 * 6 and C:\path and 1) not a list?" -> single plain `<p>`, unaltered.
- B2: empty business_hours window -> kind nothing-scheduled, "the business hours window (9 AM–5 PM)", no block.
- B3: classes http_500 only -> read-error naming ONLY classes, "meetings WERE read successfully".
- C1: full-match draft stripped with its "Suggested reply:" label; partial match returned unchanged.
- E1: noticeText -> "Couldn't respond — quota exhausted"; "(fallback: gpt-4o (TPM): Limit) …" kept whole; real reply -> null.
- R2: build + tsc green over all consumers.

Overall verdict: CONFIRMED
