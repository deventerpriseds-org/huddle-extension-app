// WHAT:       Live check of the two owner-approved changes (2026-11-03) on the REAL durable chat path
//             (enqueueHuddleTurn + getTurnUpdates): (1) planning contract — "plan my day" gets a short timed
//             list and focus_on is NOT called; an explicit "start X" and a reply to the priority check STILL
//             call focus_on; (2) answer-first in a 1:1 — an out-of-lane question is answered, then the owner
//             is named with no @handle; big lane work and an exclusive capability still hand off; group
//             wording unchanged.
// WHY:        2026-10-28 "plan my activities for the day" -> Iris called focus_on (every item to Doing) and
//             wrote an essay; 1:1 out-of-lane questions were refused ("Do NOT answer it yourself").
// SUPERSEDES: nothing
// SUPERSEDED-BY: nothing -- current
// EVIDENCE:   docs/qc-evidence/BUILD-plan-and-answer-first.md. Offline twin: scripts/plan-and-answer-first.test.ts.
//
// SAFETY: journey:{enabled:false} on EVERY agent, so focus_on / create_huddle_task(s) cannot write the real
// board (focus_on is still OFFERED and its attempt is recorded in result.toolUses as
// "focus_on -- journey disabled", which is exactly the signal case 1-3 read). Every message is `Test-`
// prefixed and carries the run MARK so the run's chat.pending_turns + rag_chunks rows can be removed by
// marker afterwards (the SQL is printed at the end; this script does not delete anything itself).
//
// Run (NOT run by the build lane — run against the deployed commit that contains the change):
//   node .claude/skills/test-agent-serverfn/scripts/qa-plan-and-answer-first.mjs
// Env: HUDDLE_BASE, FN_ENQUEUE, FN_UPDATES (server-fn ids of the deployed build; refresh if 404),
//      QA_MARK (default random), QA_ONLY=1,4 (comma list of case numbers).

import { toJSONAsync } from "seroval";
import { defaultSerovalPlugins } from "@tanstack/router-core";

const BASE = process.env.HUDDLE_BASE || "https://icy-flower-0f415200f.7.azurestaticapps.net";
const FN_ENQUEUE = process.env.FN_ENQUEUE || "c79b918b188cb2ef56b73995a55d32df04f1e0076f8162ccfb23a363b2aac9b3";
const FN_UPDATES = process.env.FN_UPDATES || "874177d69ad37451f9c3ae0ea56f444f2a7f6fc3a83ce4494ad5a9ec6036daad";
const MARK = process.env.QA_MARK || `qa-paf-${Math.random().toString(16).slice(2, 8)}`;
const ONLY = process.env.QA_ONLY ? new Set(process.env.QA_ONLY.split(",").map((s) => Number(s.trim()))) : null;
const plugins = defaultSerovalPlugins;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ALL = ["iris-chase", "tess-sutton", "sam-trent", "terry-locke", "finn-reid", "faith-hartley", "cole-blake"];
const agents = {};
for (const id of ALL) {
  agents[id] = {
    backend: "openai",
    rag: { store: "azure", chunks: false, triples: false, fileSearch: false, sharing: "shared" },
    journey: { enabled: false }, // NEVER true in this script — no board writes are possible.
    webSearch: false,
  };
}

