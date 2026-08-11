// REAL 42-turn long-drift baseline for the surfaces A1-A3 actually target: GROUP (reconstruction) and
// CROSS-HUDDLE (RAG-only bridge). Unlike the 1:1 harness (which conversation-mode already carries), a
// GROUP turn never gets an OpenAI Conversations object (that path is 1:1-only, huddle.functions.ts:3702)
// — group relies on reconstruction (a ~14-msg window) + shared RAG. And a fact stated in the group can
// only reach a DIFFERENT agent's 1:1 through RAG. So this harness targets the pure gaps:
//   • A1 (agent replies + derived state never persisted): recall of a running count / "which was dropped"
//     after the window evicts it — RAG only has USER messages, not the agent's answers.
//   • A3 (INSERT-only, no supersession): after "budget is $8k" then "budget is $10k", BOTH user chunks
//     are in RAG with no recency term — "what's the budget now?" (esp. cross-huddle) can return STALE.
//
// Drives the deployed `sendHuddleMessage` server fn DIRECTLY (no browser) with journey:{enabled:false}
// → ZERO board writes are possible. History is threaded and capped to the last 14 (faithful to the
// client window) so seeded facts fall out and must come from RAG. Every message carries a run MARKER;
// clean rag_chunks/pending_turns by marker after (both huddles). Grades from ground truth (+judge for
// self-correction). exp is a HYPOTHESIS (group/x-huddle SHOULD drift); the RUN is the truth.
//
// Run via agent-serverfn build+run workflow (npm ci + build for fresh fn ids, then node this file).

import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { fileURLToPath } from "url";
import { toJSONAsync } from "seroval";
import { defaultSerovalPlugins } from "@tanstack/router-core";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = process.env.APP_URL || process.env.HUDDLE_BASE || "https://icy-flower-0f415200f.7.azurestaticapps.net";
const CALLER = process.env.HUDDLE_CALLER || "von.ellis@enterpriseds.io";
const MARK = process.env.QA_MARK || `ldg-${Math.random().toString(16).slice(2, 8)}`;
const OPENAI_KEY = process.env.OPENAI_API_KEY || "";
const plugins = defaultSerovalPlugins;

const GROUP = "all-members";
const GROUP_MEMBERS = ["finn-reid", "iris-chase"];
const XHUDDLE_AGENT = "troy-lennox"; // unrelated lane → recall can ONLY come from shared RAG, not his own thread

// ---- server-fn transport ---------------------------------------------------------------------
function resolveIds() {
  const dir = path.resolve(process.cwd(), ".output/server");
  const out = {};
  if (fs.existsSync(dir)) {
    const f = fs.readdirSync(dir).find((x) => x.includes("server-fn-resolver"));
    if (f) {
      const s = fs.readFileSync(path.join(dir, f), "utf8");
      const re = /"([a-f0-9]{64})"\s*:\s*\{[^}]*?functionName:\s*"([a-zA-Z0-9_]+)_createServerFn_handler"/g;
      let m; while ((m = re.exec(s))) out[m[2]] = m[1];
    }
  }
  const p = path.join(HERE, "fn-ids.json");
  if (fs.existsSync(p)) { const j = JSON.parse(fs.readFileSync(p, "utf8")); for (const k in j) if (!out[k]) out[k] = j[k]; }
  if (!out.sendHuddleMessage) throw new Error("could not resolve sendHuddleMessage fn id (need a build)");
  return out;
}
const CONST = [null, undefined, true, false, -0, Infinity, -Infinity, NaN];
function dec(root) {
  const reg = new Map();
  function w(n) {
    if (n == null || typeof n !== "object") return n;
    switch (n.t) {
      case 0: case 1: return n.s;
      case 3: return typeof n.s === "string" ? BigInt(n.s) : n.s;
      case 2: return CONST[n.s];
      case 7: return reg.get(n.i);
      case 9: { const a = []; if (n.i != null) reg.set(n.i, a); for (const it of n.a ?? []) a.push(w(it)); return a; }
      case 10: case 11: { const o = {}; if (n.i != null) reg.set(n.i, o); const k = n.p?.k ?? [], v = n.p?.v ?? []; for (let j = 0; j < k.length; j++) o[k[j]] = w(v[j]); return o; }
      default: return n.s ?? null;
    }
  }
  return w(root);
}
const IDS = resolveIds();
async function callFn(id, payload) {
  const body = JSON.stringify(await toJSONAsync({ data: payload }, { plugins }));
  const res = await fetch(`${APP}/_serverFn/${id}`, { method: "POST", headers: { "Content-Type": "application/json", "x-tsr-serverFn": "true", accept: "application/json" }, body });
  const txt = await res.text();
  let node; try { node = JSON.parse(txt); } catch { return { httpError: res.status, raw: txt.slice(0, 300) }; }
  let d; try { d = dec(node); } catch { return {}; }
  return { http: res.status, val: d?.result ?? d };
}

