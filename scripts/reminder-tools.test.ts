// WHAT:       Offline proof of the reminder MANAGEMENT tools (list_reminders / cancel_reminder /
//             move_reminder): owner scoping, the refusal to mutate without a selector, the
//             ambiguity rule (candidates back, nothing changed), honest no-match / already-cancelled /
//             already-fired answers, idempotent retries, the per-turn claim, time-zone-correct
//             matching and moving (incl. DST), and the wiring into both text paths and voice NATIVE.
// WHY:        Before these, schedule_reminder was the only reminder tool, so "cancel the 2pm reminder"
//             could not be done. A wrong cancel/move is silent and expensive (an alarm that never
//             rings), so every guard here exists to stop a specific wrong write.
// SUPERSEDES: nothing.
// SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   docs/qc-evidence/BUILD-reminder-tools.md (results + mutation verdicts).
//
// OFFLINE ONLY: the store is an in-memory fake that mirrors the SQL predicates in turns.server.ts
// (owner email, status='pending'); the SQL text itself is pinned by the source checks at the bottom.
//
// Run: npm run test:reminder-tools

import { readFileSync } from "node:fs";
import {
  dispatchListReminders,
  dispatchCancelReminder,
  dispatchMoveReminder,
  matchReminders,
  resolveMoveDueMs,
  hasSelector,
  parseClock,
  zonedToUtcMs,
  localClock,
  LIST_REMINDERS_TOOL,
  CANCEL_REMINDER_TOOL,
  MOVE_REMINDER_TOOL,
  type ManagedReminder,
  type ReminderManageStore,
} from "../src/features/huddle/lib/tasks/reminders";

let pass = 0;
let fail = 0;
// "ok"/"not ok <name>" is load-bearing: scripts/mutate.sh attributes a mutation by `not ok .*<name>`.
const t = (name: string, got: unknown, want: unknown) => {
  const ok = String(got) === String(want);
  console.log(`  ${ok ? "ok" : "not ok"} ${name}: ${String(got)}${ok ? "" : `  (EXPECTED ${String(want)})`}`);
  ok ? pass++ : fail++;
};

const TZ = "America/New_York";
const OWNER = "Owner@Example.com";
const OTHER = "someone-else@example.com";
// 2026-11-04 12:00 EST (17:00 UTC). DST ended 2026-11-01, so New York is UTC-5.
const NOW = Date.UTC(2026, 10, 4, 17, 0);
const at = (y: number, mo: number, d: number, hh: number, mm = 0) => zonedToUtcMs(y, mo, d, hh, mm, TZ);

type Row = ManagedReminder & { email: string };

function fakeStore(rows: Row[]) {
  const calls = { list: 0, cancel: [] as string[], move: [] as Array<[string, number]> };
  const own = (r: Row, email: string) => r.email.toLowerCase() === email.toLowerCase();
  const store: ReminderManageStore = {
    async list(email, opts = {}) {
      calls.list++;
      const statuses = opts.statuses?.length ? opts.statuses : ["pending"];
      return rows
        .filter((r) => own(r, email) && statuses.includes(r.status) && r.due_ms >= (opts.sinceDueMs ?? 0))
        .sort((a, b) => a.due_ms - b.due_ms)
        .slice(0, opts.limit ?? 50)
        .map(({ email: _e, ...r }) => ({ ...r }));
    },
    async cancel(id, email) {
      calls.cancel.push(id);
      const r = rows.find((x) => x.id === id && own(x, email) && x.status === "pending");
      if (!r) return false;
      r.status = "cancelled";
      return true;
    },
    async move(id, email, due) {
      calls.move.push([id, due]);
      const r = rows.find((x) => x.id === id && own(x, email) && x.status === "pending");
      if (!r) return false;
      r.due_ms = due;
      return true;
    },
  };
  return { store, calls, rows };
}

