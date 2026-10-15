// WHAT:       An INDEPENDENT second suite over the priorities category tree, written cold by a
//             verifier subagent that shared none of the implementer's context or fixtures.
// WHY:        It caught three things the implementer's own suite did not: a comparator that was not
//             a total order (live on the owner's board, two real pairs tying), mergeTopicTree
//             mutating its caller's grandchild arrays in place (the implementer's assertion checked
//             a LENGTH on the one level that IS copied, so it was a false positive), and a fixture
//             whose category name sorted before "Uncategorised" and so masked the rank that forces
//             that bucket last. Kept rather than deleted: a second author's fixtures are the asset.
// SUPERSEDES: nothing
// SUPERSEDED-BY: nothing -- current
// EVIDENCE:   docs/VERIFY-tasks-under-categories-1.md (663 lines, same pass).
//
// EXPECT 24 PASS / 1 FAIL. The one failure, I-7, is an OPEN DECISION and not a code defect:
// AC-13 ("a HIGH/URGENT task is not ranked below a LOW one") and AC-14 (order by
// is_priority -> priority_rank -> due_date -> title, matching journey's own query) CONTRADICT each
// other. The shipped code satisfies AC-14, so AC-13 fails by construction. `BoardTaskRow.priority`
// is selected from the mirror and dropped by `toWidgetRow`, so honouring it is a small change --
// but it changes what "what's next" MEANS, which is the owner's call, not a bug to quietly fix.
// A red run of THIS file means that decision is still open. Close it and this goes green.
//
// Run:  bun scripts/category-tree-independent.test.ts   (npm run test:category-tree-independent)

// VERIFIER-OWNED, throwaway. Independent adversarial checks on buildCategoryTaskTree/mergeTopicTree.
// Not the implementer's suite — written without reading scripts/category-tree.test.ts assertions as
// a template. Delete after the pass.
import {
  buildCategoryTaskTree,
  mergeTopicTree,
  UNCATEGORISED_CATEGORY,
  isOpen,
  isParked,
  type TopicNode,
} from "../src/features/huddle/lib/tasks/widgets.server";

let pass = 0, fail = 0;
const check = (label: string, cond: boolean, detail: string) => {
  console.log(`  ${cond ? "PASS" : "FAIL"} ${label} :: ${detail}`);
  cond ? pass++ : fail++;
};

const TZ = "America/New_York";
const NOW = Date.parse("2026-10-15T15:00:00Z");
const row = (o: Record<string, unknown>) => ({
  id: "x", title: "t", status: "TODO", priority: null, category: "CAREER", is_priority: false,
  priority_rank: null, due_date: null, completed_at: null, assigned_agent: null, tags: [],
  definition_of_done: null, start_time: null, end_time: null, is_scheduled: false, ...o,
}) as any;
const node = (o: Partial<TopicNode>): TopicNode => ({
  id: "n", name: "n", parentId: null, categoryAffinity: null, position: null, count: null,
  children: [], tasks: [], ...o,
});
const walk = (ns: readonly TopicNode[], f: (n: TopicNode) => void) => {
  for (const n of ns) { f(n); walk(n.children, f); }
};
const allTaskIds = (ns: readonly TopicNode[]) => { const o: string[] = []; walk(ns, (n) => o.push(...n.tasks.map(t => t.id))); return o; };