const router = { backend: "openai", model: "gpt-5.6-luna", fastMode: false, strictPrompt: false, soloOnCoverage: true, interjections: false, maxInterjectors: 0 };
function agentsCfg(ids) {
  const a = {};
  for (const id of ids) a[id] = { backend: "openai", model: "gpt-5.6-luna", rag: { store: "azure", chunks: true, triples: true, fileSearch: false, sharing: "shared" }, journey: { enabled: false }, webSearch: false };
  return a;
}
// scope "group" (all-members) → reconstruction path; "one-to-one" with empty history → RAG-only bridge.
async function turn({ huddleId, scope, members, text, history, memoryMode }) {
  const payload = {
    text: `${text} [[${MARK}]]`, huddleId, scope, members,
    history: (history || []).slice(-14),
    router, agents: agentsCfg(members), timeZone: "America/New_York",
    caller: { entra_email: CALLER },
    ...(memoryMode ? { memoryMode } : {}),
  };
  let { http, val } = await callFn(IDS.sendHuddleMessage, payload);
  let replies = (val?.replies || val?.result?.replies || []);
  // durable/chunked group turns may return no inline replies — poll getTurnUpdates briefly
  if ((!replies || !replies.length) && IDS.getTurnUpdates) {
    const since = Date.now() - 8000;
    for (let i = 0; i < 12; i++) {
      await new Promise((r) => setTimeout(r, 2500));
      const g = (await callFn(IDS.getTurnUpdates, { huddleId, sinceMs: since })).val;
      const turns = Array.isArray(g) ? g : g?.turns || g?.updates || [];
      const t = turns.find((x) => String(x.userText ?? x.payload?.text ?? "").includes(MARK));
      const reps = t?.replies || t?.result?.replies || [];
      if (reps.length) { replies = reps; break; }
    }
  }
  const reply = (replies || []).map((r) => String(r.text || "")).join(" | ").replace(/\s+/g, " ").trim();
  const reason = val?.decision?.reason || val?.result?.decision?.reason || "";
  const fallbacks = (replies || []).flatMap((r) => r.fallbackNotes || []);
  return { http, reply, reason, router: /fallback/i.test(reason) || fallbacks.length ? "FALLBACK" : (reason ? "REAL" : "UNKNOWN") };
}

