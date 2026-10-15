// WHAT: feeds the owner's REAL journey topics/mappings + REAL Huddle mirror rows through the real
//       buildPrioritiesTree (65005a1) and compares per category / per topic against the Android rule.
// Usage: bun compare.ts <worktree> <datadir>
import { readFileSync } from "node:fs";

const [wt, dir] = process.argv.slice(2);
const W = await import(`${wt}/src/features/huddle/lib/tasks/widgets.server.ts`);
const jt = JSON.parse(readFileSync(`${dir}/journey_topics.json`, "utf8"));
const jtasksRaw: any[] = JSON.parse(readFileSync(`${dir}/journey_tasks.json`, "utf8")).jtasks;
const mirror: any[] = JSON.parse(readFileSync(`${dir}/mirror.json`, "utf8"));
const OWNER = "a3378f93-d655-4913-b2fa-ca5b1d8020f1";

const jtasks = new Map<string, any>();
for (const [id, status, category, user, tags, title, completed] of jtasksRaw)
  jtasks.set(id, { id, status, category, user, tags: tags ?? [], title, completed });

// ---- the payload exactly as getTaskTopics would return it (field set from 4dec778) ----
const topics = jt.topics.map((t: any) => ({
  id: t.id, topic_name: t.topic_name, position: t.position, category_affinity: t.category_affinity,
  window_affinity: t.window_affinity, parent_topic_id: t.parent_topic_id,
}));
const mappingsPairs: [string, string][] = jt.mappings;
const payload = JSON.parse(JSON.stringify({ topics, mappings: mappingsPairs.map(([task_id, topic_id]) => ({ task_id, topic_id })) }));
const topicById = new Map<string, any>(jt.topics.map((t: any) => [t.id, t]));

// ---- Huddle side ----
const rows = mirror.map((r) => ({
  id: r.id, title: r.title, status: r.status, priority: r.priority, category: r.category,
  is_priority: r.is_priority, priority_rank: r.priority_rank, due_date: r.due_date,
  completed_at: r.completed_at, assigned_agent: r.assigned_agent, tags: r.tags,
  definition_of_done: null, start_time: r.start_time, end_time: r.end_time, is_scheduled: r.is_scheduled,
}));
const NOW = Date.parse("2026-10-15T17:00:00Z");
const tree = W.buildPrioritiesTree(rows, "America/New_York", NOW, payload);
const treeAgain = W.buildPrioritiesTree(rows, "America/New_York", NOW, JSON.parse(JSON.stringify(payload)));

// ---- Android side (PrioritiesWidgetFactory.rebuildItems + SupabaseTaskClient.getTasksForTopics) ----
const norm = (k: string) => (k === "PERSONAL" ? "LIFE" : k === "PROF_EDUCATION" ? "EDUCATION" : k);
const effCat = (t: any) => {
  const c = t.category_affinity && String(t.category_affinity).trim() ? t.category_affinity : null;
  const w = Array.isArray(t.window_affinity) && t.window_affinity[0] && String(t.window_affinity[0]).trim() ? t.window_affinity[0] : null;
  return norm(c ?? w ?? "");
};
function android(order: [string, string][]) {
  const topicByTask = new Map<string, string>();
  for (const [task, topic] of order) topicByTask.set(task, topic); // last wins
  const byTopic = new Map<string, string[]>();
  for (const [taskId, topicId] of topicByTask) {
    const t = jtasks.get(taskId);
    if (!t || t.user !== OWNER || t.status === "DONE" || t.status === "BLOCKED") continue;
    if (!byTopic.has(topicId)) byTopic.set(topicId, []);
    byTopic.get(topicId)!.push(taskId);
  }
  return byTopic;
}
const multi = new Map<string, string[]>();
for (const [task, topic] of mappingsPairs) multi.set(task, [...(multi.get(task) ?? []), topic]);
const multiTasks = [...multi].filter(([, ts]) => ts.length > 1);
const andA = android(mappingsPairs);
const andB = android([...mappingsPairs].reverse());

// ---- walk Huddle tree ----
type Hnode = { cat: string; topics: Map<string, { name: string; count: number | null; tasks: any[] }>; direct: any[]; count: number | null; name: string };
const H = new Map<string, Hnode>();
const topLevelNonCategory: any[] = [];
for (const root of tree) {
  if (!root.id.startsWith("category:")) { topLevelNonCategory.push(root); continue; }
  const cat = root.id.slice("category:".length);
  const h: Hnode = { cat, name: root.name, count: root.count, topics: new Map(), direct: root.tasks };
  const walk = (ns: any[]) => { for (const n of ns) { h.topics.set(n.id, { name: n.name, count: n.count, tasks: n.tasks }); walk(n.children); } };
  walk(root.children);
  H.set(cat, h);
}

const CATS = ["LIFE", "CAREER", "VENTURES", "EDUCATION", "FAMILY"];
const out: string[] = [];
const p = (s: string) => out.push(s);
p(`mirror rows=${rows.length}; journey topics=${topics.length}; mappings=${mappingsPairs.length}; multi-topic tasks=${multiTasks.length}`);
p(`deterministic: two builds JSON-identical = ${JSON.stringify(tree) === JSON.stringify(treeAgain)}`);
p(`top-level roots: ${tree.map((n: any) => `${n.name}(${n.count})`).join(", ")}`);
p(`non-category top-level roots: ${topLevelNonCategory.length}`);