// ---- seroval decode (same walker as durable-harness.mjs) ----
const CONST = { 1: undefined, 2: null, 3: NaN, 4: Infinity, 5: -Infinity, 6: -0 };
function decodeSeroval(root) {
  const reg = new Map();
  function walk(n) {
    if (n == null || typeof n !== "object") return n;
    switch (n.t) {
      case 0: case 1: return n.s;
      case 3: return typeof n.s === "string" ? BigInt(n.s) : n.s;
      case 2: return n.s in CONST ? CONST[n.s] : undefined;
      case 7: return reg.get(n.i);
      case 9: { const arr = []; if (n.i != null) reg.set(n.i, arr); for (const it of n.a ?? []) arr.push(walk(it)); return arr; }
      case 10: case 11: { const obj = {}; if (n.i != null) reg.set(n.i, obj); const k = n.p?.k ?? [], v = n.p?.v ?? []; for (let j = 0; j < k.length; j++) obj[k[j]] = walk(v[j]); return obj; }
      default: return n.s ?? null;
    }
  }
  return walk(root);
}
async function callFn(fnId, data) {
  const body = JSON.stringify(await toJSONAsync({ data }, { plugins }));
  const res = await fetch(`${BASE}/_serverFn/${fnId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-tsr-serverFn": "true", accept: "application/json" },
    body,
  });
  const txt = await res.text();
  let node; try { node = JSON.parse(txt); } catch { return { http: res.status, raw: txt.slice(0, 300) }; }
  let decoded; try { decoded = decodeSeroval(node); } catch (e) { return { http: res.status, decodeErr: String(e) }; }
  return { http: res.status, val: decoded?.result ?? decoded };
}

/** Enqueue one turn and poll until done; returns { replies, toolUses, result }. */
async function runTurn({ text, huddleId, scope, members, target, history = [] }) {
  const turnId = `dur-${MARK}-${Buffer.from(String(process.hrtime.bigint())).toString("hex").slice(0, 10)}`;
  const payload = {
    text, huddleId, scope, members,
    ...(target ? { targetAgentId: target } : {}),
    history,
    router: { backend: "openai", model: "gpt-5.5", fastMode: false, soloOnCoverage: true, interjections: true, maxInterjectors: 2 },
    agents,
    timeZone: "America/New_York",
    caller: { entra_email: "von.ellis@enterpriseds.io" },
    turnId,
  };
  const enq = callFn(FN_ENQUEUE, payload);
  for (let i = 0; i < 150; i++) {
    await sleep(1500);
    const u = await callFn(FN_UPDATES, { huddleId, sinceMs: 0 });
    const turn = u.val?.turns?.find((t) => t.id === turnId);
    if (turn && (turn.status === "done" || turn.status === "error")) {
      await enq;
      const result = turn.result || {};
      return { status: turn.status, replies: turn.replies || result.replies || [], toolUses: result.toolUses || [], result };
    }
  }
  await enq;
  return { status: "timeout", replies: [], toolUses: [], result: {} };
}

let pass = 0, fail = 0;
function check(name, ok, detail = "") {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"} ${name}${!ok && detail ? ` — ${detail}` : ""}`);
}
const textOf = (r) => r.replies.map((x) => String(x.text || "")).join("\n");
const calledFocus = (r) => r.toolUses.some((t) => t.tool === "focus_on");
const TIME_LINE = /^\s*(?:[•\-*]\s*)?\d{1,2}(?::\d{2})?\s*(?:am|pm|AM|PM)?\b.*·/;

const ONE = { huddleId: "dm-iris-chase", scope: "one-to-one", members: ["iris-chase"], target: "iris-chase" };
const GROUP = { huddleId: "all-members", scope: "group", members: ALL };

