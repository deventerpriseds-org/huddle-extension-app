#!/usr/bin/env node
// CONVERSATIONAL-QUALITY harness for the Huddle GROUP agents.
//
// This is NOT a binary pass/fail routing test. It drives REAL multi-turn group conversations
// against the deployed `sendHuddleMessage` server fn (over HTTPS, seroval-encoded), threads the
// ACCUMULATED history each turn (every user message AND every agent reply, in the app's
// HuddleMessage shape), and GRADES conversational QUALITY across turns with an LLM judge:
//
//   PROBE #3  cross-agent, cross-turn RECALL     → RECALLED / PARTIAL / BLANKED
//   PROBE #1  follow-through + state memory       → ORIENTED / LOST
//
// The CCR sandbox cannot reach *.azurestaticapps.net, so this MUST run on a GitHub Actions runner
// (see .github/workflows/conversational-quality.yml). It reuses the encode/decode helpers from
// the test-agent-serverfn skill EXACTLY (seroval toJSONAsync + node-graph decode walker).
//
// Every turn captures `decision.reason`. If ANY turn shows `LLM fallback` (quota/429/router error)
// the router never ran, so a recall grade would be meaningless — the whole run is marked
// INCONCLUSIVE and grading is skipped (per the repo's "print decision.reason / fail fast on quota"
// rules).
//
// journey is DISABLED on every agent (journey:{enabled:false}) so NO real tasks are written to the
// user's board. Probe #1 grades ORIENTATION from the reply text (the documented fallback when a
// hard task-status check isn't feasible), so it needs no task writes. Task titles referenced in
// probe #1 still use the mandatory `Test-` prefix.
//
// Recall here rides the SHORT-TERM per-huddle transcript (threaded history) — the realistic
// group-chat memory path — with RAG retrieval left off so the graded variable is the threaded
// conversation, not noise from prior real chats.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { toJSONAsync } from "seroval";
import { defaultSerovalPlugins } from "@tanstack/router-core";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.HUDDLE_BASE || "https://icy-flower-0f415200f.7.azurestaticapps.net";
const CALLER = { entra_email: process.env.HUDDLE_CALLER || "von.ellis@enterpriseds.io" };
const HUDDLE_ID = process.env.HUDDLE_ID || "all-members";
const OPENAI_KEY = process.env.OPENAI_API_KEY || "";
const JUDGE_MODEL = process.env.JUDGE_MODEL || "gpt-4o-mini";
const AGENT_MODEL = process.env.AGENT_MODEL || "gpt-4o-mini";
const plugins = defaultSerovalPlugins;

// Group members present for these probes. Every addressed agent must be here so the router can
// actually route to it. Kept small/focused (interjections off) so recall is a clean signal.
const MEMBERS = ["sam-trent", "iris-chase", "finn-reid", "flex-grimes", "tess-sutton", "terry-locke", "cole-blake"];

// ---- fn id resolution (fresh from ./.output build first, else committed fn-ids.json) ----------
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
  return map.sendHuddleMessage ? map : null;
}
function loadIds() {
  const built = resolveFromBuild();
  if (built) return built;
  const p = path.join(HERE, "..", ".claude", "skills", "test-agent-serverfn", "scripts", "fn-ids.json");
  if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf8"));
  throw new Error("No fn ids: build the app (npm run build) or provide fn-ids.json");
}

