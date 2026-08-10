#!/usr/bin/env node
// STANDING Huddle test harness — message any huddle and read any huddle's turns against the live SWA.
// Committed + reusable: no per-session spin-up. Server-fn ids AUTO-RESOLVE from a local build
// (./.output) when present, else fall back to fn-ids.json committed next to this file.
//
// Usage (run from the huddle-extension-app repo root):
//   node .claude/skills/test-agent-serverfn/scripts/huddle.mjs send \
//        --huddle dm-tess-sutton --scope 1:1 --agent tess-sutton --text "Please groom the backlog"
//   node .claude/skills/test-agent-serverfn/scripts/huddle.mjs send \
//        --huddle all-members --scope group --members iris-chase,tess-sutton,terry-locke,finn-reid --text "..."
//   node .claude/skills/test-agent-serverfn/scripts/huddle.mjs read --huddle dm-terry-locke --since-min 30
//   node .claude/skills/test-agent-serverfn/scripts/huddle.mjs resolve   # refresh fn-ids.json from ./.output after `npm run build`
//
// Flags for `send`: --scope group|1:1 (1:1 ⇒ scope "one-to-one" + targetAgentId=--agent),
//   --members a,b,c (defaults to the agent for 1:1, or a broad roster for group), --agent <id> (1:1 target),
//   --journey (enable journey tools/task writes — OFF by default so tests never touch the real board),
//   --rag (enable shared memory retrieval), --interject.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { toJSONAsync } from "seroval";
import { defaultSerovalPlugins } from "@tanstack/router-core";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.HUDDLE_BASE || "https://icy-flower-0f415200f.7.azurestaticapps.net";
const plugins = defaultSerovalPlugins;

const ROSTER = ["iris-chase","terry-locke","finn-reid","faith-hartley","elle-rowan","flex-grimes",
  "ezra-miles","sam-trent","cole-blake","charleston-lewis","eli-vaughn","liam-kingsley","cam-post",
  "troy-lennox","tess-sutton"];

// ---- fn id resolution -------------------------------------------------------
function resolveFromBuild() {
  const dir = path.resolve(process.cwd(), ".output/server");
  if (!fs.existsSync(dir)) return null;
  const f = fs.readdirSync(dir).find((x) => x.includes("server-fn-resolver"));
  if (!f) return null;
  const s = fs.readFileSync(path.join(dir, f), "utf8");
  const re = /"([a-f0-9]{64})"\s*:\s*\{[^}]*?functionName:\s*"([a-zA-Z0-9_]+)_createServerFn_handler"/g;
  const map = {};
  let m;
  while ((m = re.exec(s))) map[m[2]] = m[1];
  if (!map.sendHuddleMessage) return null;
  return { sendHuddleMessage: map.sendHuddleMessage, getTurnUpdates: map.getTurnUpdates };
}
function loadIds() {
  const built = resolveFromBuild();
  if (built) return built;
  const p = path.join(HERE, "fn-ids.json");
  if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf8"));
  throw new Error("No fn-ids: run `npm run build` then `huddle.mjs resolve`, or create fn-ids.json");
}