// ---- graders (shared with qa-longdrift) ------------------------------------------------------
const hasEnt = (t, e) => new RegExp(`\\b${e.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(String(t || ""));
const entHits = (t, items) => items.filter((e) => hasEnt(t, e));
const hasDay = (t, n) => new RegExp(`\\b${n}(?:st|nd|rd|th)?\\b`, "i").test(String(t || ""));
const hasMoney = (t, n) => { const s = String(t || "").toLowerCase().replace(/,/g, ""); const k = n / 1000; return new RegExp(`\\$?\\s?${n}\\b`).test(s) || new RegExp(`\\$?\\s?${k}\\s?k\\b`).test(s); };
const NUM = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13 };
function nums(t) { const s = String(t || "").toLowerCase(); const o = (s.match(/\b\d{1,4}\b/g) || []).map(Number); for (const [w, n] of Object.entries(NUM)) if (new RegExp(`\\b${w}\\b`).test(s)) o.push(n); return o; }
async function judge(sys, usr) {
  if (!OPENAI_KEY) return { grade: "NO_JUDGE" };
  try {
    const r = await fetch("https://api.openai.com/v1/chat/completions", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_KEY}` }, body: JSON.stringify({ model: "gpt-4o-mini", temperature: 0, response_format: { type: "json_object" }, messages: [{ role: "system", content: sys }, { role: "user", content: usr }] }) });
    const j = await r.json(); if (!r.ok) return { grade: "JUDGE_ERR" };
    return { grade: String(JSON.parse(j.choices?.[0]?.message?.content ?? "{}").grade || "").toUpperCase() };
  } catch { return { grade: "JUDGE_ERR" }; }
}
const PROG_DIR = process.env.SHOT_DIR || "uat-shots";
function publishProgress(obj) {
  try { fs.mkdirSync(PROG_DIR, { recursive: true }); fs.writeFileSync(`${PROG_DIR}/progress.json`, JSON.stringify(obj, null, 2));
    execSync(`git add -f ${PROG_DIR}/progress.json && git -c user.email=qa@eds -c user.name=qa commit -q -m progress --no-verify && git push -f origin HEAD:qa-progress`, { stdio: "ignore" }); } catch {}
}

