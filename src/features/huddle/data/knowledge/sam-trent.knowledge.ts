import type { KnowledgePack } from "./types";

// Sam Trent — Startup planner. Grounded in modern early-stage venture practice
// (Lean Startup, YC-style advice, GTM motion design). Owns the business AROUND a
// product — MVP shape, pitch, fundraising, go-to-market — not what to build next
// (that's the product owner) nor the finance detail (that's the finance strategist).
export const samTrentKnowledge: KnowledgePack = {
  agentId: "sam-trent",
  discipline: "Early-stage startup strategy, fundraising & go-to-market",
  frameworks: [
    "Lean Startup build-measure-learn: the MVP exists to test the riskiest assumption with the least build, not to be a small version of the product. Validated learning over vanity progress.",
    "Problem/solution fit → product/market fit → scale — do not spend on growth before PMF; premature scaling is the top startup killer.",
    "Jobs-to-be-Done: customers 'hire' a product for a job; frame the value prop around the job and the alternative being fired, not features.",
    "The pitch/narrative spine: problem → why now → solution → market (TAM/SAM/SOM) → traction → business model → team → ask. 'Why now' and traction carry the most weight at seed.",
    "GTM motion selection: product-led (self-serve, low ACV, fast payback) vs sales-led (high ACV, longer cycle) vs community/bottoms-up — pick the motion the price point and buyer can support; don't run a field-sales motion on a $20/mo product.",
    "The Rule of 40 (growth rate % + profit margin % ≥ 40) as the health bar for later-stage; at seed, growth rate and retention dominate.",
    "Default alive vs default dead: on current growth and burn, does the company reach profitability before cash runs out? Know which you are.",
  ],
  vocabulary: [
    "MVP — the smallest thing that tests the riskiest assumption and produces validated learning; a concierge/Wizard-of-Oz MVP fakes the backend to test demand before building it.",
    "Product/market fit — the market pulling product out of you; measured by retention curves flattening, organic pull, and the Sean Ellis '40%+ would be very disappointed to lose it' test.",
    "TAM/SAM/SOM — total addressable, serviceable addressable, serviceable obtainable market; build bottoms-up (units × price), never a top-down '1% of a huge number'.",
    "CAC / LTV / payback — cost to acquire a customer, lifetime value, and months to recoup CAC; the core acquisition-efficiency triad.",
    "ICP — ideal customer profile; the specific segment you win first. Narrow beats broad early.",
    "Traction — evidence the machine works: revenue, active users, retention, pipeline, LOIs — real signal, not registrations.",
    "SAFE vs priced round — a SAFE is a convertible instrument with a valuation cap/discount that defers pricing; a priced round sets a per-share valuation now.",
    "Dilution / cap table / pro rata — ownership given up per round, the record of who owns what, and an investor's right to maintain their percentage.",
    "Burn multiple — net burn ÷ net new ARR; capital efficiency of growth (lower is better).",
    "Design partner / LOI — an early customer who co-develops; a letter of intent signaling committed demand pre-build.",
  ],
  benchmarks: [
    "Seed raise: typically 12–24 months of runway; raising ~18 months' worth is a common target so you can hit the next milestone with a buffer.",
    "Founder dilution: a priced seed/Series A commonly takes ~15–25% per round; watch cumulative dilution and option-pool shuffles that come out of founders' share.",
    "PMF retention signal: retention curves that FLATTEN (a stable cohort that keeps using) — not curves that decay to zero; ~40%+ on the Sean Ellis test is the working threshold.",
    "SaaS efficiency bars (post-PMF): LTV:CAC ≥ 3:1 and CAC payback ≤ ~12 months (≤18 for enterprise); below that, growth burns cash faster than it compounds.",
    "Enterprise sales cycles run ~3–9+ months; price and staff the motion for that reality — don't model self-serve conversion on a six-month sale.",
    "'Why now' matters: investors fund an inflection (a new tech, regulation, or behavior shift) that makes an old idea suddenly work — name it explicitly.",
    "Raise timeline: a round realistically takes ~3–6 months end to end; start before you're desperate.",
  ],
  decisionPatterns: [
    "Name the riskiest assumption first and design the cheapest experiment that could falsify it — build only what the test requires.",
    "Decide the GTM motion from price × buyer × sales cycle, then let it dictate the org and spend — motion drives everything downstream.",
    "Sequence: validate the problem, then demand, then willingness to pay, then scalable acquisition — don't skip to growth spend before retention proves PMF.",
    "Choose the raise instrument by stage and leverage: SAFE for speed/early, priced round when you have the traction to set terms and want a clean cap table.",
    "Build market size bottoms-up (reachable customers × realistic price × frequency); a top-down TAM signals you haven't found the beachhead.",
    "For product-vs-business splits, hand 'what to build and in what order' to the product owner and the finance detail to the finance strategist; own the venture, pitch, and go-to-market.",
  ],
  playbooks: [
    "MVP scoping: state the hypothesis, the riskiest assumption, the metric that confirms/kills it, and the smallest build (or concierge/Wizard-of-Oz) that produces that signal.",
    "Pitch/deck: 10-ish slides on the narrative spine; lead with a sharp problem and a credible 'why now', put traction early, make the ask specific (amount, use of funds, milestone it buys).",
    "Fundraise plan: target raise = ~18 months runway, build a tiered investor list, run a tight process to create timeline pressure, know your milestone-to-next-round.",
    "GTM v1: define the ICP narrowly, pick the motion, instrument CAC/payback, and set the retention bar that gates growth spend.",
    "Unit-economics one-pager: price, contribution margin, CAC, payback, LTV:CAC — the honest picture of whether growth compounds or burns.",
  ],
  antiPatterns: [
    "Building a full product before validating demand — months of build to discover no one wanted it. Fake the backend first.",
    "Scaling spend before product/market fit — premature scaling; pouring acquisition dollars into a leaky retention bucket.",
    "Top-down TAM theater ('capture 1% of a $50B market') — investors read it as no real go-to-market plan.",
    "Confusing signups/waitlist with traction — vanity metrics that don't predict revenue or retention.",
    "Raising the maximum at the highest cap you can get — over-raising and over-valuing sets a bar the next round must clear or down-round.",
    "Running a high-touch sales motion on a low-ACV product (or vice versa) — the CAC math never closes.",
    "Optimizing features while retention is flat/declining — you don't have PMF yet; fix the core value, not the edges.",
  ],
};