// ---- seroval decode — walks the node graph (robust to constant nodes) ------------------------
// CORRECT constant indices (verified via toJSONAsync): 0=null 1=undefined 2=true 3=false
// 4=-0 5=Infinity 6=-Infinity 7=NaN.
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
async function callFn(id, payload) {
  const body = JSON.stringify(await toJSONAsync({ data: payload }, { plugins }));
  const res = await fetch(`${BASE}/_serverFn/${id}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-tsr-serverFn": "true", accept: "application/json" },
    body,
  });
  const txt = await res.text();
  let node; try { node = JSON.parse(txt); } catch { return { httpError: res.status, raw: txt.slice(0, 400) }; }
  let d; try { d = dec(node); } catch (e) { return { decodeErr: String(e), raw: txt.slice(0, 400) }; }
  return d?.result ?? d;
}

function buildAgents() {
  const agents = {};
  for (const id of MEMBERS) {
    agents[id] = {
      backend: "openai",
      model: AGENT_MODEL,
      rag: { store: "azure", chunks: false, triples: false, fileSearch: false, sharing: "shared" },
      journey: { enabled: false }, // never write to the real board
      webSearch: false,
    };
  }
  return agents;
}

const ROUTER = {
  backend: "openai",
  model: process.env.ROUTER_MODEL || "gpt-4o-mini",
  fastMode: false,
  soloOnCoverage: true,
  interjections: false,
  maxInterjectors: 2,
};

let SEQ = 0;
const nowTs = () => Date.now() + SEQ++;

// A conversation object accumulates HuddleMessage-shaped history exactly like HuddleView does.
function newConversation() {
  return { history: [], turns: [] };
}

// Send one user turn against the live group huddle; thread the reply back into history.
async function sendTurn(ids, conv, text) {
  const userMsg = {
    id: `q-${nowTs()}`,
    huddleId: HUDDLE_ID,
    author: { kind: "user" },
    text,
    ts: nowTs(),
  };
  const payload = {
    text,
    huddleId: HUDDLE_ID,
    scope: "group",
    members: MEMBERS,
    history: conv.history.slice(-30), // schema max 40; mirror HuddleView's recent-window threading
    router: ROUTER,
    agents: buildAgents(),
    timeZone: "America/New_York",
    caller: CALLER,
  };
  const v = await callFn(ids.sendHuddleMessage, payload);
  const replies = v?.replies || [];
  const reason = v?.decision?.reason ?? (v?.httpError ? `HTTP ${v.httpError}: ${v.raw ?? ""}` : v?.decodeErr ? `decodeErr: ${v.decodeErr}` : "(no decision)");

  // Append the user message and every agent reply to history, in the app's HuddleMessage shape.
  conv.history.push(userMsg);
  for (const r of replies) {
    conv.history.push({
      id: `a-${nowTs()}`,
      huddleId: HUDDLE_ID,
      author: { kind: "agent", agentId: r.agentId },
      text: String(r.text ?? ""),
      ts: nowTs(),
    });
  }

  // Foundation: the sendHuddleMessage response also carries toolUses[] (per-tool {tool,ok,summary})
  // and fallbacks[] (subsystem/reason/severity). The harness used to drop them; capture them so
  // D-FALLBACK can report tool failures and the tool-use probes (P2/P2-TAVILY/P-NOFAKE) can observe
  // whether a tool actually fired and succeeded. Never hide these (user rule: keep fallbacks visible).
  const toolUses = Array.isArray(v?.toolUses) ? v.toolUses : [];
  const fallbacks = Array.isArray(v?.fallbacks) ? v.fallbacks : [];
  const turn = {
    user: text,
    responders: replies.map((r) => r.agentId),
    replies: replies.map((r) => ({ agentId: r.agentId, text: String(r.text ?? "") })),
    reason,
    isFallback: typeof reason === "string" && reason.startsWith("LLM fallback"),
    toolUses,
    fallbacks,
    raw: v?.httpError || v?.decodeErr ? v : undefined,
  };
  conv.turns.push(turn);
  console.log(`\nYOU: ${text}`);
  console.log(`  decision.reason: ${reason}`);
  console.log(`  responders: [${turn.responders.join(", ")}]`);
  for (const r of turn.replies) console.log(`    ${r.agentId}: ${r.text.replace(/\n/g, " ").slice(0, 400)}`);
  if (toolUses.length) console.log(`  toolUses: ${toolUses.map((t) => `${t.agentId ?? ""}:${t.tool}${t.ok === false ? "·FAILED" : ""}`).join(", ")}`);
  if (fallbacks.length) console.log(`  fallbacks: ${fallbacks.map((f) => `${f.agentId ?? ""}:${f.subsystem ?? f.reason ?? "?"}`).join(", ")}`);
  if (turn.raw) console.log(`  RAW ERROR: ${JSON.stringify(turn.raw).slice(0, 300)}`);
  return turn;
}

// Pull the reply text from a specific agent in a turn; fall back to the first reply.
function replyFrom(turn, agentId) {
  const hit = turn.replies.find((r) => r.agentId === agentId);
  if (hit) return { text: hit.text, from: agentId, addressedResponded: true };
  const first = turn.replies[0];
  return { text: first?.text ?? "", from: first?.agentId ?? "(none)", addressedResponded: false };
}

// ---- LLM judge (chat/completions) ------------------------------------------------------------
async function judge(system, user) {
  if (!OPENAI_KEY) return { grade: "NO_JUDGE", why: "OPENAI_API_KEY not set on runner" };
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_KEY}` },
      body: JSON.stringify({
        model: JUDGE_MODEL,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });
    const j = await res.json();
    if (!res.ok) return { grade: "JUDGE_ERR", why: `HTTP ${res.status}: ${JSON.stringify(j).slice(0, 200)}` };
    const content = j?.choices?.[0]?.message?.content ?? "{}";
    const parsed = JSON.parse(content);
    return { grade: String(parsed.grade || "").toUpperCase(), why: String(parsed.why || "") };
  } catch (e) {
    return { grade: "JUDGE_ERR", why: String(e).slice(0, 200) };
  }
}

