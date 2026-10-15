// WHAT:       Offline tests for PUSH into This Week (push.server.ts's pure half) and the agents' work
//             order (scoring.ts orderForAutowork).
// WHY:        Owner 2026-10-15: option C with guardrails + decision A (the groom no longer stars). A push
//             writes the star journey's 1am scheduler acts on, so who gets picked, when a push refills,
//             and what is never touched are each pinned here.
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   docs/AC-category-push.md (AC-C2..C11, AC-R*, AC-T*, AC-X5/X8).
//
// Run:  bun scripts/category-push.test.ts

import { readFileSync } from "node:fs";
import {
  classifyActiveEvent,
  inNode,
  mergeJourneyRow,
  reconcileMayUnpush,
  RECONCILE_SETTLE_MS,
  isPushEligible,
  parseNodeId,
  pickForNode,
  PUSH_RANK,
  type PushNode,
} from "../src/features/huddle/lib/tasks/push.server";
import { orderForAutowork } from "../src/features/huddle/lib/tasks/scoring";
import type { PushCandidateRow } from "../src/features/huddle/lib/tasks/tasks.server";

let pass = 0,
  fail = 0;
function check(label: string, cond: boolean, detail: string) {
  console.log(`  ${cond ? "PASS" : "FAIL"} ${label} — ${detail}`);
  cond ? pass++ : fail++;
}

const NOW = new Date("2026-10-15T15:00:00Z");
const row = (o: Partial<PushCandidateRow> & { id: string }): PushCandidateRow => ({
  title: o.id,
  status: "TODO",
  priority: "MEDIUM",
  category: "CAREER",
  is_priority: false,
  priority_rank: null,
  due_date: null,
  pushed_count: 0,
  created_at: "2026-09-01T00:00:00Z",
  completed_at: null,
  tags: [],
  ...o,
});
const CAREER: PushNode = { kind: "category", key: "CAREER" };
const LIFE: PushNode = { kind: "category", key: "LIFE" };

// ── node ids ─────────────────────────────────────────────────────────────────────────────────────
{
  const c = parseNodeId("category:CAREER");
  const u = parseNodeId("category:UNCATEGORISED");
  const t = parseNodeId("6658cd7e-1111-2222-3333-444455556666");
  check("node ids: a category root, a journey topic id, and NO push for Uncategorised",
    c?.kind === "category" && (c as { key: string }).key === "CAREER" && t?.kind === "topic" && u === null,
    JSON.stringify({ c, t, u }));
}

// ── eligibility (AC-C2, AC-C4, AC-N4) ────────────────────────────────────────────────────────────
{
  const cases: [string, PushCandidateRow, boolean][] = [
    ["open TODO", row({ id: "ok" }), true],
    ["DONE", row({ id: "d", status: "DONE" }), false],
    ["BLOCKED", row({ id: "b", status: "blocked" }), false],
    ["reopened with a stale completed_at (journey would never schedule it)", row({ id: "c", completed_at: "2026-09-01T00:00:00Z" }), false],
    ["parked", row({ id: "p", tags: ["Parking-Lot"] }), false],
    ["already starred (a push never rewrites someone else's star)", row({ id: "s", is_priority: true }), false],
  ];
  const window = new Set(["r"]);
  const bad = cases.filter(([, r, want]) => isPushEligible(r, window) !== want).map(([n]) => n);
  check("eligibility: excludes DONE, BLOCKED, completed_at, parked and already-starred", bad.length === 0, bad.join(", ") || "all 6 cases as expected");
  check("eligibility: a task waiting on a scheduled reminder is not picked",
    !isPushEligible(row({ id: "r" }), window), "reminder-window id excluded");
}

