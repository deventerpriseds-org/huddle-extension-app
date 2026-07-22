// Live-test the DURABLE / CHUNKED turn path (backlog #3): enqueueHuddleTurn + getTurnUpdates.
// This is the REAL chat path (the client enqueues, then polls) — not the synchronous sendHuddleMessage
// used by the older harness. Run from repo root:
//   node .claude/skills/test-agent-serverfn/scripts/durable-harness.mjs
//
// What it proves (verify-work — observed evidence):
//  1. Enqueue returns and the turn runs on the durable store (no regression from the chunked refactor).
//  2. Replies STREAM: getTurnUpdates shows the turn's `replies` array growing (seq advances) and status
//     moving running/partial -> done, rather than landing atomically.
//  3. No agent dropped: the final `replies` count == the routed agent set for an explicit multi-lane ask.
//  4. No duplicate board cards across a chunk boundary.

import { toJSONAsync } from "seroval";
import { defaultSerovalPlugins } from "@tanstack/router-core";

const BASE = process.env.HUDDLE_BASE || "https://icy-flower-0f415200f.7.azurestaticapps.net";
// Server-fn content-hash ids (from the local .output build of the deployed commit).
const FN_ENQUEUE = process.env.FN_ENQUEUE || "c79b918b188cb2ef56b73995a55d32df04f1e0076f8162ccfb23a363b2aac9b3";
const FN_UPDATES = process.env.FN_UPDATES || "874177d69ad37451f9c3ae0ea56f444f2a7f6fc3a83ce4494ad5a9ec6036daad";
const plugins = defaultSerovalPlugins;

const ALL = ["iris-chase", "tess-sutton", "sam-trent", "terry-locke", "finn-reid", "faith-hartley", "cole-blake"];
const NAME = {
  "iris-chase": "Iris", "tess-sutton": "Tess", "sam-trent": "Sam", "terry-locke": "Terry",
  "finn-reid": "Finn", "faith-hartley": "Faith", "cole-blake": "Cole",
};

const agents = {};
for (const id of ALL) {
  agents[id] = {
    backend: "openai",
    rag: { store: "azure", chunks: false, triples: false, fileSearch: false, sharing: "shared" },
    journey: { enabled: false },
    webSearch: false,
  };
}

// ---- seroval decode (walks the node graph; see SKILL.md) ----
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
  let node; try { node = JSON.parse(txt); } catch { return { http: res.status, raw: txt.slice(0, 500) }; }
  let decoded; try { decoded = decodeSeroval(node); } catch (e) { return { http: res.status, decodeErr: String(e), raw: txt.slice(0, 500) }; }
  return { http: res.status, val: decoded?.result ?? decoded };
}

const HID = "all-members";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A heavy, EXPLICIT multi-lane ask — names 4 lanes so routing must return 4 responders (tests the
// explicitlyRequested router fix too). Wall-time across 4 agents is what may cross the 30s chunk budget.
const TEXT =
  "Team, I want to launch a premium tier next quarter. Sam, lead the go-to-market plan. " +
  "Finn, model the pricing and unit margins. Tess, define the MVP feature set. Cole, outline the " +
  "engineering plan and rough timeline. Each of you give your piece in detail.";

const turnId = `dur-${process.env.RUN_TAG || "verify"}-${Buffer.from(String(process.hrtime.bigint())).toString("hex").slice(0, 10)}`;

const payload = {
  text: TEXT,
  huddleId: HID,
  scope: "group",
  members: ALL,
  history: [],
  router: { backend: "openai", model: "gpt-5.5", fastMode: false, soloOnCoverage: true, interjections: true, maxInterjectors: 2 },
  agents,
  timeZone: "America/New_York",
  caller: { entra_email: "von.ellis@enterpriseds.io" },
  turnId,
};

console.log(`turnId=${turnId}`);
console.log(`ENQUEUE heavy 4-lane turn (Sam/Finn/Tess/Cole)...\n`);

const t0 = Date.now();
// Fire enqueue WITHOUT awaiting so we can poll getTurnUpdates concurrently and watch replies stream
// while the first chunk is still executing inside the enqueue request.
let enqueueResult = null;
const enqueuePromise = callFn(FN_ENQUEUE, payload).then((r) => { enqueueResult = r; return r; });

// Poll loop
const seen = new Map(); // reply index -> agentId (to detect growth)
let lastStatus = null;
let done = false;
const statusTimeline = [];
for (let i = 0; i < 90 && !done; i++) {
  await sleep(1200);
  const u = await callFn(FN_UPDATES, { huddleId: HID, sinceMs: 0 });
  if (u.http !== 200 || !u.val || !u.val.turns) {
    console.log(`  [poll ${i}] http=${u.http} ${u.decodeErr || (u.raw ? "raw:" + u.raw.slice(0, 120) : "")}`);
    continue;
  }
  const turn = u.val.turns.find((t) => t.id === turnId);
  if (!turn) { console.log(`  [poll ${i} · ${((Date.now() - t0) / 1000).toFixed(1)}s] (turn not visible yet)`); continue; }
  const reps = turn.replies || [];
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  if (turn.status !== lastStatus) { statusTimeline.push(`${elapsed}s:${turn.status}`); lastStatus = turn.status; }
  // Print any NEW replies since last poll
  const newlyArrived = [];
  for (let j = 0; j < reps.length; j++) {
    if (!seen.has(j)) { seen.set(j, reps[j].agentId); newlyArrived.push(`${NAME[reps[j].agentId] || reps[j].agentId}`); }
  }
  console.log(
    `  [poll ${i} · ${elapsed}s] status=${turn.status} seq=${turn.seq} replies=${reps.length}` +
    (newlyArrived.length ? `  +NEW: ${newlyArrived.join(", ")}` : ""),
  );
  if (turn.status === "done" || turn.status === "error") {
    done = true;
    console.log(`\n=== FINAL (${turn.status}) after ${elapsed}s ===`);
    for (let j = 0; j < reps.length; j++) {
      console.log(`  ${NAME[reps[j].agentId] || reps[j].agentId}: ${String(reps[j].text).replace(/\n/g, " ").slice(0, 220)}`);
    }
    const result = turn.result || {};
    const cards = result.journeyTaskUpdates?.length ?? 0;
    const suggested = result.suggestedTasks?.length ?? 0;
    console.log(`\n  board cards (journeyTaskUpdates)=${cards}  suggestedTasks=${suggested}`);
    console.log(`  status timeline: ${statusTimeline.join(" -> ")}`);
    console.log(`  distinct responders: ${[...new Set(reps.map((r) => NAME[r.agentId] || r.agentId))].join(", ")}`);
  }
}

await enqueuePromise;
console.log(`\n  enqueue returned: http=${enqueueResult?.http} status=${enqueueResult?.val?.status} ` +
  `partial=${enqueueResult?.val?.result?.partial}`);
if (!done) console.log("  (timed out waiting for done — see polls above)");