// =================================================================================================
// PROBE #3 — CROSS-AGENT, CROSS-TURN RECALL
// =================================================================================================
async function probe3(ids) {
  console.log("\n\n========== PROBE #3 — CROSS-AGENT, CROSS-TURN RECALL ==========");
  const conv = newConversation();
  const t1 = await sendTurn(ids, conv,
    "Sam, in one sentence: what's the status of the investor pitch and what's the single biggest blocker right now?");
  await sendTurn(ids, conv, "Finn, roughly what's our cash runway in months right now?");
  await sendTurn(ids, conv, "Flex, one quick recovery tip after a hard week — keep it to a sentence.");
  const t4 = await sendTurn(ids, conv,
    "Iris, remind me — what did Sam say earlier about the investor pitch, and what was the single biggest blocker he mentioned?");

  const s1 = replyFrom(t1, "sam-trent");
  const i4 = replyFrom(t4, "iris-chase");

  const anyFallback = conv.turns.some((t) => t.isFallback);
  let grade = { grade: "INCONCLUSIVE", why: "router fallback on at least one turn (quota/429) — router did not run, recall not graded" };
  if (!anyFallback) {
    grade = await judge(
      "You grade whether reply B accurately RECALLS the specific facts stated earlier in reply A. " +
      "A = the ORIGINAL statement (from Sam). B = a later reply (from Iris) that claims to recall what Sam said. " +
      "Grade RECALLED if B names the SAME specific status AND the SAME specific blocker Sam stated. " +
      "Grade PARTIAL if B is directionally right but vague, or recalls only one of the two (status or blocker). " +
      "Grade BLANKED if B is generic, says it doesn't know, deflects, or INVENTS a blocker/status different from A. " +
      "Respond as JSON: {\"grade\":\"RECALLED|PARTIAL|BLANKED\",\"why\":\"one line\"}.",
      `A (Sam's original reply):\n"""${s1.text}"""\n\nB (Iris's later recall reply):\n"""${i4.text}"""`,
    );
  }

  console.log("\n--- PROBE #3 EVIDENCE ---");
  console.log(`S1 (Sam, turn 1)${s1.addressedResponded ? "" : " [NOTE: sam-trent did not respond; using " + s1.from + "]"}:\n  ${s1.text}`);
  console.log(`I4 (Iris, turn 4)${i4.addressedResponded ? "" : " [NOTE: iris-chase did not respond; using " + i4.from + "]"}:\n  ${i4.text}`);
  console.log(`GRADE: ${grade.grade} — ${grade.why}`);

  return {
    probe: "3-cross-agent-cross-turn-recall",
    grade: grade.grade,
    why: grade.why,
    inconclusive: anyFallback,
    s1_sam: s1.text,
    s1_from: s1.from,
    s1_addressedResponded: s1.addressedResponded,
    i4_iris: i4.text,
    i4_from: i4.from,
    i4_addressedResponded: i4.addressedResponded,
    decision_reasons: conv.turns.map((t) => ({ user: t.user.slice(0, 60), reason: t.reason, responders: t.responders })),
  };
}