// ── VERIFY-category-push-1 fixes ─────────────────────────────────────────────────────────────────
{
  // D3: only statuses journey's 1am scheduler places, and never its own "Test Task" exclusion.
  const ok = ["READY", "UP_NEXT", "TODO", "BACKLOG"].every((st) => isPushEligible(row({ id: st, status: st })));
  const no = ["DOING", "IN_REVIEW", "PLANNING"].filter((st) => isPushEligible(row({ id: st, status: st })));
  check("D3: eligible only in a status the 1am scheduler places (READY/UP_NEXT/TODO/BACKLOG)",
    ok && no.length === 0, no.length ? `wrongly eligible: ${no.join(",")}` : "4 placeable, DOING/IN_REVIEW/PLANNING excluded");
  check("D3: a 'Test Task' title is never starred (journey's scheduler drops it)",
    !isPushEligible(row({ id: "tt", title: "Test Task foo" })), "excluded");
  const mix = [
    row({ id: "rev", status: "IN_REVIEW", priority: "URGENT" }),
    row({ id: "doing", status: "DOING", priority: "HIGH" }),
    row({ id: "tt", title: "Test Task foo", priority: "URGENT" }),
    row({ id: "back", status: "BACKLOG", priority: "LOW" }),
  ];
  check("D3: the verifier's failing input now picks the BACKLOG task",
    pickForNode(mix, CAREER, { now: NOW })?.id === "back", `picked ${pickForNode(mix, CAREER, { now: NOW })?.id}`);

  // D2: a stale "not starred" delivered late must not cancel the push; a fresh un-star still does.
  const since = "2026-10-15T15:00:00Z";
  const stale = row({ id: "a", is_priority: false, updated_at: "2026-10-15T14:59:00Z" });
  const fresh = row({ id: "a", is_priority: false, updated_at: "2026-10-15T15:01:00Z" });
  check("D2: an un-star event OLDER than the push is ignored; a newer one ends the push",
    classifyActiveEvent("UPDATE", stale, CAREER, since) === "none" && classifyActiveEvent("UPDATE", fresh, CAREER, since) === "unpush",
    `stale -> ${classifyActiveEvent("UPDATE", stale, CAREER, since)}, fresh -> ${classifyActiveEvent("UPDATE", fresh, CAREER, since)}`);
}

// ── VERIFY-category-push-2 fixes ─────────────────────────────────────────────────────────────────
{
  // N1: journey's single-task read returns NO category / tags / completed_at. Classifying that bare row
  // made every category push look "moved category" and refill every tick (3 ticks -> T,U,V starred).
  const mirror = row({ id: "T", category: "CAREER", is_priority: true, priority_rank: 0 });
  const journeyBare = { id: "T", title: "T", priority: "MEDIUM", due_date: null, status: "TODO", is_priority: true, priority_rank: 0, pushed_count: 0 };
  const steady = mergeJourneyRow(mirror, journeyBare);
  check("N1: a steady-state category push reconciles to NO write (category comes from the mirror)",
    classifyActiveEvent("UPDATE", steady, CAREER) === "none", `-> ${classifyActiveEvent("UPDATE", steady, CAREER)} (category ${steady.category})`);
  check("N1: the bare journey row ALONE would have refilled — the defect this guards",
    classifyActiveEvent("UPDATE", journeyBare as unknown as PushCandidateRow, CAREER) === "refill", "bare row has no category");
  const lostDone = mergeJourneyRow(mirror, { ...journeyBare, status: "DONE" });
  const lostUnstar = mergeJourneyRow(mirror, { ...journeyBare, is_priority: false });
  check("N1: a lost 'done' or 'un-star' is still caught — status and star come from JOURNEY",
    classifyActiveEvent("UPDATE", lostDone, CAREER) === "refill" && classifyActiveEvent("UPDATE", lostUnstar, CAREER) === "unpush",
    `done -> ${classifyActiveEvent("UPDATE", lostDone, CAREER)}, unstar -> ${classifyActiveEvent("UPDATE", lostUnstar, CAREER)}`);

  // N2: node-postgres hands priority_push.updated_at back as a Date; Date.parse(Date) drops milliseconds.
  const since = new Date("2026-10-15T20:00:00.900Z");
  const sameSecondStale = row({ id: "a", is_priority: false, updated_at: "2026-10-15T20:00:00.500123+00:00" });
  check("N2: a same-second stale un-star is ignored when `since` is a real Date with milliseconds",
    classifyActiveEvent("UPDATE", sameSecondStale, CAREER, since) === "none", `-> ${classifyActiveEvent("UPDATE", sameSecondStale, CAREER, since)}`);
}

