// Offline unit test for the confirm-ask 45–90 min spacing fan-out (autowork.server.ts).
// Run with:  bun scripts/confirm-spacing.test.ts   (bun tolerates the transitive deps tsx can't)
// Proves: consecutive armed asks are spaced 45–90 min WITHIN a window, every armed instant lands INSIDE
// a fan-out window, and roll-over (dinner gap / overnight) advances to the next valid window.

import { nextSpacedFanSlotIso, insideFanWindow } from "../src/features/huddle/lib/tasks/autowork.server";

const TZ = "America/New_York";
const WINDOWS = [
  { start: 9, end: 18 },
  { start: 20, end: 22 },
];
const GAP_MIN_MS = 45 * 60_000;
const GAP_MAX_MS = 90 * 60_000;

let failures = 0;
const check = (cond: boolean, msg: string) => {
  if (!cond) {
    failures++;
    console.error("  ✗ " + msg);
  }
};

// Local (tz) clock parts for an instant → identify which window/day a slot belongs to.
function localParts(d: Date): { day: string; minutes: number; hour: number } {
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(d);
  const o: Record<string, string> = {};
  for (const x of p) if (x.type !== "literal") o[x.type] = x.value;
  let h = Number(o.hour);
  if (h === 24) h = 0;
  return { day: `${o.year}-${o.month}-${o.day}`, minutes: h * 60 + Number(o.minute), hour: h };
}
function windowOf(minutes: number): number {
  return WINDOWS.findIndex((w) => minutes >= w.start * 60 && minutes < w.end * 60);
}

// ── Test 1: sequential arming from mid-window — invariants over many random runs ──────────────────
console.log("Test 1: 20 sequential asks, 200 random runs — spacing + in-window invariants");
const allGaps: number[] = [];
let rollovers = 0;
for (let run = 0; run < 200; run++) {
  let prev = new Date("2026-06-15T13:00:00-04:00"); // 1:00pm ET, inside business window
  for (let i = 0; i < 20; i++) {
    const slotIso = nextSpacedFanSlotIso(prev, TZ, WINDOWS, GAP_MIN_MS, GAP_MAX_MS);
    const slot = new Date(slotIso);
    check(insideFanWindow(slot, TZ, WINDOWS), `run${run} ask${i}: slot ${slotIso} not inside any window`);
    check(slot.getTime() > prev.getTime(), `run${run} ask${i}: slot not strictly after prev`);
    const pp = localParts(prev);
    const sp = localParts(slot);
    const sameWindow = pp.day === sp.day && windowOf(pp.minutes) === windowOf(sp.minutes) && windowOf(pp.minutes) >= 0;
    const gapMin = (slot.getTime() - prev.getTime()) / 60_000;
    if (sameWindow) {
      allGaps.push(gapMin);
      check(gapMin >= 45 - 1e-6 && gapMin <= 90 + 1e-6, `run${run} ask${i}: same-window gap ${gapMin.toFixed(1)}m not in [45,90]`);
    } else {
      rollovers++;
      // rolled to a later window/day: must be a valid window and later in wall-clock
      check(windowOf(sp.minutes) >= 0, `run${run} ask${i}: rolled slot not in a window`);
    }
    prev = slot;
  }
}
check(allGaps.length > 0, "no same-window gaps observed at all (spacing never exercised)");
check(new Set(allGaps.map((g) => Math.round(g))).size > 5, "gaps show no variability — not randomized");
check(rollovers > 0, "no roll-overs exercised across 200×20 asks (window never filled)");
console.log(`  same-window gaps: n=${allGaps.length}, min=${Math.min(...allGaps).toFixed(1)}m, max=${Math.max(...allGaps).toFixed(1)}m, distinct≈${new Set(allGaps.map((g)=>Math.round(g))).size}; rollovers=${rollovers}`);

// ── Test 2: dinner-gap roll-over (18–20) ──────────────────────────────────────────────────────────
console.log("Test 2: an ask landing in the 18–20 dinner gap rolls into the evening window");
for (let run = 0; run < 100; run++) {
  const prev = new Date("2026-06-15T17:50:00-04:00"); // 5:50pm → +45–90 lands 18:35–19:20 (dinner gap)
  const slot = new Date(nextSpacedFanSlotIso(prev, TZ, WINDOWS, GAP_MIN_MS, GAP_MAX_MS));
  const sp = localParts(slot);
  check(insideFanWindow(slot, TZ, WINDOWS), `run${run}: dinner-gap slot ${slot.toISOString()} not in a window`);
  check(sp.hour >= 20 && sp.hour < 22, `run${run}: expected evening window, got hour ${sp.hour}`);
}

// ── Test 3: overnight roll-over (after 22 → next day 9–18) ─────────────────────────────────────────
console.log("Test 3: an ask after 22:00 rolls to the first window next day");
for (let run = 0; run < 100; run++) {
  const prev = new Date("2026-06-15T21:50:00-04:00"); // 9:50pm → +45–90 lands 22:35–23:20 (after 22)
  const slot = new Date(nextSpacedFanSlotIso(prev, TZ, WINDOWS, GAP_MIN_MS, GAP_MAX_MS));
  const sp = localParts(slot);
  check(insideFanWindow(slot, TZ, WINDOWS), `run${run}: overnight slot not in a window`);
  check(sp.hour >= 9 && sp.hour < 18, `run${run}: expected next-day business window, got hour ${sp.hour}`);
  check(sp.day === "2026-06-16", `run${run}: expected next local day 2026-06-16, got ${sp.day}`);
}

// ── Test 4: no-windows degrade (never throws, returns a gap-later instant) ─────────────────────────
console.log("Test 4: empty window list degrades to a gap-later instant without throwing");
{
  const prev = new Date("2026-06-15T13:00:00-04:00");
  const slot = new Date(nextSpacedFanSlotIso(prev, TZ, [], GAP_MIN_MS, GAP_MAX_MS));
  check(slot.getTime() > prev.getTime(), "empty-windows slot not after prev");
}

if (failures === 0) {
  console.log("\nALL PASS ✓");
} else {
  console.error(`\n${failures} CHECK(S) FAILED ✗`);
  process.exit(1);
}