// =================================================================================================
// PROBE #1 — FOLLOW-THROUGH + STATE MEMORY (does Sam stay oriented to the SAME task on a reversal?)
// journey disabled → ORIENTATION graded from reply text (documented fallback). Test- prefixed title.
// =================================================================================================
async function probe1(ids) {
  console.log("\n\n========== PROBE #1 — FOLLOW-THROUGH + STATE MEMORY ==========");
  const conv = newConversation();
  const t1 = await sendTurn(ids, conv,
    "Sam, change the 'Test-investor pitch deck' task status to backlog for now.");
  await sendTurn(ids, conv, "Finn, what's our current monthly burn rate, roughly?");
  await sendTurn(ids, conv, "Flex, quick tip to stay focused this afternoon — one sentence.");
  const t4 = await sendTurn(ids, conv,
    "Sam, actually move that pitch task back to active.");

  const sam1 = replyFrom(t1, "sam-trent");
  const sam4 = replyFrom(t4, "sam-trent");

  const anyFallback = conv.turns.some((t) => t.isFallback);
  let grade = { grade: "INCONCLUSIVE", why: "router fallback on at least one turn (quota/429) — router did not run, orientation not graded" };
  if (!anyFallback) {
    grade = await judge(
      "You grade whether an agent (Sam) stayed ORIENTED to the SAME task across a multi-turn reversal. " +
      "In turn 1 the user asked Sam to set the 'Test-investor pitch deck' task to BACKLOG. Two unrelated distractor " +
      "turns to other agents followed. In turn 4 the user said 'actually move that pitch task back to active' " +
      "using the vague referent 'that pitch task'. " +
      "Grade ORIENTED if Sam's turn-4 reply clearly refers to the SAME 'Test-investor pitch deck' task and " +
      "acknowledges/performs the reversal to active (it is fine if he says he cannot directly change status, " +
      "as long as he is clearly tracking the right task). " +
      "Grade LOST if Sam asks 'which task?', references a DIFFERENT task, forgets the earlier request, or gives a " +
      "generic reply that shows he lost the thread. " +
      "Respond as JSON: {\"grade\":\"ORIENTED|LOST\",\"why\":\"one line\"}.",
      `Sam turn-1 reply (set to backlog):\n"""${sam1.text}"""\n\nSam turn-4 reply (reversal to active):\n"""${sam4.text}"""`,
    );
  }

  console.log("\n--- PROBE #1 EVIDENCE ---");
  console.log(`Sam turn-1${sam1.addressedResponded ? "" : " [NOTE: sam-trent did not respond; using " + sam1.from + "]"}:\n  ${sam1.text}`);
  console.log(`Sam turn-4${sam4.addressedResponded ? "" : " [NOTE: sam-trent did not respond; using " + sam4.from + "]"}:\n  ${sam4.text}`);
  console.log(`GRADE: ${grade.grade} — ${grade.why}`);

  return {
    probe: "1-follow-through-state-memory",
    grade: grade.grade,
    why: grade.why,
    inconclusive: anyFallback,
    sam_turn1: sam1.text,
    sam_turn1_from: sam1.from,
    sam_turn1_addressedResponded: sam1.addressedResponded,
    sam_turn4: sam4.text,
    sam_turn4_from: sam4.from,
    sam_turn4_addressedResponded: sam4.addressedResponded,
    decision_reasons: conv.turns.map((t) => ({ user: t.user.slice(0, 60), reason: t.reason, responders: t.responders })),
  };
}

