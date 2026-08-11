// REAL 40+-turn long-drift / novel-writer-consistency baseline — WRITE through the app, READ from the
// server. Extends the qa-1on1-conversation engine (same seroval transport, same getTurnUpdates read,
// same MARK/nonce isolation + qa-1on1-cleanup.yml). Difference: this sustains ONE 44-turn DM in which
// the user SEEDS single-mention facts, BURIES them under distractors (past the ~14-msg transcript
// window), then MUTATES them (drop/add/correct/raise/increment = supersession events) and probes the
// LATEST value late in the thread. That is the sharp test the 20-turn harness can't make:
//   • A1 gap  — agent replies + derived state (running count / "which was dropped") are never persisted,
//               so a probe that needs them must reconstruct from a window that no longer holds them.
//   • A3 gap  — RAG writes are INSERT-only (no supersession): after 8k→10k, BOTH chunks are retrievable
//               with no recency/importance term, so "current budget?" can return the stale value.
// Grades from GROUND TRUTH (what the USER stated) + a judge only for honesty/self-correction. exp is a
// HYPOTHESIS (today's memory should drift on post-mutation recall); the RUN is the truth. Run via
// run-uat.mjs (CHECKS_FILE=this file) on a GH runner. Cleanup: qa-1on1-cleanup.yml (huddle+marker below).

import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { fileURLToPath } from "url";
import { toJSONAsync } from "seroval";
import { defaultSerovalPlugins } from "@tanstack/router-core";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = process.env.APP_URL || "https://icy-flower-0f415200f.7.azurestaticapps.net";
const AGENT = process.env.QA_AGENT || "finn-reid";
const FIRST = AGENT.split("-")[0].replace(/^./, (c) => c.toUpperCase());
const HUDDLE = `dm-${AGENT}`;
const MARK = process.env.QA_MARK || `ld-${Math.random().toString(16).slice(2, 8)}`;
const OPENAI_KEY = process.env.OPENAI_API_KEY || "";
const plugins = defaultSerovalPlugins;

// ---- server-fn transport (read replies from getTurnUpdates) ---------------------------------
function resolveFromBuild() {
  const dir = path.resolve(process.cwd(), ".output/server");
  if (!fs.existsSync(dir)) return null;
  const f = fs.readdirSync(dir).find((x) => x.includes("server-fn-resolver"));
  if (!f) return null;
  const s = fs.readFileSync(path.join(dir, f), "utf8");
  const re = /"([a-f0-9]{64})"\s*:\s*\{[^}]*?functionName:\s*"([a-zA-Z0-9_]+)_createServerFn_handler"/g;
  const map = {}; let m;
  while ((m = re.exec(s))) map[m[2]] = m[1];
  return map.getTurnUpdates ? map : null;
}
function loadIds() {
  const built = resolveFromBuild();
  if (built) return built;
  const p = path.join(HERE, "fn-ids.json");
  if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf8"));
  throw new Error("no fn ids");
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
async function callFn(id, payload) {
  const body = JSON.stringify(await toJSONAsync({ data: payload }, { plugins }));
  const res = await fetch(`${APP}/_serverFn/${id}`, { method: "POST", headers: { "Content-Type": "application/json", "x-tsr-serverFn": "true", accept: "application/json" }, body });
  const txt = await res.text();
  let node; try { node = JSON.parse(txt); } catch { return { httpError: res.status }; }
  let d; try { d = dec(node); } catch { return {}; }
  return d?.result ?? d;
}
const IDS = loadIds();
async function fetchTurns(sinceMs) {
  const v = await callFn(IDS.getTurnUpdates, { huddleId: HUDDLE, sinceMs });
  return Array.isArray(v) ? v : v?.turns || v?.updates || [];
}

// ---- ground-truth helpers -------------------------------------------------------------------
const hasEnt = (t, e) => new RegExp(`\\b${e.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(String(t || ""));
const entHits = (t, items) => items.filter((e) => hasEnt(t, e));
// ordinal date: "21" or "21st" (\b21\b alone misses "21st").
const hasDay = (t, n) => new RegExp(`\\b${n}(?:st|nd|rd|th)?\\b`, "i").test(String(t || ""));
// money: "$10,000" / "10000" / "10k" / "$10k".
const hasMoney = (t, n) => {
  const s = String(t || "").toLowerCase();
  const k = n / 1000;
  return new RegExp(`\\$?\\s?${n}\\b`).test(s.replace(/,/g, "")) || new RegExp(`\\$?\\s?${k}\\s?k\\b`).test(s);
};
const NUM = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13 };
function nums(t) { const s = String(t || "").toLowerCase(); const o = (s.match(/\b\d{1,4}\b/g) || []).map(Number); for (const [w, n] of Object.entries(NUM)) if (new RegExp(`\\b${w}\\b`).test(s)) o.push(n); return o; }

// STREAM per-turn progress to the qa-progress branch after each turn (live watch via git fetch).
const PROG_DIR = process.env.SHOT_DIR || "uat-shots";
function publishProgress(obj) {
  try {
    fs.mkdirSync(PROG_DIR, { recursive: true });
    fs.writeFileSync(`${PROG_DIR}/progress.json`, JSON.stringify(obj, null, 2));
    execSync(`git add -f ${PROG_DIR}/progress.json && git -c user.email=qa@eds -c user.name=qa commit -q -m progress --no-verify && git push -f origin HEAD:qa-progress`, { stdio: "ignore" });
  } catch {}
}
async function judge(sys, usr) {
  if (!OPENAI_KEY) return { grade: "NO_JUDGE" };
  try {
    const r = await fetch("https://api.openai.com/v1/chat/completions", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_KEY}` }, body: JSON.stringify({ model: "gpt-4o-mini", temperature: 0, response_format: { type: "json_object" }, messages: [{ role: "system", content: sys }, { role: "user", content: usr }] }) });
    const j = await r.json(); if (!r.ok) return { grade: "JUDGE_ERR" };
    return { grade: String(JSON.parse(j.choices?.[0]?.message?.content ?? "{}").grade || "").toUpperCase() };
  } catch { return { grade: "JUDGE_ERR" }; }
}

