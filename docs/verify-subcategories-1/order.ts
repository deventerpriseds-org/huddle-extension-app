// Prints Huddle's Career topic order (real buildPrioritiesTree) next to each topic's journey position,
// and the order under a reversed payload, to compare against the phone screenshot's order.
import { readFileSync } from "node:fs";
const [wt, dir] = process.argv.slice(2);
const W = await import(`${wt}/src/features/huddle/lib/tasks/widgets.server.ts`);
const jt = JSON.parse(readFileSync(`${dir}/journey_topics.json`, "utf8"));
const topics = jt.topics.map((t: any) => ({ id: t.id, topic_name: t.topic_name, position: t.position, category_affinity: t.category_affinity, window_affinity: t.window_affinity, parent_topic_id: t.parent_topic_id }));
const mk = (ts: any[]) => ({ topics: ts, mappings: jt.mappings.map(([task_id, topic_id]: any) => ({ task_id, topic_id })) });
const pos = new Map(topics.map((t: any) => [t.topic_name, t.position]));
for (const [label, ts] of [["db-order", topics], ["reversed", [...topics].reverse()]] as const) {
  const tree = W.buildPrioritiesTree([], "America/New_York", 0, mk(ts as any[]));
  const career = tree.find((n: any) => n.id === "category:CAREER");
  console.log(label, "=>", career.children.map((c: any) => `${c.name}[p${pos.get(c.name)}]`).join(", "));
}
console.log("top-level order:", W.buildPrioritiesTree([], "UTC", 0, mk(topics)).map((n: any) => n.name).join(", "));
