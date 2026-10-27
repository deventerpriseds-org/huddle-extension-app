// WHAT:       Proves the owner gets ONE 8am Iris brief when BOTH producers fire it: Huddle's own
//             scheduler and journey's Morning Kickstart window call land on the same turn id, and
//             the second enqueue is a no-op (no second turn, no second run = no second push).
// WHY:        Live rows, 2026-10-16..27: every weekday had TWO morning turns ~6 s apart --
//             `schedule-brief-morning-<date>-schedule-brief-u-<uuid>-<date>08` (scheduler) and
//             `schedule-brief-morning-<date>` (journey). The scheduler's generic per-slot runId was
//             appended to the key, so `ON CONFLICT (id) DO NOTHING` never saw a conflict.
// SUPERSEDES: nothing.
// SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   docs/qc-evidence/FIX-iris-morning-dedupe.md. Run: bun scripts/schedule-brief-dedupe.test.ts
//
// Section J is the pure key. Section K drives the REAL runScheduleBrief with only its outside world
// replaced: the calendar/task read (buildScheduleBrief), the identity lookup, the durable-turn table
// (an in-memory map with the SAME `ON CONFLICT (id) DO NOTHING` semantics as enqueueTurn) and the
// turn runner (which is what fires the push). The two request bodies are copied from the producers:
//   scheduler.server.ts fireJob:    {caller, timeZone, runId: `${job.id}-${slotKey}`}
//   journey iris-window.ts morning: {caller, timeZone}            (no window, no runId)

import { mock } from "bun:test";

let pass = 0,
  fail = 0;
const t = (name: string, got: unknown, want: unknown) => {
  const ok = String(got) === String(want);
  console.log(`  ${ok ? "✔" : "✘"} ${name}: ${got}${ok ? "" : `  (EXPECTED ${want})`}`);
  if (!ok) console.log(`  FAIL ${name}`);
  ok ? pass++ : fail++;
};

const TZ = "America/New_York";
const USER = "a89e3652-3ba0-407e-90c3-7b5c0c7b4cad";
const EMAIL = "dev@enterpriseds.io";
// 2026-10-26T12:00:02Z = 08:00:02 in New York, the real Huddle fire; journey's came 6 s later.
const HUDDLE_MS = Date.parse("2026-10-26T12:00:02Z");
const JOURNEY_MS = Date.parse("2026-10-26T12:00:08Z");
const SCHEDULER_RUN_ID = `schedule-brief-u-${USER}-2026102608`; // `${job.id}-${slotKey}`

// ---- the outside world ------------------------------------------------------------------------
const real = await import("../src/features/huddle/lib/tasks/schedule-brief.server");
mock.module("../src/features/huddle/lib/tasks/schedule-brief.server", () => ({
  ...real,
  buildScheduleBrief: async (o: { nowMs: number; edition?: "morning" | "evening"; window?: unknown }) => {
    const hour = real.localHour(o.nowMs, TZ);
    const edition = o.edition ?? real.editionForHour(hour);
    return {
      ok: true,
      edition,
      forDate: real.dateForEdition(edition, o.nowMs, TZ),
      tz: TZ,
      items: [],
      errors: [],
      tasks: [],
      upcoming: [],
      ...(o.window ? { window: o.window } : {}),
    };
  },
}));
const aliases: Record<string, string> = { "dev@enterpriseds.io": USER, "von.ellis@enterpriseds.io": USER };
mock.module("../src/features/huddle/lib/identity/identity.server", () => ({
  resolveScopeByEmail: async (e: string) => ({ userId: aliases[(e ?? "").toLowerCase()] ?? null, emails: [e] }),
}));
mock.module("../src/features/huddle/lib/journey/identity", () => ({
  resolveCalendarMailbox: async () => null,
}));
const table = new Map<string, unknown>(); // chat.pending_turns, keyed on id
const ran: string[] = []; // every runTurnById = one delivered message + its push
mock.module("../src/features/huddle/lib/tasks/turns.server", () => ({
  enqueueTurn: async (id: string, _h: string, _e: string | null, payload: unknown) => {
    if (table.has(id)) return false; // ON CONFLICT (id) DO NOTHING
    table.set(id, payload);
    return true;
  },
}));
mock.module("../src/features/huddle/lib/huddle.functions", () => ({
  runTurnById: async (id: string) => {
    ran.push(id);
  },
}));

const { runScheduleBrief, scheduleBriefTurnId } = await import(
  "../src/features/huddle/lib/tasks/schedule-brief-run.server"
);