// ── I-1  CONSERVATION over a 400-row pseudo-random board (claim 1) ─────────────────────────────
{
  let seed = 1234567;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const cats = ["CAREER","LIFE","PERSONAL","VENTURES","EDUCATION","PROF_EDUCATION","FAMILY","SIDE_HUSTLE",null,"","   ","career","Family"];
  const statuses = ["TODO","BACKLOG","DOING","IN_REVIEW","UP_NEXT","BLOCKED","DONE","done","Done","CANCELLED","COMPLETED"];
  const rows = Array.from({ length: 400 }, (_, i) => row({
    id: `t${i}`,
    title: `task ${Math.floor(rnd() * 50)}`,
    category: cats[Math.floor(rnd() * cats.length)],
    status: statuses[Math.floor(rnd() * statuses.length)],
    completed_at: rnd() < 0.08 ? "2026-01-01T00:00:00Z" : null,
    tags: rnd() < 0.08 ? ["parking-lot"] : rnd() < 0.05 ? ["Parking-Lot"] : [],
    is_priority: rnd() < 0.2,
    priority_rank: rnd() < 0.2 ? Math.floor(rnd() * 5) : null,
    due_date: rnd() < 0.3 ? `2026-1${Math.floor(rnd()*2)}-0${1+Math.floor(rnd()*8)}T00:00:00Z` : null,
  }));
  const expected = rows.filter((r) => isOpen(r) && !isParked(r)).map((r) => r.id).sort();
  const tree = buildCategoryTaskTree(rows, TZ, NOW);
  const got = allTaskIds(tree);
  const gotSorted = [...got].sort();
  check("I-1a every live+unparked task reaches the tree",
    gotSorted.join(",") === expected.join(","),
    `expected ${expected.length} live of 400, got ${got.length}; missing=[${expected.filter(e=>!got.includes(e)).slice(0,5)}] extra=[${got.filter(g=>!expected.includes(g)).slice(0,5)}]`);
  check("I-1b and EXACTLY ONCE — no id appears under two categories",
    new Set(got).size === got.length,
    `${got.length} placements, ${new Set(got).size} distinct`);
  const closed = rows.filter((r) => !isOpen(r)).map(r=>r.id);
  const parked = rows.filter((r) => isParked(r)).map(r=>r.id);
  check("I-1c no closed task leaked in", !closed.some(id=>got.includes(id)), `${closed.length} closed rows, 0 present`);
  check("I-1d no parked task leaked in (incl. odd-cased 'Parking-Lot')",
    !parked.some(id=>got.includes(id)), `${parked.length} parked rows (isParked is case-insensitive), 0 present`);
  const blocked = rows.filter((r) => r.status === "BLOCKED" && isOpen(r) && !isParked(r)).map(r=>r.id);
  check("I-1e BLOCKED is KEPT", blocked.length>0 && blocked.every(id=>got.includes(id)), `${blocked.length} blocked live rows, all present`);
  // count integrity over every node
  let bad: string[] = [];
  walk(tree, (n) => { if (n.count !== n.tasks.length) bad.push(`${n.id}: count=${n.count} tasks=${n.tasks.length}`); });
  check("I-1f count === tasks.length on EVERY node of the 400-row tree (claim 2)",
    bad.length === 0, bad.length ? bad.join("; ") : `${tree.length} category nodes all agree`);
  // right category
  const mis: string[] = [];
  const FOLD: Record<string,string> = { PERSONAL:"LIFE", PROF_EDUCATION:"EDUCATION" };
  walk(tree, (n) => { for (const t of n.tasks) {
    const raw = (t.category ?? "").trim().toUpperCase();
    const want = raw ? (FOLD[raw] ?? raw) : UNCATEGORISED_CATEGORY;
    if (n.categoryAffinity !== want) mis.push(`${t.id} cat=${JSON.stringify(t.category)} under ${n.categoryAffinity}, want ${want}`);
  }});
  check("I-1g every task sits under the category its own column names (case-folded)",
    mis.length === 0, mis.length ? mis.slice(0,4).join("; ") : "0 misplacements over 400 rows");
  check("I-1h case variants fold: 'career' joins CAREER, 'Family' joins FAMILY",
    tree.filter(n=>n.categoryAffinity==="CAREER").length===1 && tree.filter(n=>n.categoryAffinity==="FAMILY").length===1,
    `CAREER nodes=${tree.filter(n=>n.categoryAffinity==="CAREER").length}, FAMILY nodes=${tree.filter(n=>n.categoryAffinity==="FAMILY").length}`);
  check("I-1i no two category nodes share an id (React key collision)",
    new Set(tree.map(n=>n.id)).size === tree.length,
    `${tree.length} roots, ${new Set(tree.map(n=>n.id)).size} distinct ids: [${tree.map(n=>n.id).join(" ")}]`);
  check("I-1j Uncategorised is LAST even with a dynamic category present (claim 3)",
    tree[tree.length-1].categoryAffinity === UNCATEGORISED_CATEGORY,
    `order: ${tree.map(n=>n.categoryAffinity).join(" > ")}`);
}

// ── I-2  no EMPTY category row can appear from the mirror ───────────────────────────────────────
{
  const rows = [row({ id:"d1", category:"CAREER", status:"DONE" }), row({ id:"d2", category:"CAREER", completed_at:"2026-01-01T00:00:00Z" })];
  const tree = buildCategoryTaskTree(rows, TZ, NOW);
  check("I-2 a category whose only tasks are all DONE produces NO row at all",
    tree.length === 0, `tree.length=${tree.length}`);
}