// ---- seroval decode (walks the node graph; robust to constant nodes) --------
const CONST = { 1: undefined, 2: null, 3: NaN, 4: Infinity, 5: -Infinity, 6: -0 };
function dec(root) {
  const reg = new Map();
  function w(n) {
    if (n == null || typeof n !== "object") return n;
    switch (n.t) {
      case 0: case 1: return n.s;
      case 3: return typeof n.s === "string" ? BigInt(n.s) : n.s;
      case 2: return n.s in CONST ? CONST[n.s] : undefined;
      case 7: return reg.get(n.i);
      case 9: { const a = []; if (n.i != null) reg.set(n.i, a); for (const it of n.a ?? []) a.push(w(it)); return a; }
      case 10: case 11: { const o = {}; if (n.i != null) reg.set(n.i, o); const k = n.p?.k ?? [], v = n.p?.v ?? []; for (let j = 0; j < k.length; j++) o[k[j]] = w(v[j]); return o; }
      default: return n.s ?? null;
    }
  }
  return w(root);
}
async function callFn(id, payload) {
  const body = JSON.stringify(await toJSONAsync({ data: payload }, { plugins }));
  const res = await fetch(`${BASE}/_serverFn/${id}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-tsr-serverFn": "true", accept: "application/json" },
    body,
  });
  const txt = await res.text();
  let node; try { node = JSON.parse(txt); } catch { return { httpError: res.status, raw: txt.slice(0, 300) }; }
  let d; try { d = dec(node); } catch (e) { return { decodeErr: String(e), raw: txt.slice(0, 300) }; }
  return d?.result ?? d;
}

// ---- args -------------------------------------------------------------------
function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t.startsWith("--")) {
      const k = t.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) a[k] = true;
      else { a[k] = next; i++; }
    } else a._.push(t);
  }
  return a;
}

function buildAgents(ids, { journey, rag }) {
  const agents = {};
  for (const id of ROSTER) {
    agents[id] = {
      backend: "openai",
      rag: { store: "azure", chunks: !!rag, triples: false, fileSearch: false, sharing: "shared" },
      journey: { enabled: !!journey },
      webSearch: false,
    };
  }
  return agents;
}

async function cmdSend(ids, args) {
  const text = args.text;
  if (!text) throw new Error("--text required");
  const is11 = args.scope === "1:1" || args.scope === "one-to-one";
  const scope = is11 ? "one-to-one" : "group";
  const agent = args.agent || (is11 ? (args.huddle || "").replace(/^dm-/, "") : undefined);
  const members = args.members
    ? String(args.members).split(",").map((s) => s.trim()).filter(Boolean)
    : is11 ? [agent] : ["iris-chase","tess-sutton","terry-locke","finn-reid","charleston-lewis","flex-grimes","cole-blake"];
  const huddleId = args.huddle || (is11 ? `dm-${agent}` : "all-members");
  const payload = {
    text, huddleId, scope, members,
    history: [],
    router: { backend: "openai", model: "gpt-5.5", fastMode: false, soloOnCoverage: true, interjections: !!args.interject, maxInterjectors: 2 },
    agents: buildAgents(ids, { journey: !!args.journey, rag: !!args.rag }),
    timeZone: "America/New_York",
    caller: { entra_email: process.env.HUDDLE_CALLER || "von.ellis@enterpriseds.io" },
    ...(is11 && agent ? { targetAgentId: agent } : {}),
  };
  const v = await callFn(ids.sendHuddleMessage, payload);
  const reps = v?.replies || [];
  const tools = (v?.toolUses || []).map((t) => t.tool || t.name || t.summary);
  const fbs = (v?.fallbacks || []).map((f) => `${f.severity || "warn"}:${f.subsystem}:${(f.inline || "").slice(0, 50)}`);
  const tasks = (v?.journeyTaskUpdates || []).map((t) => t.title).concat((v?.suggestedTasks || []).map((t) => t.title));
  console.log(`\nYOU(${scope}${agent ? " → " + agent : ""} @ ${huddleId}): ${text}`);
  console.log(`responders: [${reps.map((x) => x.agentId).join(", ")}]`);
  for (const x of reps) console.log(`  ${x.agentId}: ${String(x.text).replace(/\n/g, " ").slice(0, 320)}`);
  console.log(`toolUses: [${tools.join(", ")}]   tasks:[${tasks.join(" | ")}]`);
  if (fbs.length) console.log(`⚠ fallbacks: [${fbs.join(" ; ")}]  (a router/openai fallback = result may not reflect real routing)`);
  if (v?.httpError) console.log(`HTTP ${v.httpError}  raw=${v.raw}  (405 ⇒ stale fn id: run \`npm run build\` then \`huddle.mjs resolve\`)`);
  if (v?.decodeErr) console.log(`decodeErr ${v.decodeErr}  raw=${v.raw}`);
}

async function cmdRead(ids, args) {
  if (!ids.getTurnUpdates) throw new Error("getTurnUpdates id unknown — run resolve after a build");
  const huddleId = args.huddle;
  if (!huddleId) throw new Error("--huddle required");
  const sinceMin = Number(args["since-min"] || 60);
  const sinceMs = Date.now() - sinceMin * 60_000;
  const v = await callFn(ids.getTurnUpdates, { huddleId, sinceMs });
  const turns = Array.isArray(v) ? v : v?.turns || v?.updates || [];
  console.log(`\n=== ${huddleId} — ${turns.length} turn(s) in last ${sinceMin}m ===`);
  for (const t of turns) {
    const reps = t.replies || t.result?.replies || [];
    console.log(`[${t.status}] you: ${String(t.userText ?? t.payload?.text ?? "").slice(0, 120)}`);
    for (const r of reps) console.log(`   ${r.agentId}: ${String(r.text).replace(/\n/g, " ").slice(0, 260)}`);
  }
  if (v?.httpError) console.log(`HTTP ${v.httpError} raw=${v.raw}`);
}

function cmdResolve() {
  const built = resolveFromBuild();
  if (!built) { console.error("No ./.output build found — run `npm run build` first."); process.exit(1); }
  fs.writeFileSync(path.join(HERE, "fn-ids.json"), JSON.stringify(built, null, 2) + "\n");
  console.log("Wrote fn-ids.json:", built);
}

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0];
if (cmd === "resolve") { cmdResolve(); }
else {
  const ids = loadIds();
  if (cmd === "send") await cmdSend(ids, args);
  else if (cmd === "read") await cmdRead(ids, args);
  else { console.log("commands: send | read | resolve  (see header for usage)"); }
}