// ── VERIFY-category-push-3 fixes ─────────────────────────────────────────────────────────────────
{
  // N3: a reconcile tick that reads journey while the star write is still in flight sees "not starred".
  const now = Date.parse("2026-10-15T21:00:00Z");
  const justMoved = new Date(now - 5_000);
  const settled = new Date(now - RECONCILE_SETTLE_MS - 1);
  check("N3: reconcile will not un-push a push that moved seconds ago (star may be in flight); it will once settled",
    !reconcileMayUnpush(justMoved, now) && reconcileMayUnpush(settled, now),
    `5s ago -> ${reconcileMayUnpush(justMoved, now)}, settled -> ${reconcileMayUnpush(settled, now)}`);
}

// ── picking (AC-C3, C5, C7, C10, C11) ────────────────────────────────────────────────────────────
{
  // Alphabetical order and score order DISAGREE: "aaa" sorts first by title, "zzz" is URGENT + due soon.
  const rows = [
    row({ id: "aaa", title: "aaa", priority: "LOW" }),
    row({ id: "zzz", title: "zzz", priority: "URGENT", due_date: "2026-10-16" }),
    row({ id: "mid", title: "mid", priority: "MEDIUM" }),
  ];
  check("pick: the BEST task by the scorer, not the first alphabetically",
    pickForNode(rows, CAREER, { now: NOW })?.id === "zzz", `picked ${pickForNode(rows, CAREER, { now: NOW })?.id}`);

  const withStar = [row({ id: "top", priority: "URGENT", is_priority: true }), ...rows];
  check("pick: an already-starred task is skipped, the next best is starred (AC-C7)",
    pickForNode(withStar, CAREER, { now: NOW })?.id === "zzz", `picked ${pickForNode(withStar, CAREER, { now: NOW })?.id}`);

  check("pick: `skip` drops the task that just finished, so a refill never re-picks it",
    pickForNode(rows, CAREER, { now: NOW, skip: "zzz" })?.id === "mid", `picked ${pickForNode(rows, CAREER, { now: NOW, skip: "zzz" })?.id}`);

  // Full ties — identical except id — must pick the same id whatever order the database returned.
  const ties = ["t3", "t1", "t2"].map((id) => row({ id, title: "Prepare my office camera quality" }));
  const picks = new Set<string>();
  for (let i = 0; i < 30; i++) {
    const shuffled = [...ties].sort(() => Math.random() - 0.5);
    picks.add(pickForNode(shuffled, CAREER, { now: NOW })?.id ?? "none");
  }
  check("pick: deterministic over full ties (duplicate titles), any input order (AC-C10)",
    picks.size === 1, `distinct picks over 30 shuffles: ${[...picks].join(",")}`);

  const life = [row({ id: "personal", category: "PERSONAL" }), row({ id: "career", category: "CAREER" })];
  check("pick: a LIFE push can pick a PERSONAL task (journey's own fold), never a CAREER one (AC-C11)",
    pickForNode(life, LIFE, { now: NOW })?.id === "personal", `picked ${pickForNode(life, LIFE, { now: NOW })?.id}`);

  check("pick: membership is the task's OWN category — the hours journey will schedule it in",
    inNode(row({ id: "x", category: "VENTURES" }), CAREER) === false && inNode(row({ id: "y", category: "career" }), CAREER) === true,
    "VENTURES task not in CAREER; lowercase 'career' is");

  const topic: PushNode = { kind: "topic", topicId: "t-sdl" };
  const tRows = [row({ id: "in", priority: "LOW" }), row({ id: "out", priority: "URGENT" })];
  check("pick: a TOPIC push picks only tasks journey links to that topic",
    pickForNode(tRows, topic, { topicTaskIds: new Set(["in"]), now: NOW })?.id === "in" &&
      pickForNode(tRows, topic, { now: NOW }) === null,
    "linked task picked; with no link list, nothing is guessed");

  check("pick: nothing eligible -> null (the push WAITS, nothing is starred) (AC-C8)",
    pickForNode([row({ id: "d", status: "DONE" })], CAREER, { now: NOW }) === null, "null");
}