// ── I-3  determinism across 50 shuffles (claim 5, AC-11/12) ────────────────────────────────────
{
  const base = [
    row({ id:"a", title:"alpha", is_priority:true, priority_rank:3 }),
    row({ id:"b", title:"beta",  is_priority:true, priority_rank:1 }),
    row({ id:"c", title:"gamma", due_date:"2026-10-20T00:00:00Z" }),
    row({ id:"d", title:"delta", due_date:"2026-10-18T00:00:00Z" }),
    row({ id:"e", title:"epsilon" }),
    row({ id:"f", title:"zeta", is_priority:true, priority_rank:null }),
  ];
  const canon = buildCategoryTaskTree(base, TZ, NOW)[0].tasks.map(t=>t.id).join(",");
  const results = new Set<string>();
  let s = 42; const r = () => (s = (s*1103515245+12345)&0x7fffffff)/0x7fffffff;
  for (let i=0;i<50;i++){
    const sh=[...base]; for(let j=sh.length-1;j>0;j--){const k=Math.floor(r()*(j+1));[sh[j],sh[k]]=[sh[k],sh[j]];}
    results.add(buildCategoryTaskTree(sh, TZ, NOW)[0].tasks.map(t=>t.id).join(","));
  }
  check("I-3a 50 shuffled permutations of DISTINCT-key rows give ONE order",
    results.size===1 && [...results][0]===canon, `${results.size} distinct results; canonical=[${canon}]`);

  // Now the adversarial case: rows that TIE on every comparator key.
  const tied = [
    row({ id:"t1", title:"Same Title" }),
    row({ id:"t2", title:"Same Title" }),
    row({ id:"t3", title:"Same Title" }),
  ];
  const tiedResults = new Set<string>();
  for (const perm of [[0,1,2],[2,1,0],[1,0,2],[1,2,0],[2,0,1],[0,2,1]]) {
    tiedResults.add(buildCategoryTaskTree(perm.map(i=>tied[i]), TZ, NOW)[0].tasks.map(t=>t.id).join(","));
  }
  check("I-3b rows TYING on every key: order is a function of the DATA, not arrival order",
    tiedResults.size===1, `${tiedResults.size} distinct orders from 6 permutations: ${[...tiedResults].join(" | ")}`);
}

// ── I-4  mergeTopicTree conservation + DEEP mutation (claim 4) ──────────────────────────────────
{
  const catRoots = buildCategoryTaskTree([row({id:"c1",category:"CAREER"}),row({id:"l1",category:"LIFE"})], TZ, NOW);
  const grand = [node({ id:"gz", name:"zzz" }), node({ id:"ga", name:"aaa" })];
  const journeyRoots: TopicNode[] = [
    node({ id:"category:CAREER", name:"Career", categoryAffinity:"CAREER",
           children:[ node({ id:"tp1", name:"Presentations", count:2, children: grand }) ] }),
    node({ id:"category:VENTURES", name:"Ventures", categoryAffinity:"VENTURES",
           children:[ node({ id:"tp2", name:"Pitch", count:3 }) ] }),
    node({ id:"orphan-1", name:"No category topic", count:4 }),
    node({ id:"orphan-2", name:"Another orphan", count:1 }),
  ];
  const beforeGrandOrder = grand.map(n=>n.id).join(",");
  const beforeJourneyChildren = journeyRoots.map(r=>r.children.length).join(",");
  const beforeCatChildren = catRoots.map(r=>r.children.length).join(",");
  const merged = mergeTopicTree(journeyRoots, catRoots);

  const mergedIds = new Set<string>(); walk(merged, n=>mergedIds.add(n.id));
  const wantIds = ["category:CAREER","category:LIFE","category:VENTURES","orphan-1","orphan-2","tp1","tp2","gz","ga"];
  check("I-4a every node from BOTH inputs survives the merge",
    wantIds.every(i=>mergedIds.has(i)), `missing=[${wantIds.filter(i=>!mergedIds.has(i)).join(",")}] got ${mergedIds.size} nodes`);
  check("I-4b the mirror's tasks survive on a category journey also sent",
    merged.find(n=>n.id==="category:CAREER")!.tasks.map(t=>t.id).join(",")==="c1", "c1 still attached");
  check("I-4c merged roots have no duplicate ids",
    new Set(merged.map(n=>n.id)).size===merged.length, `[${merged.map(n=>n.id).join(" ")}]`);
  check("I-4d INPUT top-level children arrays unchanged in length",
    journeyRoots.map(r=>r.children.length).join(",")===beforeJourneyChildren &&
    catRoots.map(r=>r.children.length).join(",")===beforeCatChildren,
    `journey ${beforeJourneyChildren} -> ${journeyRoots.map(r=>r.children.length).join(",")}; cat ${beforeCatChildren} -> ${catRoots.map(r=>r.children.length).join(",")}`);
  check("I-4e DEEP: a GRANDCHILD array of the input is NOT re-sorted in place",
    grand.map(n=>n.id).join(",")===beforeGrandOrder,
    `grandchildren of journeyRoots[0].children[0] were [${beforeGrandOrder}], are now [${grand.map(n=>n.id).join(",")}]`);
  check("I-4f merge result shares no root OBJECT identity with either input",
    merged.every(m=>!journeyRoots.includes(m) && !catRoots.includes(m)),
    "every root is a fresh copy");
  // idempotence / determinism
  const a = JSON.stringify(mergeTopicTree(journeyRoots, catRoots));
  const b = JSON.stringify(mergeTopicTree(journeyRoots, catRoots));
  check("I-4g merging the same inputs twice is byte-identical (AC-11)", a===b, `${a.length} bytes both times`);
}