function seed(): Row[] {
  return [
    { id: "r-dentist-2pm", email: OWNER, text: "Call the dentist", kind: "alarm", due_ms: at(2026, 11, 4, 14), status: "pending", task_id: null },
    { id: "r-water-3pm", email: OWNER, text: "Drink water", kind: "reminder", due_ms: at(2026, 11, 4, 15), status: "pending", task_id: null },
    { id: "r-dentist-tmrw", email: OWNER, text: "Dentist's appointment prep", kind: "alarm", due_ms: at(2026, 11, 5, 9), status: "pending", task_id: "task-1" },
    { id: "r-gym-cancelled", email: OWNER, text: "Gym session", kind: "alarm", due_ms: at(2026, 11, 4, 18), status: "cancelled", task_id: null },
    { id: "r-mail-fired", email: OWNER, text: "Check the mail", kind: "reminder", due_ms: at(2026, 11, 4, 10), status: "fired", task_id: null },
    { id: "r-other-2pm", email: OTHER, text: "Call the dentist", kind: "alarm", due_ms: at(2026, 11, 4, 14), status: "pending", task_id: null },
  ];
}

const deps = (store: ReminderManageStore, extra: Record<string, unknown> = {}) => ({
  store,
  resolveEmail: async () => OWNER,
  nowMs: NOW,
  ...extra,
});
const J = (s: string) => JSON.parse(s);

console.log("schemas");
t("list_reminders tool name", LIST_REMINDERS_TOOL.name, "list_reminders");
t("cancel_reminder tool name", CANCEL_REMINDER_TOOL.name, "cancel_reminder");
t("move_reminder tool name", MOVE_REMINDER_TOOL.name, "move_reminder");
t("cancel_reminder requires nothing at schema level (selector enforced in code)", CANCEL_REMINDER_TOOL.parameters.required.length, 0);

console.log("clock / tz helpers");
t("parseClock 2pm", parseClock("2pm"), "14:00");
t("parseClock 2:30 pm", parseClock("2:30 pm"), "14:30");
t("parseClock 12am", parseClock("12am"), "00:00");
t("parseClock 12pm", parseClock("12pm"), "12:00");
t("parseClock 14:00", parseClock("14:00"), "14:00");
t("parseClock rejects 25:00", parseClock("25:00"), null);
t("parseClock rejects 13pm", parseClock("13pm"), null);
t("DST: 09:00 NY on Oct 31 (EDT) is 13:00 UTC", new Date(zonedToUtcMs(2026, 10, 31, 9, 0, TZ)).toISOString(), "2026-10-31T13:00:00.000Z");
t("DST: 09:00 NY on Nov 2 (EST) is 14:00 UTC", new Date(zonedToUtcMs(2026, 11, 2, 9, 0, TZ)).toISOString(), "2026-11-02T14:00:00.000Z");
t("localClock of a 14:00 NY reminder", localClock(at(2026, 11, 4, 14), TZ), "14:00");

console.log("selector guard");
t("no selector: {}", hasSelector({}), false);
t("no selector: stopwords only ('my reminder')", hasSelector({ about: "my reminder" }), false);
t("selector: about dentist", hasSelector({ about: "dentist" }), true);
t("selector: currently_at", hasSelector({ currently_at: "14:00" }), true);
t("selector: reminder_id", hasSelector({ reminder_id: "x" }), true);
{
  const { store, calls } = fakeStore(seed());
  const out = J(await dispatchCancelReminder({}, { about: "the reminder" }, TZ, deps(store)));
  t("cancel without a real selector is refused", out.error, "missing_selector");
  t("cancel without a selector never touches the store", calls.cancel.length + calls.list, 0);
}
{
  const { store, calls } = fakeStore(seed());
  const out = J(await dispatchMoveReminder({}, { to_time: "16:00" }, TZ, deps(store)));
  t("move without a selector is refused", out.error, "missing_selector");
  t("move without a selector never touches the store", calls.move.length + calls.list, 0);
}