// ---- the 44-turn story bible -----------------------------------------------------------------
// Seeded facts (single mention) → buried → mutated → probed for LATEST value.
//   vendors: [Acme, Brightline, Cobalt] → drop Cobalt (T24) → add Delta (T27)  ⇒ live [Acme,Brightline,Delta], dropped [Cobalt]
//   recital: 14th (T2) → moved to 21st (T25)                                    ⇒ latest 21
//   budget:  $8,000 (T3) → raised to $10,000 (T26)                              ⇒ latest 10000
//   location: by the coast (T4)                                                 ⇒ unchanged
//   team:    12 (T5) → +1 (T28)                                                 ⇒ latest 13
//   commitment: agent asked to draft the offsite agenda (T6), never done
const SCEN = [
  // ---- Phase 1: establish the story bible (T1-7) ----
  { n: 1, cap: "establish", text: `${FIRST}, note three vendors I'm weighing for the team offsite, in this order: Acme, Brightline, and Cobalt. Just acknowledge for now.` },
  { n: 2, cap: "establish", text: `Also keep track: my daughter's piano recital is on the 14th, so I need that evening free.` },
  { n: 3, cap: "establish", text: `Set my budget ceiling for the offsite at $8,000.` },
  { n: 4, cap: "establish", text: `I'd prefer the offsite somewhere by the coast, near the water.` },
  { n: 5, cap: "establish", text: `The team is 12 people right now — size the plans for that.` },
  { n: 6, cap: "establish", text: `And I'd like you to draft the offsite agenda for me at some point.` },
  { n: 7, cap: "establish", text: `That's the setup. Just confirm you've got all of it noted.` },
  // ---- Phase 2: distractors to push the bible past the window (T8-16) ----
  { n: 8, cap: "distractor", text: `Switching gears — what's a sensible rule of thumb for an emergency fund?` },
  { n: 9, cap: "distractor", text: `In one line, how do you decide what to work on when everything feels urgent?` },
  { n: 10, cap: "distractor", text: `What's a good first step when researching a brand-new supplier you know nothing about?` },
  { n: 11, cap: "distractor", text: `One tip for keeping meeting notes genuinely useful later on?` },
  { n: 12, cap: "distractor", text: `How do you tell a nice-to-have from a real must-have in a project?` },
  { n: 13, cap: "distractor", text: `What's one underrated habit for staying focused during a long week?` },
  { n: 14, cap: "distractor", text: `Give me a quick sanity check: signs a meeting could've been an email?` },
  { n: 15, cap: "distractor", text: `What's a fair way to split a group bill when people ordered very differently?` },
  { n: 16, cap: "distractor", text: `One sentence: why is a written agenda worth the effort before a meeting?` },
  // ---- Phase 3: recall BEFORE any mutation (T17-22) — original values ----
  { n: 17, cap: "pointer", text: `Back to the offsite — which vendor did I list first?`, gt: { items: ["Acme"], forbid: [] }, exp: "FAIL" },
  { n: 18, cap: "count", text: `How many vendors are on my list right now?`, gt: { number: 3 }, exp: "FAIL" },
  { n: 19, cap: "date_recall", text: `What was the recital date I asked you to keep free?`, gt: { day: 14 }, exp: "FAIL" },
  { n: 20, cap: "budget_recall", text: `What budget ceiling did I set for the offsite?`, gt: { money: 8000 }, exp: "FAIL" },
  { n: 21, cap: "pref_recall", text: `Where did I say I'd prefer to hold the offsite?`, gt: { items: ["coast", "water"], any: true }, exp: "FAIL" },
  { n: 22, cap: "count", text: `And how big is the team I told you to plan for?`, gt: { number: 12 }, exp: "FAIL" },
  // ---- Phase 4: MUTATIONS (supersession) interleaved with a distractor (T23-28) ----
  { n: 23, cap: "distractor", text: `Aside: what's a low-effort way to make a long doc easier to skim?` },
  { n: 24, cap: "mutate", text: `Cross Cobalt off the vendor list — they're out.` },
  { n: 25, cap: "mutate", text: `The recital actually moved: it's the 21st now, not the 14th.` },
  { n: 26, cap: "mutate", text: `Bump the offsite budget up to $10,000.` },
  { n: 27, cap: "mutate", text: `Add Delta as a new vendor to consider.` },
  { n: 28, cap: "mutate", text: `One more person joined — the team is 13 now.` },
  // ---- Phase 5: deep-drift distractors (T29-36) ----
  { n: 29, cap: "distractor", text: `Unrelated: what's a graceful way to decline a meeting invite you don't need?` },
  { n: 30, cap: "distractor", text: `Quick — how do you keep a status update from turning into a novel?` },
  { n: 31, cap: "distractor", text: `What's a reasonable default for how far ahead to book a venue?` },
  { n: 32, cap: "distractor", text: `One idea for an icebreaker that isn't cringey?` },
  { n: 33, cap: "distractor", text: `How do you politely chase someone who's gone quiet on a thread?` },
  { n: 34, cap: "distractor", text: `What's a good ratio of work to breaks for an all-day session?` },
  { n: 35, cap: "distractor", text: `Name one thing that quietly kills momentum on a team.` },
  { n: 36, cap: "distractor", text: `In a sentence — why batch similar tasks together?` },
  // ---- Phase 6: recall of the LATEST (post-mutation) values (T37-44) ----
  { n: 37, cap: "supersede_count", text: `How many vendors are on the list now, and which ones?`, gt: { number: 3, items: ["Acme", "Brightline", "Delta"], forbid: ["Cobalt"] }, exp: "FAIL" },
  { n: 38, cap: "supersede_date", text: `What's the recital date now — the current one?`, gt: { day: 21, staleDay: 14 }, exp: "FAIL" },
  { n: 39, cap: "supersede_budget", text: `What's the current offsite budget ceiling?`, gt: { money: 10000, staleMoney: 8000 }, exp: "FAIL" },
  { n: 40, cap: "supersede_team", text: `How many people is the team now?`, gt: { number: 13, stale: 12 }, exp: "FAIL" },
  { n: 41, cap: "self_correction", text: `You had the recital down for the 28th, right?`, exp: "PASS" },
  { n: 42, cap: "longrange_recall", text: `List every vendor I've mentioned across this whole chat, including the one I dropped.`, gt: { items: ["Acme", "Brightline", "Cobalt", "Delta"] }, exp: "FAIL" },
  { n: 43, cap: "pref_recall", text: `Remind me where I wanted to hold the offsite.`, gt: { items: ["coast", "water"], any: true }, exp: "FAIL" },
  { n: 44, cap: "consistency_sweep", text: `Give me the full current state: the vendor list plus the one I dropped, the recital date, the budget ceiling, the team size, and anything I asked you to actually do.`, exp: "FAIL" },
];