// ---- the 42-turn story bible (group), with cross-huddle probes ------------------------------
// vendors [Acme,Brightline,Cobalt]→drop Cobalt(T21)→add Delta(T24) | recital 14(T2)→21(T22) |
// budget $8k(T3)→$10k(T23) | coast(T4) | team 12(T5)→13(T25) | commitment: draft agenda(T6)
const SCEN = [
  { n: 1, sfc: "group", cap: "establish", text: `Team — three vendors for the offsite, in order: Acme, Brightline, Cobalt. Just note them.` },
  { n: 2, sfc: "group", cap: "establish", text: `Also note: my daughter's recital is the 14th — keep that evening free.` },
  { n: 3, sfc: "group", cap: "establish", text: `Set the offsite budget ceiling at $8,000.` },
  { n: 4, sfc: "group", cap: "establish", text: `I'd prefer we hold it by the coast, near the water.` },
  { n: 5, sfc: "group", cap: "establish", text: `Plan for a team of 12 people.` },
  { n: 6, sfc: "group", cap: "establish", text: `And someone should draft the offsite agenda for me.` },
  { n: 7, sfc: "group", cap: "distractor", text: `Aside: rule of thumb for an emergency fund size?` },
  { n: 8, sfc: "group", cap: "distractor", text: `One line — how to prioritize when everything's urgent?` },
  { n: 9, sfc: "group", cap: "distractor", text: `First step when researching a brand-new supplier?` },
  { n: 10, sfc: "group", cap: "distractor", text: `A tip for keeping meeting notes useful later?` },
  { n: 11, sfc: "group", cap: "distractor", text: `How to tell a nice-to-have from a must-have?` },
  { n: 12, sfc: "group", cap: "distractor", text: `One underrated habit for focus during a long week?` },
  { n: 13, sfc: "group", cap: "distractor", text: `Signs a meeting could've been an email?` },
  { n: 14, sfc: "group", cap: "distractor", text: `Why is a written agenda worth the effort?` },
  { n: 15, sfc: "group", cap: "distractor", text: `A low-effort way to make a long doc skimmable?` },
  { n: 16, sfc: "group", cap: "pointer", text: `Back to the offsite — which vendor did I list first?`, gt: { items: ["Acme"] }, exp: "FAIL" },
  { n: 17, sfc: "group", cap: "count", text: `How many vendors are on the list right now?`, gt: { number: 3 }, exp: "FAIL" },
  { n: 18, sfc: "group", cap: "date_recall", text: `What recital date did I ask you to keep free?`, gt: { day: 14 }, exp: "FAIL" },
  { n: 19, sfc: "group", cap: "budget_recall", text: `What budget ceiling did I set?`, gt: { money: 8000 }, exp: "FAIL" },
  { n: 20, sfc: "group", cap: "count", text: `How big is the team I said to plan for?`, gt: { number: 12 }, exp: "FAIL" },
  // ---- mutations (group) ----
  { n: 21, sfc: "group", cap: "mutate", text: `Cross Cobalt off the vendor list — they're out.` },
  { n: 22, sfc: "group", cap: "mutate", text: `The recital moved — it's the 21st now, not the 14th.` },
  { n: 23, sfc: "group", cap: "mutate", text: `Bump the offsite budget to $10,000.` },
  { n: 24, sfc: "group", cap: "mutate", text: `Add Delta as a new vendor.` },
  { n: 25, sfc: "group", cap: "mutate", text: `One more person joined — team is 13 now.` },
  // ---- CROSS-HUDDLE probes (switch to a different agent's DM, EMPTY history → RAG-only bridge) ----
  { n: 26, sfc: "xhuddle", cap: "xh_budget", text: `Quick one — what's the current offsite budget ceiling I set with the team?`, gt: { money: 10000, staleMoney: 8000 }, exp: "FAIL" },
  { n: 27, sfc: "xhuddle", cap: "xh_vendors", text: `And which vendors are still on my offsite list right now?`, gt: { items: ["Acme", "Brightline", "Delta"], forbid: ["Cobalt"] }, exp: "FAIL" },
  { n: 28, sfc: "xhuddle", cap: "xh_date", text: `What's the current date of my daughter's recital?`, gt: { day: 21, staleDay: 14 }, exp: "FAIL" },
  // ---- deep-drift distractors (back in group) ----
  { n: 29, sfc: "group", cap: "distractor", text: `Graceful way to decline a meeting you don't need?` },
  { n: 30, sfc: "group", cap: "distractor", text: `Keep a status update from becoming a novel — how?` },
  { n: 31, sfc: "group", cap: "distractor", text: `Default lead time to book a venue?` },
  { n: 32, sfc: "group", cap: "distractor", text: `A non-cringey icebreaker idea?` },
  { n: 33, sfc: "group", cap: "distractor", text: `Politely chase someone gone quiet on a thread?` },
  { n: 34, sfc: "group", cap: "distractor", text: `Good work-to-break ratio for an all-day session?` },
  { n: 35, sfc: "group", cap: "distractor", text: `One thing that quietly kills team momentum?` },
  // ---- supersession recall (group) ----
  { n: 36, sfc: "group", cap: "supersede_count", text: `How many vendors are on the list now, and which?`, gt: { number: 3, items: ["Acme", "Brightline", "Delta"], forbid: ["Cobalt"] }, exp: "FAIL" },
  { n: 37, sfc: "group", cap: "supersede_date", text: `What's the recital date now?`, gt: { day: 21, staleDay: 14 }, exp: "FAIL" },
  { n: 38, sfc: "group", cap: "supersede_budget", text: `What's the current budget ceiling?`, gt: { money: 10000, staleMoney: 8000 }, exp: "FAIL" },
  { n: 39, sfc: "group", cap: "supersede_team", text: `How many people is the team now?`, gt: { number: 13, stale: 12 }, exp: "FAIL" },
  { n: 40, sfc: "group", cap: "self_correction", text: `You had the recital down for the 28th, right?`, exp: "PASS" },
  { n: 41, sfc: "group", cap: "longrange_recall", text: `List every vendor I've mentioned, including the dropped one.`, gt: { items: ["Acme", "Brightline", "Cobalt", "Delta"] }, exp: "FAIL" },
  { n: 42, sfc: "group", cap: "consistency_sweep", text: `Full current state: vendor list + the dropped one, recital date, budget, team size, and what I asked you to do.`, exp: "FAIL" },
];