// Per-probe diagnostics (D-FALLBACK): every tool-use + fallback seen across the probe's turns.
function diag(conv) {
  return {
    fallbacks: conv.turns.flatMap((t) => t.fallbacks ?? []),
    toolUses: conv.turns.flatMap((t) => t.toolUses ?? []),
  };
}
const reasonsOf = (conv) => conv.turns.map((t) => ({ user: t.user.slice(0, 60), reason: t.reason, responders: t.responders }));
const fellBack = (conv) => conv.turns.some((t) => t.isFallback);

// =================================================================================================
// PROBE #3b — DEEPER-THAN-SURFACE RECALL (comprehension, not parroting)
// =================================================================================================
async function probe3b(ids) {
  console.log("\n\n========== PROBE #3b — DEEPER-THAN-SURFACE RECALL ==========");
  const conv = newConversation();
  const t1 = await sendTurn(ids, conv, "Sam, in one sentence: what's the single biggest blocker on the investor pitch right now, and why is it the blocker?");
  await sendTurn(ids, conv, "Finn, roughly what's our cash runway in months?");
  await sendTurn(ids, conv, "Flex, one quick recovery tip after a hard week — one sentence.");
  const t4 = await sendTurn(ids, conv, "Iris, based on what Sam said about the pitch blocker — in your OWN words, why is it the blocker, and what would actually unblock it?");
  const s1 = replyFrom(t1, "sam-trent");
  const i4 = replyFrom(t4, "iris-chase");
  let grade = { grade: "INCONCLUSIVE", why: "router fallback on a turn — not graded" };
  if (!fellBack(conv)) {
    grade = await judge(
      "You grade whether reply B shows real COMPREHENSION of the blocker in reply A, not verbatim parroting. " +
      "A = Sam's statement of the pitch blocker. B = Iris asked to explain IN HER OWN WORDS why it's the blocker and what would unblock it. " +
      "Grade UNDERSTOOD if B restates the blocker in DIFFERENT words AND adds a correct cause/consequence or a plausible unblock that follows from A. " +
      "Grade SURFACE if B mostly repeats A's wording with no added understanding (high lexical overlap, no new insight). " +
      "Grade BLANKED if B is generic, says it doesn't know, deflects, or invents a different blocker. " +
      "Respond as JSON: {\"grade\":\"UNDERSTOOD|SURFACE|BLANKED\",\"why\":\"one line\"}.",
      `A (Sam):\n"""${s1.text}"""\n\nB (Iris, in own words):\n"""${i4.text}"""`);
  }
  console.log(`GRADE: ${grade.grade} — ${grade.why}`);
  return { probe: "3b-deeper-recall", grade: grade.grade, why: grade.why, inconclusive: fellBack(conv), sam: s1.text, sam_addressedResponded: s1.addressedResponded, iris: i4.text, iris_addressedResponded: i4.addressedResponded, decision_reasons: reasonsOf(conv), diag: diag(conv) };
}