console.log("owner scoping");
{
  const { store, calls } = fakeStore(seed());
  const out = J(await dispatchCancelReminder({}, { about: "dentist" }, TZ, { store, resolveEmail: async () => null, nowMs: NOW }));
  t("no resolvable owner → no_owner", out.error, "no_owner");
  t("no owner → store never read", calls.list, 0);
}
{
  const { store } = fakeStore(seed());
  const out = J(await dispatchListReminders({}, {}, TZ, deps(store)));
  t("list shows only the owner's PENDING reminders", out.count, 3);
  t("list never includes another user's row", out.reminders.some((r: { id: string }) => r.id === "r-other-2pm"), false);
  t("list is soonest first", out.reminders.map((r: { id: string }) => r.id).join(","), "r-dentist-2pm,r-water-3pm,r-dentist-tmrw");
  t("list reports times in the owner's zone", out.reminders[0].due_local, "Wed, Nov 4, 2:00 PM");
  t("list reports the time zone it used", out.time_zone, TZ);
  t("list flags a task-linked reminder", out.reminders[2].task_linked, true);
}
{
  const { store } = fakeStore(seed());
  const out = J(await dispatchListReminders({}, { kind: "alarm" }, TZ, deps(store)));
  t("list kind=alarm filters", out.count, 2);
  const lim = J(await dispatchListReminders({}, { limit: 1 }, TZ, deps(store)));
  t("list limit truncates and says so", `${lim.reminders.length}/${lim.count}/${lim.truncated}`, "1/3/true");
  const none = J(await dispatchListReminders({}, { about: "zebra" }, TZ, deps(store)));
  t("list with no match is an honest empty", `${none.count}|${none.message}`, "0|No upcoming reminders or alarms match.");
}

console.log("matching");
{
  const rows = seed().filter((r) => r.email === OWNER && r.status === "pending");
  t("about 'dentist' matches BOTH dentist reminders (prefix: dentist's)", matchReminders(rows, { about: "dentist" }, TZ).kind, "many");
  t("about 'dentist' + currently_at 2pm narrows to one", matchReminders(rows, { about: "dentist", currently_at: "2pm" }, TZ).matches[0]?.id, "r-dentist-2pm");
  t("currently_at compares in OWNER tz (14:00 NY hits)", matchReminders(rows, { currently_at: "14:00" }, TZ).kind, "one");
  t("currently_at compares in OWNER tz (in UTC, 14:00 is the OTHER reminder: 9am NY on Nov 5)", matchReminders(rows, { currently_at: "14:00" }, "UTC").matches.map((r) => r.id).join(","), "r-dentist-tmrw");
  t("on_date in owner tz", matchReminders(rows, { about: "dentist", on_date: "2026-11-05" }, TZ).matches[0]?.id, "r-dentist-tmrw");
  t("about needs EVERY word", matchReminders(rows, { about: "dentist water" }, TZ).kind, "none");
  t("kind constraint is ANDed", matchReminders(rows, { about: "water", kind: "alarm" }, TZ).kind, "none");
}

console.log("cancel");
{
  const { store, calls } = fakeStore(seed());
  const out = J(await dispatchCancelReminder({}, { about: "dentist" }, TZ, deps(store)));
  t("ambiguous cancel → error ambiguous", out.error, "ambiguous");
  t("ambiguous cancel returns the candidates", out.candidates.length, 2);
  t("ambiguous cancel changes NOTHING", calls.cancel.length, 0);
}
{
  const { store, calls, rows } = fakeStore(seed());
  const out = J(await dispatchCancelReminder({}, { currently_at: "14:00" }, TZ, deps(store)));
  t("cancel the 2pm one → cancelled:true changed:true", `${out.cancelled}/${out.changed}`, "true/true");
  t("cancel targeted the owner's 2pm id", calls.cancel.join(","), "r-dentist-2pm");
  t("another user's identical 2pm reminder is untouched", rows.find((r) => r.id === "r-other-2pm")?.status, "pending");
  const again = J(await dispatchCancelReminder({}, { currently_at: "14:00", about: "dentist" }, TZ, deps(store)));
  t("retry of the same cancel is idempotent (already cancelled, changed:false)", `${again.ok}/${again.changed}/${again.already}`, "true/false/cancelled");
  t("idempotent retry does not write again", calls.cancel.length, 1);
}
{
  const { store, calls } = fakeStore(seed());
  const out = J(await dispatchCancelReminder({}, { about: "zebra" }, TZ, deps(store)));
  t("cancel with no match is an honest no_match", `${out.error}/${out.changed}`, "no_match/false");
  t("no_match writes nothing", calls.cancel.length, 0);
}
{
  const { store, calls } = fakeStore(seed());
  const out = J(await dispatchCancelReminder({}, { about: "mail" }, TZ, deps(store)));
  t("cancel of an already-FIRED reminder → not_pending", out.error, "not_pending");
  t("fired reminder is never written", calls.cancel.length, 0);
}
{
  const { store, calls } = fakeStore(seed());
  const claimed = new Set<string>(["cancel_reminder:r-water-3pm"]);
  const claim = (k: string) => (claimed.has(k) ? false : (claimed.add(k), true));
  const out = J(await dispatchCancelReminder({}, { about: "water" }, TZ, deps(store, { claim })));
  t("a second agent in the same turn is deduped by the ledger", `${out.deduped}/${out.changed}`, "true/false");
  t("deduped cancel never writes", calls.cancel.length, 0);
  const keys: string[] = [];
  await dispatchCancelReminder({}, { about: "dentist", on_date: "2026-11-05" }, TZ, deps(store, { claim: (k: string) => (keys.push(k), true) }));
  t("cancel claims `cancel_reminder:<id>`", keys.join(","), "cancel_reminder:r-dentist-tmrw");
}
{
  // Lost race: matched as pending, but the per-minute drain fired it before our UPDATE.
  const { store, rows } = fakeStore(seed());
  const racing: ReminderManageStore = {
    ...store,
    async cancel(id) {
      const r = rows.find((x) => x.id === id)!;
      r.status = "fired";
      return false;
    },
  };
  const out = J(await dispatchCancelReminder({}, { about: "water" }, TZ, deps(racing)));
  t("cancel that loses the race to the drain says it already went off", out.error, "not_pending");
}