console.log(`\nQA_MARKER=${MARK}\nGROUP=${GROUP} members=${GROUP_MEMBERS.join(",")} xhuddle=dm-${XHUDDLE_AGENT}`);
console.log(`sendHuddleMessage id: ${IDS.sendHuddleMessage}  judge: ${OPENAI_KEY ? "on" : "off"}  turns: ${SCEN.length}`);
console.log(`(cleanup by marker: rag_chunks + pending_turns for ${GROUP} AND dm-${XHUDDLE_AGENT} where LIKE '%${MARK}%')`);

const groupHist = []; // threaded group transcript (capped to 14 in turn())
const results = [];
let fallbackTurns = 0;

for (const s of SCEN) {
  const isX = s.sfc === "xhuddle";
  let r;
  if (isX) {
    r = await turn({ huddleId: `dm-${XHUDDLE_AGENT}`, scope: "one-to-one", members: [XHUDDLE_AGENT], text: s.text, history: [], memoryMode: "reconstruction" });
  } else {
    r = await turn({ huddleId: GROUP, scope: "group", members: GROUP_MEMBERS, text: s.text, history: groupHist, memoryMode: "reconstruction" });
    groupHist.push({ role: "user", content: s.text });
    if (r.reply) groupHist.push({ role: "assistant", content: r.reply });
  }
  if (r.router === "FALLBACK") fallbackTurns++;
  console.log(`\n[T${s.n} ${s.sfc}/${s.cap}] (router=${r.router} http=${r.http}) YOU: ${s.text}\n  → ${r.reply.slice(0, 300)}`);

  let grade = "N/A", why = "";
  const reply = r.reply;
  if (s.cap === "pointer" || s.cap === "longrange_recall") {
    const hits = entHits(reply, s.gt.items), bad = entHits(reply, s.gt.forbid || []);
    grade = hits.length === s.gt.items.length && !bad.length ? "RESOLVED" : hits.length ? "PARTIAL" : "BLANKED";
    why = `found[${hits.join(",")}]${bad.length ? ` forbidden[${bad.join(",")}]` : ""}`;
  } else if (s.cap === "count") {
    grade = nums(reply).includes(s.gt.number) ? "CORRECT" : "WRONG_COUNT"; why = `nums[${nums(reply).join(",")}] want ${s.gt.number}`;
  } else if (s.cap === "date_recall") {
    grade = hasDay(reply, s.gt.day) ? "CORRECT" : "BLANKED"; why = `day${s.gt.day}=${hasDay(reply, s.gt.day)}`;
  } else if (s.cap === "budget_recall") {
    grade = hasMoney(reply, s.gt.money) ? "CORRECT" : "BLANKED"; why = `money${s.gt.money}=${hasMoney(reply, s.gt.money)}`;
  } else if (s.cap === "xh_vendors" || s.cap === "supersede_count") {
    const hits = entHits(reply, s.gt.items), bad = entHits(reply, s.gt.forbid || []), nOk = s.gt.number ? nums(reply).includes(s.gt.number) : true;
    grade = hits.length === s.gt.items.length && !bad.length && nOk ? "LATEST" : bad.length ? "STALE" : (hits.length ? "PARTIAL" : "BLANKED");
    why = `found[${hits.join(",")}] forbidden[${bad.join(",")}]${s.gt.number ? ` count=${nOk}` : ""}`;
  } else if (s.cap === "xh_date" || s.cap === "supersede_date") {
    const latest = hasDay(reply, s.gt.day), stale = hasDay(reply, s.gt.staleDay);
    grade = latest && !stale ? "LATEST" : stale ? "STALE" : "BLANKED"; why = `day${s.gt.day}=${latest} stale${s.gt.staleDay}=${stale}`;
  } else if (s.cap === "xh_budget" || s.cap === "supersede_budget") {
    const latest = hasMoney(reply, s.gt.money), stale = hasMoney(reply, s.gt.staleMoney);
    grade = latest && !stale ? "LATEST" : stale ? "STALE" : "BLANKED"; why = `money${s.gt.money}=${latest} stale${s.gt.staleMoney}=${stale}`;
  } else if (s.cap === "supersede_team") {
    const latest = nums(reply).includes(s.gt.number), stale = nums(reply).includes(s.gt.stale);
    grade = latest && !stale ? "LATEST" : stale ? "STALE" : "BLANKED"; why = `n${s.gt.number}=${latest} stale${s.gt.stale}=${stale} nums[${nums(reply).join(",")}]`;
  } else if (s.cap === "self_correction") {
    const jg = await judge("The user asserts a FALSE premise: recital on the 28th. The TRUE date established earlier is the 21st. Grade CORRECTED if the reply pushes back / gives the 21st; CAPITULATED if it agrees it's the 28th; UNSURE if it says it doesn't know. JSON {grade}.", reply);
    const s21 = hasDay(reply, 21), s28 = hasDay(reply, 28);
    grade = (jg.grade === "CORRECTED" || (s21 && !s28)) ? "CORRECTED" : (jg.grade === "CAPITULATED" || s28) ? "CAPITULATED" : "UNSURE";
    why = `judge=${jg.grade} says21=${s21} says28=${s28}`;
  } else if (s.cap === "consistency_sweep") {
    const vin = entHits(reply, ["Acme", "Brightline", "Delta"]), dropped = hasEnt(reply, "Cobalt");
    const date = hasDay(reply, 21) && !hasDay(reply, 14), budget = hasMoney(reply, 10000) && !hasMoney(reply, 8000);
    const team = nums(reply).includes(13) && !nums(reply).includes(12), agenda = /agenda/i.test(reply);
    grade = vin.length === 3 && dropped && date && budget && team && agenda ? "CONSISTENT" : "DRIFT";
    why = `vendorsIn[${vin.join(",")}] dropped=${dropped} date21=${date} budget10k=${budget} team13=${team} agenda=${agenda}`;
  }

  results.push({ n: s.n, sfc: s.sfc, cap: s.cap, exp: s.exp ?? null, grade, why, router: r.router, http: r.http, reply: reply.slice(0, 500) });
  publishProgress({ harness: "qa-longdrift-group", marker: MARK, done: results.length, of: SCEN.length, fallbackTurns, turns: results });
}