// ── refill classification (AC-R1, R4, R10-R14) ───────────────────────────────────────────────────
{
  const live = row({ id: "a", is_priority: true });
  const cases: [string, string, PushCandidateRow | null, PushNode, string][] = [
    ["DONE from any surface", "UPDATE", { ...live, status: "DONE" }, CAREER, "refill"],
    ["deleted", "DELETE", null, CAREER, "refill"],
    ["BLOCKED", "UPDATE", { ...live, status: "BLOCKED" }, CAREER, "refill"],
    ["parked", "UPDATE", { ...live, tags: ["parking-lot"] }, CAREER, "refill"],
    ["moved to another category", "UPDATE", { ...live, category: "VENTURES" }, CAREER, "refill"],
    ["the user took the star off", "UPDATE", { ...live, is_priority: false }, CAREER, "unpush"],
    ["Huddle's own star write echoing back", "UPDATE", live, CAREER, "none"],
    ["a topic push ignores the task's category", "UPDATE", { ...live, category: "VENTURES" }, { kind: "topic", topicId: "t" }, "none"],
  ];
  const bad = cases.filter(([, op, r, n, want]) => classifyActiveEvent(op, r, n) !== want).map(([name, op, r, n]) => `${name} -> ${classifyActiveEvent(op, r, n)}`);
  check("refill: finished / deleted / blocked / parked / moved refill; un-starred un-pushes; the echo does nothing",
    bad.length === 0, bad.join("; ") || "all 8 cases as expected");
}

// ── the star itself (AC-T1, OQ-1) ────────────────────────────────────────────────────────────────
check("star rank is 0 — ahead of every other star in journey's 1am placement (priority_rank ?? 9999)",
  PUSH_RANK === 0, `PUSH_RANK=${PUSH_RANK}`);

// ── agents' work order (decision A) ──────────────────────────────────────────────────────────────
{
  // The star must win ON ITS OWN, not only through scoreTask's +15. "urgent" below out-scores a NULL-rank
  // (phone-style) star — URGENT 4 + due within 48h 5 + payment keyword 5 + created yesterday 2 + UP_NEXT 1
  // + pushed once 1 = 18 vs the star's LOW 1 + 15 = 16 — so only the explicit star key keeps it first.
  // (With a fixture the score alone decides, a mutation dropping that key was INERT.) Real-clock dates,
  // because scoreTask reads Date.now() for "due soon" and "recently created".
  const day = 24 * 60 * 60 * 1000;
  const tomorrow = new Date(Date.now() + day).toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - day).toISOString();
  const rows = [
    row({ id: "recent-low", priority: "LOW" }),
    row({ id: "urgent", title: "Pay the invoice", priority: "URGENT", due_date: tomorrow, status: "UP_NEXT", pushed_count: 1, created_at: yesterday }),
    row({ id: "starred", priority: "LOW", is_priority: true, priority_rank: null }),
  ];
  const order = orderForAutowork(rows).map((r) => r.id).join(",");
  check("work order: the user's star first, then the score — not 'most recently updated'",
    order === "starred,urgent,recent-low", order);
  const ties = [row({ id: "first" }), row({ id: "second" })];
  check("work order: full ties keep the caller's order (stable)",
    orderForAutowork(ties, NOW).map((r) => r.id).join(",") === "first,second", "stable");
}

