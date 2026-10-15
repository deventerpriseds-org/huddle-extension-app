// AC-37: T = open unparked mirror rows (isOpen && !isParked) vs R = distinct task ids in the real tree.
import { readFileSync } from "node:fs";
const [wt, dir] = process.argv.slice(2);
const W = await import(`${wt}/src/features/huddle/lib/tasks/widgets.server.ts`);
const mirror: any[] = JSON.parse(readFileSync(`${dir}/mirror.json`, "utf8"));
const jt = JSON.parse(readFileSync(`${dir}/journey_topics.json`, "utf8"));
const payload = { topics: jt.topics, mappings: jt.mappings.map(([task_id, topic_id]: any) => ({ task_id, topic_id })) };
const T = mirror.filter((r) => W.isOpen(r) && !W.isParked(r)).length;
const ids = new Set<string>(); let rows = 0;
const walk = (ns: any[]) => { for (const n of ns) { for (const t of n.tasks) { ids.add(t.id); rows++; } walk(n.children); } };
walk(W.buildPrioritiesTree(mirror, "America/New_York", Date.parse("2026-10-15T17:00:00Z"), payload));
console.log(`T=${T} R(distinct)=${ids.size} rendered task rows=${rows}`);