console.log("move");
{
  const { store, calls } = fakeStore(seed());
  const out = J(await dispatchMoveReminder({}, { currently_at: "14:00", to_time: "16:00" }, TZ, deps(store)));
  t("move 2pm → 4pm moved:true changed:true", `${out.moved}/${out.changed}`, "true/true");
  t("move lands at 16:00 in the OWNER's zone (21:00 UTC)", new Date(calls.move[0]?.[1] ?? 0).toISOString(), "2026-11-04T21:00:00.000Z");
  t("move reports old and new local times", `${out.previous_due_local} -> ${out.reminder.due_local}`, "Wed, Nov 4, 2:00 PM -> Wed, Nov 4, 4:00 PM");
  const again = J(await dispatchMoveReminder({}, { reminder_id: "r-dentist-2pm", to_time: "16:00" }, TZ, deps(store)));
  t("retry of the same move is idempotent (changed:false, no second write)", `${again.changed}/${calls.move.length}`, "false/1");
}
{
  const { store, calls } = fakeStore(seed());
  const out = J(await dispatchMoveReminder({}, { about: "dentist", to_time: "16:00" }, TZ, deps(store)));
  t("ambiguous move → candidates, nothing moved", `${out.error}/${out.candidates.length}/${calls.move.length}`, "ambiguous/2/0");
}
{
  const { store } = fakeStore(seed());
  const out = J(await dispatchMoveReminder({}, { about: "gym", to_time: "19:00" }, TZ, deps(store)));
  t("move of a CANCELLED reminder → not_pending (never resurrected)", out.error, "not_pending");
}
{
  const { store } = fakeStore(seed());
  const out = J(await dispatchMoveReminder({}, { about: "water" }, TZ, deps(store)));
  t("move with no new time → missing_new_time", out.error, "missing_new_time");
  const c = J(await dispatchMoveReminder({}, { about: "water", to_time: "16:00", shift_minutes: 30 }, TZ, deps(store)));
  t("move with two new times → conflicting_new_time", c.error, "conflicting_new_time");
}
const cur = at(2026, 11, 4, 14);
t("shift_minutes 30 → 14:30", localClock((resolveMoveDueMs(cur, { shift_minutes: 30 }, TZ, NOW) as { dueMs: number }).dueMs, TZ), "14:30");
t("delay_minutes 20 → now+20", (resolveMoveDueMs(cur, { delay_minutes: 20 }, TZ, NOW) as { dueMs: number }).dueMs, NOW + 20 * 60_000);
t("to_time already past today (09:00, no date) rolls to tomorrow", new Date((resolveMoveDueMs(cur, { to_time: "09:00" }, TZ, NOW) as { dueMs: number }).dueMs).toISOString(), "2026-11-05T14:00:00.000Z");
t("explicit past to_date is refused", (resolveMoveDueMs(cur, { to_time: "09:00", to_date: "2026-11-03" }, TZ, NOW) as { error: string }).error, "time_in_past");
t("shift into the past is refused", (resolveMoveDueMs(cur, { shift_minutes: -300 }, TZ, NOW) as { error: string }).error, "time_in_past");
t("delay_minutes 0 is refused", (resolveMoveDueMs(cur, { delay_minutes: 0 }, TZ, NOW) as { error: string }).error, "time_in_past");
{
  const { store } = fakeStore(seed());
  const keys: string[] = [];
  await dispatchMoveReminder({}, { about: "water", shift_minutes: 15 }, TZ, deps(store, { claim: (k: string) => (keys.push(k), true) }));
  t("move claims `move_reminder:<id>`", keys.join(","), "move_reminder:r-water-3pm");
}