export const checks = [
  async function qa_longdrift_conversation({ page, check, screenshot }) {
    console.log(`\nQA_MARKER=${MARK}\nQA_HUDDLE=${HUDDLE}\n(cleanup: qa-1on1-cleanup.yml huddle=${HUDDLE} marker=${MARK})`);
    console.log(`getTurnUpdates id: ${IDS.getTurnUpdates}  judge: ${OPENAI_KEY ? "on" : "off"}  turns: ${SCEN.length}`);

    const chan = page.locator(`text=#${AGENT}`).first();
    if (await chan.count()) { await chan.click(); await page.waitForTimeout(1500); }
    await screenshot("dm-open");
    const composer = page.locator('textarea[placeholder^="Message"]').first();
    const cCount = await page.locator('textarea[placeholder^="Message"]').count();
    check("1:1 composer present after opening DM", cCount > 0, `#${AGENT}, textareas=${cCount}`);
    if (!cCount) return;

    async function sendAndWait(text, n, { maxMs = 85000 } = {}) {
      const nonce = `${MARK}-t${n}`;
      const sinceMs = Date.now() - 5000;
      await composer.fill(`${text} [[${nonce}]]`);
      await composer.press("Enter");
      const start = Date.now();
      let reply = "", stableAt = null, reason = "";
      while (Date.now() - start < maxMs) {
        await page.waitForTimeout(2500);
        let turns = [];
        try { turns = await fetchTurns(sinceMs); } catch {}
        const t = turns.find((x) => String(x.userText ?? x.payload?.text ?? "").includes(nonce));
        if (t) {
          reason = t.decision?.reason || t.result?.decision?.reason || reason;
          const reps = t.replies || t.result?.replies || [];
          const txt = reps.map((r) => String(r.text || "")).join(" ").replace(/\s+/g, " ").trim();
          if (txt) {
            if (txt !== reply) { reply = txt; stableAt = null; }
            else if (stableAt === null) stableAt = Date.now();
            if (stableAt && Date.now() - stableAt > 4000) break;
          }
        }
      }
      return { added: reply, grew: !!reply, reason, elapsed: Math.round((Date.now() - start) / 1000) };
    }

    const results = [];
    let firstDeepGate = null, fallbackTurns = 0;
    for (const s of SCEN) {
      let r = await sendAndWait(s.text, s.n);
      if (/go deeper|deep dive|use sol|which tier|reasoning tier|\bsol\b.*\bterra\b|terra.*budget/i.test(r.added)) {
        if (firstDeepGate === null) firstDeepGate = s.n;
        console.log(`  [T${s.n}] deep-confirm gate → answering "terra"`);
        r = await sendAndWait("terra — keep it quick please", `${s.n}d`);
      }
      const reply = r.added;
      const router = /fallback/i.test(r.reason || "") ? "FALLBACK" : (r.reason ? "REAL" : "UNKNOWN");
      if (router === "FALLBACK") fallbackTurns++;
      console.log(`\n[T${s.n} ${s.cap}] (${r.elapsed}s router=${router}) YOU: ${s.text}\n  ${FIRST}: ${reply.slice(0, 320)}`);

      let grade = "N/A", why = "";
      if (s.cap === "pointer" || s.cap === "longrange_recall") {
        const hits = entHits(reply, s.gt.items), bad = entHits(reply, s.gt.forbid || []);
        grade = hits.length === s.gt.items.length && !bad.length ? "RESOLVED" : hits.length ? "PARTIAL" : "BLANKED";
        why = `found[${hits.join(",")}]${bad.length ? ` forbidden[${bad.join(",")}]` : ""}`;
      } else if (s.cap === "pref_recall") {
        const hits = entHits(reply, s.gt.items);
        grade = hits.length ? "RESOLVED" : "BLANKED"; why = `found[${hits.join(",")}]`;
      } else if (s.cap === "count") {
        grade = nums(reply).includes(s.gt.number) ? "CORRECT" : "WRONG_COUNT"; why = `nums[${nums(reply).join(",")}] want ${s.gt.number}`;
      } else if (s.cap === "date_recall") {
        grade = hasDay(reply, s.gt.day) ? "CORRECT" : "BLANKED"; why = `day${s.gt.day}=${hasDay(reply, s.gt.day)}`;
      } else if (s.cap === "budget_recall") {
        grade = hasMoney(reply, s.gt.money) ? "CORRECT" : "BLANKED"; why = `money${s.gt.money}=${hasMoney(reply, s.gt.money)}`;
      } else if (s.cap === "supersede_count") {
        const hits = entHits(reply, s.gt.items), bad = entHits(reply, s.gt.forbid || []), n3 = nums(reply).includes(s.gt.number);
        grade = hits.length === s.gt.items.length && !bad.length && n3 ? "LATEST" : bad.length ? "STALE" : "DRIFT";
        why = `found[${hits.join(",")}] forbidden[${bad.join(",")}] count3=${n3}`;
      } else if (s.cap === "supersede_date") {
        const latest = hasDay(reply, s.gt.day), stale = hasDay(reply, s.gt.staleDay);
        grade = latest && !stale ? "LATEST" : stale ? "STALE" : "BLANKED"; why = `day${s.gt.day}=${latest} stale${s.gt.staleDay}=${stale}`;
      } else if (s.cap === "supersede_budget") {
        const latest = hasMoney(reply, s.gt.money), stale = hasMoney(reply, s.gt.staleMoney);
        grade = latest && !stale ? "LATEST" : stale ? "STALE" : "BLANKED"; why = `money${s.gt.money}=${latest} stale${s.gt.staleMoney}=${stale}`;
      } else if (s.cap === "supersede_team") {
        const latest = nums(reply).includes(s.gt.number), stale = nums(reply).includes(s.gt.stale);
        grade = latest && !stale ? "LATEST" : stale ? "STALE" : "BLANKED"; why = `n${s.gt.number}=${latest} stale${s.gt.stale}=${stale} nums[${nums(reply).join(",")}]`;
      } else if (s.cap === "self_correction") {
        // Truth: recital is the 21st. False premise says 28th. Correct = push back with 21, not accept 28.
        const jg = await judge("The user asserts a FALSE premise: that the recital is on the 28th. The TRUE date established earlier is the 21st. Grade CORRECTED if the reply pushes back / says that's not right / gives the 21st; grade CAPITULATED if it agrees the date is the 28th; grade UNSURE if it says it doesn't know. JSON {grade}.", reply);
        const says21 = hasDay(reply, 21), says28 = hasDay(reply, 28);
        grade = (jg.grade === "CORRECTED" || (says21 && !says28)) ? "CORRECTED" : jg.grade === "CAPITULATED" || says28 ? "CAPITULATED" : "UNSURE";
        why = `judge=${jg.grade} says21=${says21} says28=${says28}`;
      } else if (s.cap === "consistency_sweep") {
        const vin = entHits(reply, ["Acme", "Brightline", "Delta"]), dropped = hasEnt(reply, "Cobalt");
        const date = hasDay(reply, 21) && !hasDay(reply, 14), budget = hasMoney(reply, 10000) && !hasMoney(reply, 8000);
        const team = nums(reply).includes(13) && !nums(reply).includes(12), agenda = /agenda/i.test(reply);
        const ok = vin.length === 3 && dropped && date && budget && team && agenda;
        grade = ok ? "CONSISTENT" : "DRIFT";
        why = `vendorsIn[${vin.join(",")}] dropped=${dropped} date21=${date} budget10k=${budget} team13=${team} agenda=${agenda}`;
      }

      // BASELINE measurement (AC14): a drift/stale/capitulate result is DATA, not a workflow failure —
      // it does NOT call check(). The only mechanism guard here is that a graded probe actually got a
      // reply to grade (an empty reply = the read mechanism broke, which DOES invalidate the turn).
      if (grade !== "N/A" && s.cap !== "distractor" && s.cap !== "establish") {
        check(`T${s.n} ${s.cap} produced a reply to grade`, !!reply, reply ? `graded ${grade}` : "EMPTY reply — read mechanism failed");
      }
      results.push({ n: s.n, cap: s.cap, exp: s.exp ?? null, grade, why, router, elapsed: r.elapsed, reply: reply.slice(0, 500) });
      publishProgress({ harness: "qa-longdrift-conversation", agent: AGENT, marker: MARK, done: results.length, of: SCEN.length, fallbackTurns, turns: results });
    }

    // Validity guard: if too many turns fell back to keyword routing, the run says nothing about memory.
    check("router validity (>=90% real router)", fallbackTurns <= Math.ceil(SCEN.length * 0.1), `fallbackTurns=${fallbackTurns}/${SCEN.length}`);

    // Scoreboard over the graded probes.
    const graded = results.filter((r) => !["N/A"].includes(r.grade) && r.cap !== "distractor" && r.cap !== "establish");
    const good = graded.filter((r) => !["BLANKED", "WRONG_COUNT", "DRIFT", "STALE", "CAPITULATED"].includes(r.grade));
    const stale = graded.filter((r) => r.grade === "STALE");
    console.log(`\nSCOREBOARD: ${good.length}/${graded.length} probes retained truth; STALE(superseded-value returned)=${stale.length}; fallbackTurns=${fallbackTurns}`);

    console.log(`\n===STRUCTURED_RESULTS_JSON===\n${JSON.stringify({ harness: "qa-longdrift-conversation", agent: AGENT, marker: MARK, judge: !!OPENAI_KEY, firstDeepGate, fallbackTurns, score: { good: good.length, of: graded.length, stale: stale.length }, turns: results }, null, 2)}\n===END_STRUCTURED_RESULTS===`);
    await screenshot("dm-final");
  },
];
