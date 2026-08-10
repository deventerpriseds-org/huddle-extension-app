# Model A/B — deep-ask cost/quality findings (2026-08-10)

**Question the user asked:** on genuinely deep asks (the top of the difficulty ladder), is a cheaper
reasoning model as good as our current deep default `gpt-5.6-sol` (Sol-high) — and how much cheaper?

**Contenders:** `o3-mini` (effort high) · `o3` (effort high) · `gpt-5.6-terra` (terra-high) ·
`gpt-5.6-sol` (sol-high, the reference / current `DIFF_RUNG[3-4]`).

**Harness:** `.claude/skills/test-agent-serverfn/scripts/model-ab.mjs`, run in GHA via
`.github/workflows/model-ab.yml` with the org `OPENAI_API_KEY` (the CCR session can't reach OpenAI
directly). 4 deep prompts (GTM strategy · 3-statement financial-model logic · seed-vs-bootstrap
decision framework · warehouse-automation research memo). Each answer scored 0–100 by a **blind**
judge (`gpt-5.6-sol`, answers shuffled + relabeled A–D) on rigor/completeness/structure/actionability.
Pure API calls — no Huddle runtime, no journey, no board writes.

## Results (corrected run 31404223576, all 4 prompts judged)

| config | avg quality (0–100) | out tok/turn (reasoning) | $/turn |
|---|---|---|---|
| **o3** (high) | **80.5** | 2771 (1200) | **$0.022** |
| gpt-5.6-sol (sol-high) — *current deep default* | 63.0 | 4861 (2857) | $0.146 |
| gpt-5.6-terra (terra-high) | 59.8 | 5729 (2428) | $0.069 |
| o3-mini (high) | 58.5 | 4323 (2608) | $0.019 |

Per-prompt quality: o3 topped every prompt (76, 84, 74, 88) except prompt 3, where terra-high (82)
edged it (74). Input was a flat ~72 tok/turn across all configs (short prompts).

### Prices used ($/1M in/out)
- **GPT-5.6 — confirmed via Tavily 2026-08-10** (5 sources: techjacksolutions, aipricing.guru,
  benchlm, spheron, apidog; all verified against OpenAI's own pricing page, reflecting the **July-30-2026**
  cut): **Sol $5/$30 · Terra $2/$12 · Luna $0.20/$1.20**. (Luna is unchanged-context short rate.)
- **o3 $2/$8 · o3-mini $1.1/$4.4** — best-known list prices (already in the harness; not re-confirmed
  this pass).

## Interpretation

- **o3 dominates on both axes.** Highest quality (80.5, +17.5 over sol-high) *and* cheaper than both
  5.6 tiers we currently escalate to. It also emits the **fewest output tokens** (2771) — concise, not
  truncated — which is what keeps its $/turn low.
- **Our most expensive tier is our second-worst value.** `sol-high` costs **6.6× o3** ($0.146 vs
  $0.022) for **17 fewer quality points**. On this evidence the Terra→Sol jump buys almost nothing on
  deep asks (sol 63.0 vs terra 59.8, ~3 pts) at 2× the price.
- **o3-mini** is the cheapest ($0.019) but bottom of the quality pack (58.5) — fine as a floor, not a
  deep-ask tier.

## Caveats (calibrated to the evidence — this is directional, not a proof)

- **Small sample:** n=4 prompts, one judge, one run. Real variance exists (prompt 3 flipped: terra 82 >
  o3 74). Treat the ordering as strong and the exact deltas as approximate.
- **Judge is `gpt-5.6-sol`** (same family as two contenders). If that biases anything it's *toward*
  5.6 — yet the judge still ranked o3 first and scored its own family's sol-high at 63, so the o3 result
  is if anything understated. Not a pro-o3 judge.
- **Deep prompts only.** Says nothing about easy/standard turns — those run Luna regardless of this
  result (the difficulty ladder starts every agent on Luna; see the model-policy notes).
- The **first run (31402368819) was invalid** and discarded: the judge (`gpt-5.6-sol`, effort:high,
  `max_output_tokens:500`) spent its whole budget on reasoning tokens before emitting the JSON verdict,
  so 2/4 prompts came back unscored (`?`) and one `sol-high=0` was an artifact; the 5.6 tiers were also
  truncated at a 4000-token answer ceiling. Fixed by dropping the judge to effort:medium / 2500-token
  ceiling + one retry, and raising the answer ceiling to 6000 (commit 858ba8f). The table above is the
  corrected run.

## Implication for the model policy (NOT yet applied — awaiting user decision)

The top rung of the difficulty ladder — `DIFF_RUNG[3-4]` in `src/features/huddle/lib/model-policy.ts`,
currently `gpt-5.6-sol` / high — is a strong candidate to swap to **o3**: better quality, fewer tokens,
~$0.022/turn vs $0.146. This is a live model-selection change and is being held for explicit sign-off
(same batch as the ceiling-resolution fix documented in memory.md 2026-08-10).

To re-run: dispatch `model-ab.yml` (workflow_dispatch, no inputs). Prices are now wired into the
harness, so future runs print real `$/turn` for all four configs.