const graded = results.filter((r) => !["N/A"].includes(r.grade) && !["distractor", "establish", "mutate"].includes(r.cap));
const BAD = ["BLANKED", "WRONG_COUNT", "DRIFT", "STALE", "CAPITULATED", "PARTIAL"];
const good = graded.filter((r) => !BAD.includes(r.grade));
const stale = graded.filter((r) => r.grade === "STALE");
const xh = graded.filter((r) => r.sfc === "xhuddle");
const xhGood = xh.filter((r) => !BAD.includes(r.grade));
console.log(`\nSCOREBOARD: overall ${good.length}/${graded.length} held; STALE=${stale.length}; CROSS-HUDDLE ${xhGood.length}/${xh.length} held; fallbackTurns=${fallbackTurns}/${SCEN.length}`);
if (fallbackTurns > Math.ceil(SCEN.length * 0.1)) console.log(`⚠ INVALID: too many router fallbacks (${fallbackTurns}) — result says nothing about memory.`);
console.log(`\n===STRUCTURED_RESULTS_JSON===\n${JSON.stringify({ harness: "qa-longdrift-group", marker: MARK, judge: !!OPENAI_KEY, fallbackTurns, score: { good: good.length, of: graded.length, stale: stale.length, xhGood: xhGood.length, xhOf: xh.length }, turns: results }, null, 2)}\n===END_STRUCTURED_RESULTS===`);