// ── source guards (AC-X5, AC-X8, AC-N1) ──────────────────────────────────────────────────────────
{
  const src = readFileSync("src/features/huddle/lib/tasks/push.server.ts", "utf8");
  check("push never calls move_task_to_day (journey's 1am job does the placing, inside category hours)",
    !/move_task_to_day/.test(src.replace(/\/\/.*$/gm, "")), "no call outside comments");
  check("push never writes the mirror directly (single-writer read-model; the webhook is the writer)",
    !/(INSERT INTO|UPDATE)\s+tasks\.journey_tasks/i.test(src), "no INSERT/UPDATE on tasks.journey_tasks");
  const tools = [...src.matchAll(/toolName:\s*"([a-z_]+)"/g)].map((m) => m[1]).sort();
  check("push only uses journey tools that exist today (no journey changes)",
    tools.every((t) => ["set_priority_rank", "explain_task_score"].includes(t)), `tools: ${[...new Set(tools)].join(", ")}`);
  const sync = readFileSync("src/routes/api/public/tasks-sync.ts", "utf8");
  check("the webhook runs the refill AFTER the mirror write, not before",
    sync.indexOf("onMirrorEvent(") > sync.indexOf("upsertJourneyTask("), "onMirrorEvent follows upsertJourneyTask");
  const aw = readFileSync("src/routes/api/public/run-autowork.ts", "utf8");
  check("the reconcile runs BEFORE auto-work (so its early exits cannot skip it)",
    aw.indexOf("reconcilePushes(") > 0 && aw.indexOf("reconcilePushes(") < aw.indexOf("runScheduledAutoWork("), "order in run-autowork.ts");
}

{
  // D6: the groom's write must go through groomLaneField. A revert to laneFieldFor at the call site
  // restores the Monday stars — and the pure groomLaneField test alone could not see that.
  const groom = readFileSync("src/features/huddle/lib/tasks/groom.ts", "utf8").replace(/\/\/.*$/gm, "");
  const calls = [...groom.matchAll(/\blaneFieldFor\(/g)].length;
  check("D6: the groom's update payload uses groomLaneField; laneFieldFor is only called from inside it",
    /const laneField = groomLaneField\(/.test(groom) && calls === 2, `laneFieldFor( occurrences (definition + groomLaneField): ${calls}`);

  // The compare-and-set is what makes a refill single-shot (verifier harness: 3 concurrent DONEs -> 1 star).
  const store = readFileSync("src/features/huddle/lib/tasks/tasks.server.ts", "utf8");
  const push = readFileSync("src/features/huddle/lib/tasks/push.server.ts", "utf8");
  check("CAS: the active-task update only moves FROM the expected value, and refill stops when it loses",
    /SET active_task_id = \$4[\s\S]{0,200}active_task_id IS NOT DISTINCT FROM \$3/.test(store) && /if \(!won\) return "lost-race";/.test(push),
    "UPDATE ... WHERE active_task_id IS NOT DISTINCT FROM $3; refill returns on !won");
  // D1: every priority_push read is ALIAS-SET scoped (= ANY), never a single email.
  const pushSql = [...store.matchAll(/`[^`]*tasks\.priority_push[^`]*`/g)].map((m) => m[0]);
  const single = pushSql.filter((q) => /lower\(user_email\)\s*=\s*\$\d/.test(q));
  check("D1: no priority_push query matches a single email — the alias set, like every other push read",
    pushSql.length >= 5 && single.length === 0, `${pushSql.length} queries; single-email: ${single.length}`);
  check("N1: reconcile classifies the MERGED row (mirror + journey), never journey's bare row",
    /classifyActiveEvent\(state === null \? "DELETE" : "UPDATE", merged, node\)/.test(push) && /mirrorRow = state === null \? null : await getPushCandidate\(/.test(push) && /mergeJourneyRow\(mirrorRow, state\)/.test(push),
    "reconcile -> mergeJourneyRow(getPushCandidate(...), state) -> classifyActiveEvent(..., merged, ...)");
  check("N3/L3: reconcile un-pushes only after the settle window, and skips a category push with no mirror row",
    /ev === "unpush" && reconcileMayUnpush\(push\.updated_at, Date\.now\(\)\)/.test(push) &&
      /!mirrorRow && node\.kind === "category"\) continue;/.test(push),
    "both guards wired into reconcilePushes");
  check("D5: after starring, refill re-reads the push and un-stars if it was stopped meanwhile",
    /still\.active_task_id !== next\.id\)[\s\S]{0,80}unstar\(caller, next\.id\)/.test(push), "orphan-star guard present");
}

console.log(`\n==================== ${pass} passed, ${fail} failed ====================`);
process.exit(fail === 0 ? 0 : 1);