console.log("source pins (SQL + wiring)");
const turns = readFileSync("src/features/huddle/lib/tasks/turns.server.ts", "utf8");
const fnBody = (src: string, name: string) => {
  const i = src.indexOf(`export async function ${name}(`);
  if (i < 0) return "";
  const j = src.indexOf("\nexport ", i + 10);
  return src.slice(i, j < 0 ? undefined : j);
};
const OWNER_PENDING = /lower\(coalesce\(user_email, ''\)\) = lower\(\$2\) AND status = 'pending'/;
t("SQL: cancelOwnedReminder is owner- AND pending-scoped", OWNER_PENDING.test(fnBody(turns, "cancelOwnedReminder")), true);
t("SQL: moveOwnedReminder is owner- AND pending-scoped", OWNER_PENDING.test(fnBody(turns, "moveOwnedReminder")), true);
t("SQL: listRemindersForOwner is owner-scoped", /lower\(coalesce\(user_email, ''\)\) = lower\(\$1\)/.test(fnBody(turns, "listRemindersForOwner")), true);

const hf = readFileSync("src/features/huddle/lib/huddle.functions.ts", "utf8");
const count = (s: string, needle: string) => s.split(needle).length - 1;
t("text: cancel passes claimAction in BOTH paths", count(hf.replace(/\s+/g, " "), "dispatchCancelReminder(data.caller, ") >= 2 && /dispatchCancelReminder\([^)]*\{\s*claim: claimAction/.test(hf), true);
t("text: move passes claimAction in BOTH paths", count(hf.replace(/\s+/g, " "), "dispatchMoveReminder(data.caller, ") >= 2 && /dispatchMoveReminder\([^)]*\{\s*claim: claimAction/.test(hf), true);
t("text: OpenAI toolset offers all three", ["LIST_REMINDERS_TOOL,", "CANCEL_REMINDER_TOOL,", "MOVE_REMINDER_TOOL,"].every((n) => hf.includes(`          ${n}`)), true);
t("text: Lovable path registers all three", ["lovableTools.list_reminders", "lovableTools.cancel_reminder", "lovableTools.move_reminder"].every((n) => hf.includes(n)), true);

const rt = readFileSync("src/features/huddle/lib/voice/realtime-tools.server.ts", "utf8");
const nativeAt = rt.indexOf("const NATIVE = new Set([");
const nativeBlock = nativeAt < 0 ? "" : rt.slice(nativeAt, rt.indexOf("]", nativeAt) + 1);
t("voice: all three are in the NATIVE set (never proxied to journey)", ['"list_reminders"', '"cancel_reminder"', '"move_reminder"'].every((n) => nativeBlock.includes(n)), true);
t("voice: all three are offered by buildRealtimeToolset", ["    LIST_REMINDERS_TOOL,", "    CANCEL_REMINDER_TOOL,", "    MOVE_REMINDER_TOOL,"].every((n) => rt.includes(n)), true);
t("voice: all three have a dispatch branch", ['name === "list_reminders"', 'name === "cancel_reminder"', 'name === "move_reminder"'].every((n) => rt.includes(n)), true);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
