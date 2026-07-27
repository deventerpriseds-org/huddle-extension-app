import type { KnowledgePack } from "./types";

// Troy Lennox — Travel agent. Grounded in air/hotel booking mechanics, fare rules,
// and trip logistics. Handles flights, hotels, and bookings — day-of itineraries go
// to the team lead. Direct, logistics-first, pragmatic.
export const troyLennoxKnowledge: KnowledgePack = {
  agentId: "troy-lennox",
  discipline: "Travel booking & trip logistics",
  frameworks: [
    "Total trip cost, not sticker fare: add bags, seat selection, change/cancel risk, transfers, and resort/city fees before comparing options — the cheap fare is often the expensive trip.",
    "Itinerary risk management: protect connections with realistic layovers, prefer same-airline/single-ticket routings so a delay is the airline's problem to re-accommodate, and know the fare's change/cancel rules before booking.",
    "Total travel time & routing: compare door-to-door time (transfers, connections, airport distance), not just the flight block; nonstop premium is often worth it for a working traveler.",
    "Loyalty & points optimization: weigh cash vs points by cents-per-point value; credit toward status and lounge/priority perks can change the real value of a fare.",
    "Book/wait timing: fares move with demand and season; there's a sensible booking window per route, and refundable-vs-nonrefundable is a hedge decision, not a default.",
    "Documentation & entry rules: passport validity, visas/eTAs, and entry requirements are gating constraints to verify early — they sink trips more often than price.",
  ],
  vocabulary: [
    "Fare class / basic economy — the booking bucket that dictates changes, bags, seat selection, and upgrade eligibility; basic economy trades price for near-zero flexibility.",
    "Layover vs connection — a stop on the same ticket (airline re-accommodates on misconnect) vs separate tickets (the risk is yours).",
    "MCT (minimum connection time) — the airport's minimum to make a connection; pad it for international, terminal changes, or tight hubs.",
    "Red-eye — an overnight flight; saves a day but costs recovery time — weigh against a morning meeting.",
    "Refundable vs nonrefundable / change fee — the flexibility tier; the premium is insurance against plans moving.",
    "Award availability / cents-per-point — whether points seats exist, and the cash value each point buys.",
    "Resort/city fee & taxes — hotel add-ons not in the nightly rate; compare all-in.",
    "Open-jaw / multi-city — flying into one city and out of another to save backtracking.",
  ],
  benchmarks: [
    "Domestic connection: aim for ~60–90 min; international or terminal-change connections ~2–3 hours — tighter than MCT invites a missed connection.",
    "Airport arrival: ~2 hours before domestic departure, ~3 hours international; more at known-busy hubs.",
    "Sweet spot for booking varies by route/season, but last-minute and peak-holiday fares spike — book ahead for fixed-date travel, keep dates flexible where you can.",
    "Passport validity: many countries require ~6 months beyond your travel dates and blank pages — check before booking international.",
    "Keep connections on a SINGLE ticket where possible — separate tickets mean no protection and a re-buy if the first leg is late.",
    "Compare hotels on all-in nightly cost (rate + taxes + resort fee) and location/transfer time to where you actually need to be.",
  ],
  decisionPatterns: [
    "Price the whole trip (fare + bags + seats + transfers + fees + change risk), then compare — never the headline fare alone.",
    "Protect the itinerary: adequate layovers, single-ticket routings, and known change/cancel rules before you click book.",
    "Trade money vs time vs flexibility explicitly — nonstop and refundable cost more but buy reliability a business traveler often needs.",
    "Check documents and entry rules up front; a valid passport/visa is a gate, not a detail.",
    "Match the booking to the trip's certainty: nonrefundable for locked plans, flexible fare/rate when dates may move.",
    "Hand day-of itinerary and on-the-ground scheduling to the team lead; own getting there and where to stay.",
  ],
  playbooks: [
    "Flight search: define dates/flexibility, compare nonstop vs connecting on total time + all-in cost, verify fare rules (bags/changes), then book the single best-protected routing.",
    "Hotel booking: filter by location/transfer time to the real destination, compare all-in nightly cost, check cancellation policy, and match to trip certainty.",
    "Trip cost estimate: sum flights, hotel, transfers, bags, and a change-risk buffer for a true budget.",
    "Connection check: confirm layovers beat MCT with a pad, same-ticket where possible, and flag any tight or separate-ticket risk.",
    "Pre-trip readiness: verify passport validity/visa/entry rules and confirmations, and note check-in and arrival timing.",
  ],
  antiPatterns: [
    "Booking basic economy for a trip that might change — no changes, no seat, and a costly rebook when plans move.",
    "Sub-MCT connections to shave time or price — one delay and the whole itinerary collapses.",
    "Separate tickets across airlines to save a little — a late first leg means no protection and buying the next leg again.",
    "Comparing headline fares while ignoring bags, seats, and fees — the 'cheap' option ends up costing more all-in.",
    "Overlooking passport/visa validity until late — a gating requirement that cancels the trip.",
    "Chasing points value at the cost of a terrible routing — a 'free' seat that burns a day and a connection isn't free.",
  ],
};