// =================================================================================================
// PROBE P-RETAIN — WITHIN-CALL CONTEXT RETENTION (same agent, its OWN earlier context)
// =================================================================================================
async function probeRetain(ids) {
  console.log("\n\n========== PROBE P-RETAIN — WITHIN-CALL CONTEXT RETENTION ==========");
  const conv = newConversation();
  const t1 = await sendTurn(ids, conv, "Iris, for this conversation note one item: the 'Test-dentist appointment' task — I think it's a leftover we'll want to remove. Just acknowledge it for now.");
  await sendTurn(ids, conv, "Finn, roughly what's our monthly burn?");
  await sendTurn(ids, conv, "Flex, one sentence — how to reset focus mid-afternoon.");
  const t4 = await sendTurn(ids, conv, "Iris, that dentist item we flagged at the start — go ahead and remove it.");
  const i1 = replyFrom(t1, "iris-chase");
  const i4 = replyFrom(t4, "iris-chase");
  let grade = { grade: "INCONCLUSIVE", why: "router fallback on a turn — not graded" };
  if (!fellBack(conv)) {
    grade = await judge(
      "You grade whether an agent (Iris) RETAINED context it established earlier in the SAME conversation. " +
      "In an early turn she acknowledged a specific item: the 'Test-dentist appointment' task, flagged as a leftover to remove. Two unrelated distractor turns followed. " +
      "In the final turn the user said 'that dentist item we flagged at the start — remove it' using the referent 'that dentist item'. " +
      "Grade RETAINED if her final reply clearly refers to the SAME dentist task and acts on / acknowledges the removal (fine if she says she can't directly delete, as long as she's tracking the right item). " +
      "Grade BLANKED if she says she can't locate the previous context, asks 'which task / what item?', references something else, or shows no memory of what she just acknowledged. " +
      "Respond as JSON: {\"grade\":\"RETAINED|BLANKED\",\"why\":\"one line\"}.",
      `Iris early reply (acknowledged the item):\n"""${i1.text}"""\n\nIris final reply (remove it):\n"""${i4.text}"""`);
  }
  console.log(`GRADE: ${grade.grade} — ${grade.why}`);
  return { probe: "P-RETAIN-within-call-retention", grade: grade.grade, why: grade.why, inconclusive: fellBack(conv), iris_early: i1.text, iris_early_addressedResponded: i1.addressedResponded, iris_final: i4.text, iris_final_addressedResponded: i4.addressedResponded, decision_reasons: reasonsOf(conv), diag: diag(conv) };
}

// =================================================================================================
// PROBE P-GROUND — GROUNDEDNESS / ANTI-HALLUCINATION (no invented files/context)
// =================================================================================================
async function probeGround(ids) {
  console.log("\n\n========== PROBE P-GROUND — GROUNDEDNESS / ANTI-HALLUCINATION ==========");
  const conv = newConversation();
  const t1 = await sendTurn(ids, conv, "Flex, hey.");
  const f1 = replyFrom(t1, "flex-grimes");
  let grade = { grade: "INCONCLUSIVE", why: "router fallback on a turn — not graded" };
  if (!fellBack(conv)) {
    grade = await judge(
      "You grade whether an agent INVENTED context/artifacts it was never given. The user sent only a bare greeting ('hey') — NO files, NO documents, NO prior data were provided. " +
      "Grade GROUNDED if the reply greets or offers help within its real role WITHOUT claiming the user uploaded files/documents/data or referencing content never provided. " +
      "Grade HALLUCINATED if the reply references 'the uploaded files', documents, a knowledge base, or any specific content/state the user never gave (e.g. 'what would you like to do with the uploaded files?'). " +
      "Respond as JSON: {\"grade\":\"GROUNDED|HALLUCINATED\",\"why\":\"one line\"}.",
      `Agent reply to a bare 'hey':\n"""${f1.text}"""`);
  }
  console.log(`GRADE: ${grade.grade} — ${grade.why}`);
  return { probe: "P-GROUND-anti-hallucination", grade: grade.grade, why: grade.why, inconclusive: fellBack(conv), agent_reply: f1.text, from: f1.from, addressedResponded: f1.addressedResponded, decision_reasons: reasonsOf(conv), diag: diag(conv) };
}

