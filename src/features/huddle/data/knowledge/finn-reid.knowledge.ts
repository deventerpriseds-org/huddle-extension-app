import type { KnowledgePack } from "./types";

// Finn Reid — Finance Strategist. Grounded in personal financial planning (CFP
// body of knowledge) and early-stage venture finance. Advice must be numerate,
// defensible, and cash-flow-honest — never career or health advice.
export const finnReidKnowledge: KnowledgePack = {
  agentId: "finn-reid",
  discipline: "Personal & venture finance strategy",
  frameworks: [
    "Cash-flow-first planning — every recommendation traces to its effect on monthly free cash flow and the balance sheet, not just the P&L. A plan that improves paper profit but strains liquidity is a bad plan.",
    "The financial-order-of-operations / prioritization waterfall: (1) stabilize cash + minimum debt payments, (2) capture any employer match (free money), (3) build a starter emergency fund, (4) kill high-interest debt (avalanche), (5) full emergency fund, (6) tax-advantaged investing, (7) goal-based investing.",
    "Debt-payoff methods: avalanche (highest APR first — mathematically optimal, minimizes total interest) vs snowball (smallest balance first — better behavioral adherence). Recommend avalanche; concede snowball when motivation/behavior is the binding constraint.",
    "The 50/30/20 baseline (needs/wants/savings) as a starting frame, tightened to the person's actual fixed-cost ratio — it is a heuristic, not a law.",
    "Time value of money — discount future cash flows; a dollar today is worth more than a dollar later. Use it for lease-vs-buy, refi break-even, and prepay-vs-invest calls.",
    "For a venture: unit economics (contribution margin, CAC, LTV, payback) and runway/burn math are the finance lens; defer valuation/GTM framing to the startup and go-to-market owners.",
  ],
  vocabulary: [
    "APR vs APY — APR is the stated annual rate excluding compounding; APY includes intra-year compounding and is the honest comparison for what you actually pay or earn.",
    "Hard pull vs soft pull — a hard inquiry hits the credit report and can shave a few points for ~12 months; a soft pull (pre-qualification, self-check) does not affect score. Prefer soft-pull pre-qual before any hard app.",
    "Credit utilization — revolving balance ÷ limit; the second-biggest FICO factor after payment history.",
    "DTI (debt-to-income) — monthly debt payments ÷ gross monthly income; the ratio underwriters gate on.",
    "Runway — months of operation left = cash on hand ÷ net monthly burn. Gross burn = total monthly spend; net burn = spend minus revenue.",
    "Emergency fund — liquid reserve sized in months of essential expenses, held in cash/HYSA, not invested.",
    "Refi break-even — closing costs ÷ monthly payment saving = months to recoup; refinance only if you'll hold past break-even.",
    "Effective vs marginal tax rate — marginal is the rate on the next dollar; effective is total tax ÷ total income. Decisions at the margin use marginal.",
    "Secured vs unsecured debt — secured is collateral-backed (lower rate, asset at risk); unsecured (most cards, personal loans) prices in the higher default risk.",
  ],
  benchmarks: [
    "Emergency fund: 3–6 months of essential expenses for stable W-2 income; 6–12 months for variable/self-employed or single-income households.",
    "Credit utilization: keep under 30% of limit, and under ~10% to optimize FICO; report-date balance is what matters, so pay before the statement cuts, not just before the due date.",
    "Front-end housing DTI ≤ 28% of gross income; back-end total DTI ≤ 36% (conventional), up to ~43–45% for qualified mortgages. Above that, expect pricing hits or denial.",
    "Refinance rule of thumb: worth exploring when you can cut the rate ~0.75–1.0 point AND clear the break-even before you'd sell/refi again.",
    "Payment history (~35%) and utilization (~30%) drive the majority of a FICO score; length of history, new credit, and mix fill the rest.",
    "Startup default: keep 12–18 months of runway; start raising or cutting burn at ~6 months left — a raise takes 3–6 months to close.",
    "Prepay-vs-invest: paying down debt is a guaranteed after-tax return equal to its rate — beat a ~6–8%+ APR by paying it off before investing in risk assets.",
  ],
  decisionPatterns: [
    "Anchor to a number. If the user gives none, state the assumption you're using and give the formula so they can plug their real figures — never hand-wave a financial call.",
    "Separate guaranteed returns (debt paydown, employer match) from expected/risky returns (markets) — prioritize the guaranteed one at equal-or-higher rate.",
    "Protect liquidity before optimizing yield: don't lock the emergency fund into an illiquid or volatile vehicle to chase a point of return.",
    "Sequence credit actions to protect the score before a big application: pay balances below the utilization threshold, avoid new hard pulls in the 6–12 months prior, don't close old lines (it shortens history and raises utilization).",
    "For any borrow/refi, compute break-even and total interest over the life, not just the monthly payment — a lower payment can cost far more over time.",
  ],
  playbooks: [
    "Budget build: fixed costs → variable → savings targets, then pressure-test against actual cash flow and name the 1–2 highest-leverage cuts.",
    "Credit-optimization sprint: pull utilization per card and in aggregate, stage payments to report-date, dispute errors, and sequence any new-credit applications after the score recovers.",
    "Debt plan: list every balance with APR, minimum, and limit; order by avalanche; show months-to-debt-free and total interest vs the snowball alternative.",
    "Refi/loan analysis: quote APR (not just rate), total closing costs, break-even month, and lifetime interest delta; recommend soft-pull pre-qual first.",
    "Runway model: cash ÷ net burn = months; flag the date you hit the 6-month raise/cut trigger and the levers (revenue, burn) that move it.",
  ],
  antiPatterns: [
    "Chasing yield while carrying high-APR revolving debt — the guaranteed 20%+ 'return' of paying the card beats almost any investment.",
    "Comparing loans by monthly payment alone — a longer term lowers the payment but can raise total interest sharply.",
    "Closing the oldest card to 'simplify' — it shortens credit history and spikes utilization, hurting the score.",
    "Draining the emergency fund to prepay debt or invest, leaving no buffer — one shock then forces high-cost borrowing.",
    "Letting a card report a high balance then paying it off — the score already took the utilization hit at statement date.",
    "Treating a raise timeline as instantaneous — running out of runway mid-raise means raising from weakness or shutting down.",
  ],
};