const CASES = [
  {
    n: 1, name: "PLAN: 'plan my day' -> short timed list, focus_on NOT called", ctx: ONE,
    text: `Test- ${MARK} plan my activities for the day: Test-work on my DBA papers, Test-gym at 3pm, Test-pick up supplements at the vitamin shop, Test-work on my apps. Lay it out.`,
    verify(r) {
      const t = textOf(r);
      check("1a reply arrived", r.status === "done" && t.trim().length > 0, r.status);
      check("1b focus_on was NOT called (nothing moved to Doing)", !calledFocus(r), JSON.stringify(r.toolUses.map((x) => x.tool)));
      const timed = t.split("\n").filter((l) => TIME_LINE.test(l)).length;
      check("1c at least 3 `time · item · note` lines", timed >= 3, `timed lines=${timed}`);
      check("1d short (<= 900 chars, not an essay)", t.length <= 900, `len=${t.length}`);
      check("1e does not claim it started anything", !/\b(started|moved (?:it|them|these)? ?to doing|in doing now)\b/i.test(t));
      console.log(`  tools: ${r.toolUses.map((x) => x.tool).join(", ") || "(none)"}`);
    },
  },
  {
    n: 2, name: "START: explicit 'start X now' STILL calls focus_on", ctx: ONE,
    text: `Test- ${MARK} start Test-interview prep now.`,
    verify(r) {
      check("2a focus_on WAS called on explicit start wording", calledFocus(r), JSON.stringify(r.toolUses.map((x) => x.tool)));
    },
  },
  {
    n: 3, name: "PRIORITY-CHECK REPLY: reply to Iris's scheduled check STILL calls focus_on (2026-10-16 design)", ctx: ONE,
    history: [{
      id: `h-${MARK}-pc`, huddleId: "dm-iris-chase", author: { kind: "agent", agentId: "iris-chase" }, ts: Date.now() - 60_000,
      text: "Hello Sir, here are your top priorities:\n• Test-the deck\n• Test-interview prep\nYou can also just reply with what you want to work on and I'll start those.",
    }],
    text: `Test- ${MARK} Test-the deck, Test-interview prep`,
    verify(r) {
      check("3a focus_on WAS called for the priority-check reply", calledFocus(r), JSON.stringify(r.toolUses.map((x) => x.tool)));
    },
  },
  {
    n: 4, name: "1:1 ANSWER FIRST: out-of-lane question is answered, owner named, no @handle", ctx: ONE,
    text: `Test- ${MARK} quick question: what's the main difference between a Roth IRA and a traditional IRA?`,
    verify(r) {
      const t = textOf(r);
      check("4a Iris answered the question (mentions tax treatment)", /\btax/i.test(t), t.slice(0, 200));
      check("4b names Finn by name", /\bFinn\b/.test(t), t.slice(0, 200));
      check("4c no @handle in a 1:1", !/@[a-z]/i.test(t), t.slice(0, 200));
    },
  },
  {
    n: 5, name: "1:1 BIG LANE WORK: still handed off by name, not done", ctx: ONE,
    text: `Test- ${MARK} build me a full monthly budget model with categories and savings targets.`,
    verify(r) {
      const t = textOf(r);
      check("5a names Finn as better suited", /\bFinn\b/.test(t), t.slice(0, 200));
      check("5b no @handle in a 1:1", !/@[a-z]/i.test(t), t.slice(0, 200));
      check("5c short handoff, not a built model (<= 600 chars)", t.length <= 600, `len=${t.length}`);
    },
  },
  {
    n: 6, name: "1:1 EXCLUSIVE CAPABILITY: grooming still defers to Terry", ctx: ONE,
    text: `Test- ${MARK} groom my backlog for this week.`,
    verify(r) {
      const t = textOf(r);
      check("6a names Terry", /\bTerry\b/.test(t), t.slice(0, 200));
      check("6b groom_backlog NOT run by Iris", !r.toolUses.some((x) => x.tool === "groom_backlog" && x.agentId === "iris-chase"));
      check("6c no @handle in a 1:1", !/@[a-z]/i.test(t), t.slice(0, 200));
    },
  },
  {
    n: 7, name: "GROUP unchanged: out-of-lane question still routes/@mentions the specialist", ctx: GROUP,
    text: `Test- ${MARK} Iris, what's a reasonable expense ratio for an index fund?`,
    verify(r) {
      const t = textOf(r);
      const ids = r.replies.map((x) => x.agentId);
      check("7a Finn replied OR an @finn handoff appears (group behaviour)", ids.includes("finn-reid") || /@finn/i.test(t), `responders=${ids.join(",")}`);
    },
  },
];

console.log(`MARK=${MARK}  base=${BASE}\n`);
for (const c of CASES) {
  if (ONLY && !ONLY.has(c.n)) continue;
  console.log(`== Case ${c.n}: ${c.name}`);
  const r = await runTurn({ ...c.ctx, text: c.text, history: c.history || [] });
  for (const x of r.replies) console.log(`  ${x.agentId}: ${String(x.text).replace(/\n/g, " ⏎ ").slice(0, 300)}`);
  c.verify(r);
  console.log("");
}
console.log(`${pass} passed, ${fail} failed  (MARK=${MARK})`);
console.log(
  `\nCLEANUP (run via azure-pg-query.yml — journey was disabled, so there is no board to clean):\n` +
  `  DELETE FROM chat.pending_turns WHERE id LIKE 'dur-${MARK}-%' OR payload->>'text' LIKE '%${MARK}%';\n` +
  `  DELETE FROM public.rag_chunks WHERE text LIKE '%${MARK}%';`,
);
if (fail) process.exit(1);
