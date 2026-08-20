// One-shot LIVE dual-write proof for the identity-unification migration.
// Enqueues ONE 1:1 message as caller von.ellis@ (the NON-canonical alias) with journey disabled and a
// unique Test- token, then polls getTurnUpdates until the turn lands. The token lets us query
// chat.pending_turns afterward and assert the NEW row carries user_id = a89e3652 (convergence proof).
import { toJSONAsync } from "seroval";
import { defaultSerovalPlugins } from "@tanstack/router-core";

const BASE = process.env.HUDDLE_BASE || "https://icy-flower-0f415200f.7.azurestaticapps.net";
const FN_ENQUEUE = "c79b918b188cb2ef56b73995a55d32df04f1e0076f8162ccfb23a363b2aac9b3";
const FN_UPDATES = "874177d69ad37451f9c3ae0ea56f444f2a7f6fc3a83ce4494ad5a9ec6036daad";
const plugins = defaultSerovalPlugins;

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
  let node; try { node = JSON.parse(txt); } catch { return { http: res.status, raw: txt.slice(0, 400) }; }
  let decoded; try { decoded = decodeSeroval(node); } catch (e) { return { http: res.status, decodeErr: String(e), raw: txt.slice(0, 400) }; }
  return { http: res.status, val: decoded?.result ?? decoded };
}

const AGENT = "finn-reid";
const HID = `dm-${AGENT}`;
const TOKEN = process.env.RUN_TOKEN || `Test-idverify-${Math.random().toString(16).slice(2, 10)}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const agents = { [AGENT]: { backend: "openai", rag: { store: "azure", chunks: false, triples: false, fileSearch: false, sharing: "shared" }, journey: { enabled: false }, webSearch: false } };
const turnId = `dur-idverify-${Buffer.from(String(process.hrtime.bigint())).toString("hex").slice(0, 10)}`;
const payload = {
  text: `${TOKEN} wiring check — reply with a short hello.`,
  huddleId: HID,
  scope: "one-to-one",
  members: [AGENT],
  history: [],
  router: { backend: "openai", model: "gpt-4o-mini", fastMode: false, soloOnCoverage: true, interjections: false, maxInterjectors: 0 },
  agents,
  timeZone: "America/New_York",
  caller: { entra_email: "von.ellis@enterpriseds.io" },
  turnId,
};

console.log(`RUN_TOKEN=${TOKEN}`);
console.log(`turnId=${turnId}  huddle=${HID}  caller=von.ellis@enterpriseds.io (non-canonical alias)`);
const enq = callFn(FN_ENQUEUE, payload);
let done = false;
for (let i = 0; i < 60 && !done; i++) {
  await sleep(1500);
  const u = await callFn(FN_UPDATES, { huddleId: HID, sinceMs: 0 });
  if (u.http !== 200 || !u.val || !u.val.turns) { console.log(`[poll ${i}] http=${u.http} ${u.decodeErr || (u.raw ? "raw:" + u.raw.slice(0, 100) : "")}`); continue; }
  const turn = u.val.turns.find((t) => t.id === turnId);
  if (!turn) { console.log(`[poll ${i}] turn not visible yet`); continue; }
  const reps = turn.replies || [];
  console.log(`[poll ${i}] status=${turn.status} replies=${reps.length}`);
  if (turn.status === "done" || turn.status === "error") {
    done = true;
    for (const r of reps) console.log(`  ${r.agentId}: ${String(r.text).replace(/\n/g, " ").slice(0, 160)}`);
  }
}
const e = await enq;
console.log(`enqueue: http=${e.http} status=${e.val?.status}`);
if (!done) console.log("(did not observe done — pending_turns row should still exist; check by token)");