// ── I-5  duplicate journey category roots, and a journey root colliding with Uncategorised ─────
{
  const catRoots = buildCategoryTaskTree([row({id:"u1",category:null})], TZ, NOW);
  const dup: TopicNode[] = [
    node({ id:"category:CAREER", name:"Career", categoryAffinity:"CAREER", children:[node({id:"x1"})] }),
    node({ id:"category:CAREER", name:"Career", categoryAffinity:"CAREER", children:[node({id:"x2"})] }),
  ];
  const merged = mergeTopicTree(dup, catRoots);
  const careers = merged.filter(n=>n.id==="category:CAREER");
  check("I-5a two journey roots with the SAME category id fold into one row (no React key clash)",
    careers.length===1 && careers[0].children.map(c=>c.id).sort().join(",")==="x1,x2",
    `${careers.length} Career rows, children=[${careers[0]?.children.map(c=>c.id).join(",")}]`);
  const collide = mergeTopicTree([node({id:`category:${UNCATEGORISED_CATEGORY}`, name:"Uncategorised", children:[node({id:"y1"})]})], catRoots);
  check("I-5b a journey root whose id is the Uncategorised id folds in rather than duplicating",
    collide.filter(n=>n.id===`category:${UNCATEGORISED_CATEGORY}`).length===1,
    `${collide.filter(n=>n.id===`category:${UNCATEGORISED_CATEGORY}`).length} Uncategorised rows; its tasks=[${collide.find(n=>n.id===`category:${UNCATEGORISED_CATEGORY}`)?.tasks.map(t=>t.id)}]`);
  const two = mergeTopicTree([node({id:"same",name:"S"}),node({id:"same",name:"S"})], []);
  check("I-5c DUPLICATE bare-topic ids from journey pass through as two rows with the same id",
    new Set(two.map(n=>n.id)).size !== two.length,
    `${two.length} roots, ${new Set(two.map(n=>n.id)).size} distinct — a React duplicate-key path if journey ever sends one`);
}

// ── I-6  a task whose category is literally "UNCATEGORISED" ────────────────────────────────────
{
  const tree = buildCategoryTaskTree([row({id:"real",category:"UNCATEGORISED"}),row({id:"nullcat",category:null})], TZ, NOW);
  check("I-6 a real category string 'UNCATEGORISED' is indistinguishable from the null bucket",
    tree.length===1 && tree[0].tasks.length===2,
    `${tree.length} row(s); the synthetic bucket key is a plain string with no namespace prefix`);
}

// ── I-7  the priority TEXT column is ignored by the ordering (AC-13) ───────────────────────────
{
  const rows = [
    row({ id:"urgent", title:"zzz last alphabetically", priority:"URGENT" }),
    row({ id:"low",    title:"aaa first alphabetically", priority:"LOW" }),
  ];
  const order = buildCategoryTaskTree(rows, TZ, NOW)[0].tasks.map(t=>t.id);
  check("I-7 AC-13: a HIGH/URGENT task is NOT ranked below a LOW one",
    order[0]==="urgent", `order=[${order.join(",")}] — byPriorityThenDue reads is_priority/priority_rank/due_date/title and never the \`priority\` text column, which BoardTaskRow does carry`);
}

console.log(`\n=========== INDEPENDENT: ${pass} passed, ${fail} failed ===========`);