// ---- J. the key -------------------------------------------------------------------------------
console.log("J. ONE KEY PER (owner, slot, date) — whichever producer asks");
{
  const owner = { userId: USER, email: EMAIL };
  const fromScheduler = scheduleBriefTurnId({ slot: "morning", forDate: "2026-10-26", owner, runId: SCHEDULER_RUN_ID });
  const fromJourney = scheduleBriefTurnId({ slot: "morning", forDate: "2026-10-26", owner });
  t("J1 scheduler and journey derive the SAME morning key", fromScheduler === fromJourney, true);
  t("J1b and it is owner-scoped", fromJourney, `schedule-brief-morning-2026-10-26-u-${USER}`);
  t(
    "J2 a manual re-run still gets a fresh key",
    scheduleBriefTurnId({ slot: "morning", forDate: "2026-10-26", owner, runId: "manual-20261026120501" }) !== fromJourney,
    true,
  );
  t(
    "J3 evening is a different key from morning",
    scheduleBriefTurnId({ slot: "evening", forDate: "2026-10-26", owner }) !== fromJourney,
    true,
  );
  t(
    "J4 a window is a different key from the morning brief",
    scheduleBriefTurnId({ slot: "window-business_hours", forDate: "2026-10-26", owner }) !== fromJourney,
    true,
  );
  t(
    "J5 another day is a different key",
    scheduleBriefTurnId({ slot: "morning", forDate: "2026-10-27", owner }) !== fromJourney,
    true,
  );
  t(
    "J6 another owner is a different key",
    scheduleBriefTurnId({ slot: "morning", forDate: "2026-10-26", owner: { userId: "someone-else", email: "x@y.z" } }) !== fromJourney,
    true,
  );
  t(
    "J7 unresolved owner falls back to the lower-cased email",
    scheduleBriefTurnId({ slot: "morning", forDate: "2026-10-26", owner: { userId: null, email: " Dev@EnterpriseDS.io " } }),
    "schedule-brief-morning-2026-10-26-e-dev@enterpriseds.io",
  );
}

// ---- K. the real runner, both producers, one message ------------------------------------------
console.log("K. BOTH 8am PRODUCERS → ONE TURN, ONE PUSH (the 2026-10-26 replay)");
{
  const huddle = await runScheduleBrief({ entra_email: EMAIL }, { timeZone: TZ, runId: SCHEDULER_RUN_ID, nowMs: HUDDLE_MS });
  const journey = await runScheduleBrief({ entra_email: EMAIL }, { timeZone: TZ, nowMs: JOURNEY_MS });
  t("K1 Huddle's scheduler fire delivers", huddle.delivered, true);
  t("K2 journey's window fire 6 s later is a no-op", journey.delivered, false);
  t("K3 exactly ONE morning turn row exists", [...table.keys()].filter((k) => k.startsWith("schedule-brief-morning-")).length, 1);
  t("K4 exactly ONE turn ran (one push)", ran.length, 1);
  t("K4b both runs still report ok", huddle.ok && journey.ok, true);

  // Reverse order: journey first wins and the scheduler is the no-op. Different date so the table is clean.
  const j2 = await runScheduleBrief({ entra_email: EMAIL }, { timeZone: TZ, nowMs: JOURNEY_MS + 86_400_000 - 10_000 });
  const h2 = await runScheduleBrief(
    { entra_email: EMAIL },
    { timeZone: TZ, runId: `schedule-brief-u-${USER}-2026102708`, nowMs: HUDDLE_MS + 86_400_000 },
  );
  t("K5 journey first: journey delivers", j2.delivered, true);
  t("K5b and the scheduler is the no-op", h2.delivered, false);
  t("K5c still one turn per day", ran.length, 2);

  // The von.ellis@ alias is the same owner: same key, still one message.
  const alias = await runScheduleBrief({ entra_email: "von.ellis@enterpriseds.io" }, { timeZone: TZ, nowMs: JOURNEY_MS });
  t("K6 the same owner under another sign-in email is a no-op too", alias.delivered, false);

  // Nothing else collapses: the evening edition and a window that same day each still send once.
  const evening = await runScheduleBrief(
    { entra_email: EMAIL },
    { timeZone: TZ, runId: `schedule-brief-u-${USER}-2026102620`, nowMs: Date.parse("2026-10-27T00:00:03Z") },
  );
  const win = await runScheduleBrief(
    { entra_email: EMAIL },
    { timeZone: TZ, nowMs: Date.parse("2026-10-26T15:00:07Z"), window: { name: "business_hours", start: 9, end: 17 } },
  );
  t("K7 the 8pm evening edition still delivers", evening.delivered, true);
  t("K8 a window brief the same day still delivers", win.delivered, true);
  const manual = await runScheduleBrief({ entra_email: EMAIL }, { timeZone: TZ, runId: "manual-20261026130000", nowMs: HUDDLE_MS });
  t("K9 a deliberate manual re-run still delivers", manual.delivered, true);
  t("K10 total runs = 2 mornings + evening + window + manual", ran.length, 5);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