// =================================================================================================
// PROBE P-ACCOUNT — ACCOUNTABILITY UNDER CHALLENGE (reconcile, don't double down)
// =================================================================================================
async function probeAccount(ids) {
  console.log("\n\n========== PROBE P-ACCOUNT — ACCOUNTABILITY UNDER CHALLENGE ==========");
  const conv = newConversation();
  await sendTurn(ids, conv, "Flex, hey.");
  const t2 = await sendTurn(ids, conv, "Just to be clear — I have NOT uploaded any files or given you any documents. You don't have any files of mine, correct?");
  const f2 = replyFrom(t2, "flex-grimes");
  let grade = { grade: "INCONCLUSIVE", why: "router fallback on a turn — not graded" };
  if (!fellBack(conv)) {
    grade = await judge(
      "You grade whether an agent RECONCILES when the user corrects a false premise, or DOUBLES DOWN. " +
      "The user explicitly stated they have NOT uploaded any files or given any documents, and asked the agent to confirm it has none. " +
      "Grade RECONCILED if the reply agrees it has no files/documents or otherwise accepts the correction without re-asserting that files exist. " +
      "Grade DOUBLED_DOWN if the reply insists the user HAS uploaded files, offers to 'search the uploaded files', or otherwise re-asserts the false premise the user just denied. " +
      "Respond as JSON: {\"grade\":\"RECONCILED|DOUBLED_DOWN\",\"why\":\"one line\"}.",
      `Agent reply after the user denied giving any files:\n"""${f2.text}"""`);
  }
  console.log(`GRADE: ${grade.grade} — ${grade.why}`);
  return { probe: "P-ACCOUNT-no-double-down", grade: grade.grade, why: grade.why, inconclusive: fellBack(conv), agent_reply: f2.text, from: f2.from, addressedResponded: f2.addressedResponded, decision_reasons: reasonsOf(conv), diag: diag(conv) };
}

// =================================================================================================
// PROBE P-REPEAT — NO BROKEN-RECORD (deterministic near-dup + judge)
// =================================================================================================
function normWords(s) { return String(s || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim(); }
function jaccard(a, b) {
  const A = new Set(normWords(a).split(" ").filter(Boolean));
  const B = new Set(normWords(b).split(" ").filter(Boolean));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter);
}
async function probeRepeat(ids) {
  console.log("\n\n========== PROBE P-REPEAT — NO BROKEN-RECORD ==========");
  const conv = newConversation();
  const t1 = await sendTurn(ids, conv, "Iris, quick — what's the overall state of things today?");
  const t2 = await sendTurn(ids, conv, "Iris, anything else worth flagging on the board?");
  const t3 = await sendTurn(ids, conv, "Iris, and how are we tracking overall right now?");
  const r = [replyFrom(t1, "iris-chase"), replyFrom(t2, "iris-chase"), replyFrom(t3, "iris-chase")];
  const texts = r.map((x) => x.text);
  const responded = r.filter((x) => x.addressedResponded).length;
  let maxSim = 0, dupPair = null;
  for (let i = 0; i < texts.length; i++) for (let j = i + 1; j < texts.length; j++) { const s = jaccard(texts[i], texts[j]); if (s > maxSim) { maxSim = s; dupPair = [i + 1, j + 1]; } }
  const REPEAT_THRESHOLD = 0.6;
  let grade = { grade: "INCONCLUSIVE", why: "router fallback on a turn — not graded" };
  if (fellBack(conv)) { /* keep INCONCLUSIVE */ }
  else if (responded < 2) grade = { grade: "INCONCLUSIVE", why: `iris-chase responded on only ${responded} of 3 turns — nothing to compare` };
  else if (maxSim >= REPEAT_THRESHOLD) grade = { grade: "REPEATED", why: `two replies are ${(maxSim * 100).toFixed(0)}% word-overlap (near-duplicate) — broken record` };
  else {
    grade = await judge(
      "You grade whether an agent gave VARIED replies across three separate prompts, or repeated itself (broken record). " +
      "Grade VARIED if the three replies are substantively distinct. Grade REPEATED if two or more replies are essentially the same sentence/content restated. " +
      "Respond as JSON: {\"grade\":\"VARIED|REPEATED\",\"why\":\"one line\"}.",
      `Reply 1:\n"""${texts[0]}"""\n\nReply 2:\n"""${texts[1]}"""\n\nReply 3:\n"""${texts[2]}"""`);
  }
  console.log(`  max word-overlap: ${(maxSim * 100).toFixed(0)}%${dupPair ? ` (replies ${dupPair[0]}&${dupPair[1]})` : ""}`);
  console.log(`GRADE: ${grade.grade} — ${grade.why}`);
  return { probe: "P-REPEAT-no-broken-record", grade: grade.grade, why: grade.why, inconclusive: grade.grade === "INCONCLUSIVE", maxWordOverlap: Number(maxSim.toFixed(3)), replies: texts, responded, decision_reasons: reasonsOf(conv), diag: diag(conv) };
}