const mirrorById = new Map(rows.map((r) => [r.id, r]));
const reason = (taskId: string, side: "H-only" | "A-only") => {
  const m = mirrorById.get(taskId); const j = jtasks.get(taskId);
  const bits: string[] = [];
  if (!m) bits.push("NOT IN MIRROR");
  if (!j) bits.push("not in journey dump");
  if (m && j && m.status !== j.status) bits.push(`STATUS DRIFT mirror=${m.status} journey=${j.status}`);
  if (j?.status === "BLOCKED") bits.push("BLOCKED (Huddle keeps, Android drops)");
  if (m && W.isParked(m)) bits.push("parking-lot (Huddle drops)");
  if (m?.completed_at && m.status !== "DONE") bits.push("completed_at set but status not DONE (Huddle drops)");
  if (j && j.user !== OWNER) bits.push("other user");
  if (!multi.has(taskId)) bits.push("UNLINKED (Huddle shows under own category)");
  if ((multi.get(taskId)?.length ?? 0) > 1) bits.push(`MULTI-TOPIC ${multi.get(taskId)!.map((x) => topicById.get(x)?.topic_name).join(" / ")}`);
  return `${side} ${taskId.slice(0, 8)} "${(m?.title ?? j?.title ?? "").slice(0, 50)}" :: ${bits.join("; ") || "UNEXPLAINED"}`;
};

let unexplained = 0;
for (const cat of CATS) {
  const h = H.get(cat);
  const catTopics = jt.topics.filter((t: any) => !t.parent_topic_id && effCat(t) === cat);
  const aTotal = catTopics.reduce((s: number, t: any) => s + (andA.get(t.id)?.length ?? 0), 0);
  const aTotalB = catTopics.reduce((s: number, t: any) => s + (andB.get(t.id)?.length ?? 0), 0);
  const hTopicTaskTotal = h ? [...h.topics.values()].reduce((s, t) => s + t.tasks.length, 0) : 0;
  p(`\n## ${cat}: Android=${aTotal}${aTotalB !== aTotal ? `/${aTotalB}(order-dependent)` : ""} | Huddle count=${h?.count ?? "absent"} = topic-linked ${hTopicTaskTotal} + direct(unlinked) ${h?.direct.length ?? 0} | topics Android=${catTopics.length} Huddle=${h?.topics.size ?? 0}`);
  // per topic
  for (const t of catTopics.sort((a: any, b: any) => (a.position - b.position) || a.topic_name.localeCompare(b.topic_name))) {
    const a = andA.get(t.id) ?? [];
    const ht = h?.topics.get(t.id);
    const hIds = (ht?.tasks ?? []).map((x: any) => x.id);
    const aSet = new Set(a); const hSet = new Set(hIds);
    if (!ht) { p(`  MISSING-IN-HUDDLE topic ${t.topic_name}`); unexplained++; continue; }
    const diff = [...a.filter((x) => !hSet.has(x)).map((x) => reason(x, "A-only")), ...hIds.filter((x: string) => !aSet.has(x)).map((x: string) => reason(x, "H-only"))];
    if (a.length || hIds.length || diff.length)
      p(`  ${a.length === hIds.length && !diff.length ? "=" : "≠"} ${t.topic_name}: Android ${a.length} | Huddle ${hIds.length} (node.count=${ht.count})${t.archived ? " [ARCHIVED topic]" : ""}`);
    for (const d of diff) { p(`      ${d}`); if (d.includes("UNEXPLAINED")) unexplained++; }
  }
  for (const d of h?.direct ?? []) p(`  direct-under-category: ${reason(d.id, "H-only")}`);
  // topics present in Huddle that Android puts elsewhere
  for (const [id, t] of h?.topics ?? []) if (!catTopics.find((c: any) => c.id === id)) p(`  EXTRA topic in Huddle ${cat}: ${t.name}`);
}
for (const [cat, h] of H) if (!CATS.includes(cat)) p(`\n## NON-ANDROID category in Huddle: ${cat} count=${h.count} topics=${h.topics.size} direct=${h.direct.length}`);

// Category chip contradiction: task under a topic whose category != task's own category
p(`\n## rows whose own category differs from the category they are filed under`);
let mism = 0;
for (const [cat, h] of H) for (const [, t] of h.topics) for (const r of t.tasks) {
  const own = r.category ? W.displayCategory(r.category) : "UNCATEGORISED";
  if (own !== cat) { mism++; p(`  under ${cat} / ${t.name}: "${r.title.slice(0, 50)}" own category=${r.category}`); }
}
p(`  total=${mism}`);

// Open journey tasks missing from mirror
const missing = [...jtasks.values()].filter((j) => j.user === OWNER && j.status !== "DONE" && !mirrorById.has(j.id));
p(`\nopen journey tasks absent from mirror: ${missing.length} ${missing.map((m) => m.title.slice(0, 30)).join(" | ")}`);
const drift = [...jtasks.values()].filter((j) => mirrorById.has(j.id) && mirrorById.get(j.id)!.status !== j.status);
p(`status drift mirror vs journey: ${drift.length} ${drift.map((d) => `${d.title.slice(0, 30)} m=${mirrorById.get(d.id)!.status} j=${d.status}`).join(" | ")}`);
p(`multi-topic tasks: ${multiTasks.map(([t, ts]) => `${(jtasks.get(t)?.title ?? t).slice(0, 40)} [${jtasks.get(t)?.status}] -> ${ts.map((x) => topicById.get(x)?.topic_name).join(" / ")}`).join(" || ")}`);
p(`UNEXPLAINED divergences: ${unexplained}`);
console.log(out.join("\n"));