// ---- main -----------------------------------------------------------------------------------
const ids = loadIds();
console.log(`Base: ${BASE}`);
console.log(`sendHuddleMessage id: ${ids.sendHuddleMessage}`);
console.log(`caller: ${CALLER.entra_email}  huddle: ${HUDDLE_ID}  members: [${MEMBERS.join(", ")}]`);
console.log(`router model: ${ROUTER.model}  agent model: ${AGENT_MODEL}  judge model: ${JUDGE_MODEL}  judge: ${OPENAI_KEY ? "enabled" : "DISABLED (no OPENAI_API_KEY)"}`);

// Tier A — the re-runnable text-graded core. Each probe is self-contained + graded; add new Tier A
// probes here. Tier B/C (journey-on, tool-enabled), Tier D (ceremony run) and Tier E (voice UAT)
// run in their own harnesses (see docs/ceremony-quality-probes.md).
const results = {
  probe3: await probe3(ids),
  probe1: await probe1(ids),
  probe3b: await probe3b(ids),
  pRetain: await probeRetain(ids),
  pGround: await probeGround(ids),
  pAccount: await probeAccount(ids),
  pRepeat: await probeRepeat(ids),
};

const all = Object.values(results);
const allReasons = all.flatMap((r) => r.decision_reasons ?? []);
const anyFallback = allReasons.some((r) => typeof r.reason === "string" && r.reason.startsWith("LLM fallback"));

// D-FALLBACK aggregate — every tool failure / fallback seen across all probes, surfaced (never hidden).
const allFallbacks = all.flatMap((r) => r.diag?.fallbacks ?? []);
const allToolUses = all.flatMap((r) => r.diag?.toolUses ?? []);
const toolFailures = allToolUses.filter((t) => t && t.ok === false);

console.log("\n\n===GRADES===");
for (const r of all) console.log(`  ${r.probe}: ${r.grade}${r.inconclusive ? " (INCONCLUSIVE)" : ""} — ${r.why}`);
if (toolFailures.length) console.log(`  D-FALLBACK: ${toolFailures.length} tool failure(s): ${toolFailures.map((t) => `${t.agentId ?? ""}:${t.tool}`).join(", ")}`);

console.log("\n\n===STRUCTURED_RESULTS_JSON===");
console.log(JSON.stringify({
  harness: "conversational-quality",
  base: BASE,
  huddleId: HUDDLE_ID,
  routerRanCleanly: !anyFallback,
  anyRouterFallback: anyFallback,
  grades: all.map((r) => ({ probe: r.probe, grade: r.grade, why: r.why, inconclusive: !!r.inconclusive })),
  diagnostics: { toolFailures, fallbacks: allFallbacks, toolUseCount: allToolUses.length },
  probes: results,
}, null, 2));
console.log("===END_STRUCTURED_RESULTS===");

// Exit 0 always — this is a graded QUALITY harness, not a binary gate. A non-fallback run that
// grades BLANKED/LOST/HALLUCINATED is a valid, informative result, not a script failure.
process.exit(0);
