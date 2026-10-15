// WHAT:       Proves the PRIORITIES widget's category tree carries every live task, under the right
//             category, in a deterministic order, with a count that cannot disagree with the rows —
//             and that merging journey's topic tree into it never drops a node from either side.
// WHY:        2026-10-15. The widget's tree rendered names + counts and no tasks, so neither the
//             owner nor a future agent could answer "what's next in Career?" from it. An independent
//             AC pass measured why the obvious sources cannot supply the data (get_task_topics is
//             not deployed; get_tasks caps at .limit(50) of 101 open tasks; get_tasks_by_topic costs
//             ~75 calls and orders by the `priority` TEXT column descending, putting MEDIUM above
//             HIGH) and found three ways this class of code has already silently lost rows:
//             buildTopicTree's duplicate-id collision, Android's grpTaskCount omitting a group's own
//             tasks, and Huddle dropping FAMILY entirely because only a TOPIC could create a
//             category root.
// SUPERSEDES: nothing
// SUPERSEDED-BY: nothing -- current
// EVIDENCE:   journey-voice execute-tool/index.ts:707 (.limit(50)), :2199-2205 (text-column order),
//             :981-982 (rank => star); docs/AC-tasks-under-categories.md.
//
// Run:  bun scripts/category-tree.test.ts   (npm run test:category-tree)

import {
  buildCategoryTaskTree,
  buildPrioritiesBand,
  buildPrioritiesTree,
  classifyTopicFailure,
  findTopicMappings,
  mergeTopicTree,
  UNCATEGORISED_CATEGORY,
  withKnownCategories,
  type TopicNode,
} from "../src/features/huddle/lib/tasks/widgets.server";

let pass = 0, fail = 0;
function check(label: string, cond: boolean, detail: string) {
  console.log(`  ${cond ? "PASS" : "FAIL"} ${label} — ${detail}`);
  cond ? pass++ : fail++;
}

const TZ = "America/New_York";
const NOW = Date.parse("2026-10-15T15:00:00Z");

// Minimal board row — only the fields the tree reads. `as any` keeps the fixture honest about that
// rather than inventing values for 20 columns the code never touches.
const row = (over: Record<string, unknown>) =>
  ({
    id: "id", title: "t", status: "TODO", category: "CAREER", is_priority: false,
    priority_rank: null, due_date: null, start_time: null, end_time: null, is_scheduled: false,
    tags: [], assigned_agent: null, completed_at: null, ...over,
  }) as any;

const node = (over: Partial<TopicNode>): TopicNode => ({
  id: "n", name: "n", parentId: null, categoryAffinity: null, position: null, count: null,
  children: [], tasks: [], ...over,
});

const allTasks = (roots: TopicNode[]): string[] => {
  const out: string[] = [];
  const walk = (ns: TopicNode[]) => { for (const n of ns) { out.push(...n.tasks.map((t) => t.id)); walk(n.children); } };
  walk(roots);
  return out;
};

// ── Every live task reaches the tree exactly once ───────────────────────────────────────────────
{
  const rows = [
    row({ id: "a", category: "CAREER" }),
    row({ id: "b", category: "VENTURES" }),
    row({ id: "c", category: null }),          // unmapped — 3 of the owner's 101 are
    row({ id: "d", category: "  " }),          // blank, not null
    row({ id: "e", category: "PROF_EDUCATION" }), // folds into EDUCATION
    row({ id: "f", category: "PERSONAL" }),       // folds into LIFE
    row({ id: "g", category: "ZZ_TOP" }),          // unknown key — must pass through, not drop
  ];
  const tree = buildCategoryTaskTree(rows, TZ, NOW);
  const ids = allTasks(tree).sort();
  check("every live task appears exactly once, whatever its category",
    ids.join(",") === "a,b,c,d,e,f,g",
    `${ids.length} of 7 — [${ids.join(",")}]`);
  const uncat = tree.find((n) => n.categoryAffinity === UNCATEGORISED_CATEGORY);
  check("a task with a null OR blank category gets a real row, never silent omission",
    !!uncat && uncat.tasks.length === 2,
    `Uncategorised holds ${uncat?.tasks.length ?? 0} (null + blank)`);
  check("PROF_EDUCATION folds into EDUCATION and PERSONAL into LIFE — journey's own merge",
    !!tree.find((n) => n.categoryAffinity === "EDUCATION" && n.tasks.some((t) => t.id === "e")) &&
    !!tree.find((n) => n.categoryAffinity === "LIFE" && n.tasks.some((t) => t.id === "f")),
    "one row each, not separate Prof. Education / Personal rows");
  check("an UNKNOWN category key passes through as its own row rather than being dropped",
    !!tree.find((n) => n.categoryAffinity === "ZZ_TOP"),
    "ordering is not an allow-list");
  // The fixture category is deliberately ZZ_TOP, not SIDE_HUSTLE. "Side Hustle" sorts BEFORE
  // "Uncategorised" under sortNodes' localeCompare tiebreak, so with that name this assertion
  // passed whether or not the `+1` that forces Uncategorised past every dynamic category was
  // present — an independent verifier mutated the `+1` away and the suite came back INERT. A name
  // that sorts AFTER "Uncategorised" is what makes the position, not the alphabet, the thing
  // under test.
  check("Uncategorised sorts last, after every known AND dynamic category",
    tree[tree.length - 1].categoryAffinity === UNCATEGORISED_CATEGORY,
    `last row is ${tree[tree.length - 1].categoryAffinity} (fixture sorts ZZ_TOP after it alphabetically, so only the rank forces this)`);
}

// ── Closed / parked work never surfaces, BLOCKED does ───────────────────────────────────────────
{
  const rows = [
    row({ id: "open", category: "LIFE" }),
    row({ id: "done", category: "LIFE", status: "DONE" }),
    // REOPENED: a live status with an old completed_at. journey keeps the date when a task is brought
    // back, so this is LIVE work. It used to be hidden, which is how "Complete 2 MIT assignments"
    // (UP_NEXT) vanished from Huddle while the owner's phone showed it.
    row({ id: "reopened", category: "LIFE", status: "UP_NEXT", completed_at: "2026-09-13T00:00:00Z" }),
    row({ id: "parked", category: "LIFE", tags: ["parking-lot"] }),
    row({ id: "blocked", category: "LIFE", status: "BLOCKED" }),
  ];
  const ids = allTasks(buildCategoryTaskTree(rows, TZ, NOW)).sort();
  // The TREE follows the owner's phone (isTreeLive): status not DONE and not BLOCKED, parked SHOWN.
  // These were my own rules until 2026-10-15 ("why dont life and ventures line up"): parked hidden
  // and BLOCKED kept. Parked tasks alone were 15 of the 21 tasks Huddle was missing.
  check("TREE = the phone's rule: DONE and BLOCKED hidden; PARKED shown; a REOPENED task (live status, old completed_at) shown",
    ids.join(",") === "open,parked,reopened",
    `[${ids.join(",")}] — SupabaseTaskClient: status=not.in.(DONE,BLOCKED), no parking filter`);
  // ...and the This Week BAND is deliberately NOT changed: it keeps the band's rule (isOpen && not
  // parked). A different rule on a different surface is a documented decision, not an accident.
  const band = buildPrioritiesBand(rows.map((r) => ({ ...r, is_priority: true })), TZ, NOW).map((r) => r.id).sort();
  check("the This Week BAND keeps its own rule: parked hidden, BLOCKED kept",
    band.join(",") === "blocked,open,reopened", `[${band.join(",")}]`);
}

// ── The count is DERIVED, so it can never disagree with the rows ────────────────────────────────
{
  const rows = Array.from({ length: 25 }, (_, i) => row({ id: `t${i}`, category: "CAREER" }));
  const [career] = buildCategoryTaskTree(rows, TZ, NOW);
  check("count equals the number of tasks actually carried, not a passed-through task_count",
    career.count === career.tasks.length && career.count === 25,
    `count=${career.count}, tasks=${career.tasks.length} — the Android factory's grpTaskCount sums only sub-groups and so disagrees with its own rows`);
}

// ── Deterministic order: the agent-autopull payoff ──────────────────────────────────────────────
{
  const rows = [
    row({ id: "plain", category: "CAREER", title: "zzz" }),
    row({ id: "ranked2", category: "CAREER", is_priority: true, priority_rank: 2, title: "b" }),
    row({ id: "ranked1", category: "CAREER", is_priority: true, priority_rank: 1, title: "c" }),
    row({ id: "due", category: "CAREER", due_date: "2026-10-16T00:00:00Z", title: "a" }),
  ];
  const first = buildCategoryTaskTree(rows, TZ, NOW)[0].tasks.map((t) => t.id);
  check("starred-and-ranked first in rank order, then soonest due, then title — a stable answer to 'what's next in Career?'",
    first.join(",") === "ranked1,ranked2,due,plain",
    `[${first.join(",")}]`);
  // Re-run on a shuffled input: the order must come from the comparator, not from input order.
  const shuffled = buildCategoryTaskTree([rows[3], rows[0], rows[1], rows[2]], TZ, NOW)[0].tasks.map((t) => t.id);
  check("the order is a function of the DATA, not of row arrival order",
    shuffled.join(",") === first.join(","),
    `shuffled input gave [${shuffled.join(",")}]`);
}

// ── D-1: the comparator must be a TOTAL order (this claim was DISPROVED on the live board) ──────
{
  // An independent verifier asked the owner's mirror whether any real pair ties on every sort key
  // and found two, e.g. "Prepare my office camera quality" (n=2, distinct_sort_keys=1) — visible in
  // his Life & Personal list. With a comparator returning 0 their order fell through to
  // getBoardTasks' `ORDER BY updated_at DESC` and FLIPPED whenever either row was touched.
  // Duplicate titles are ordinary on an agent-fed board, so this is steady state, not an edge case.
  const twins = [
    row({ id: "zzz", title: "Prepare my office camera quality", category: "LIFE" }),
    row({ id: "aaa", title: "Prepare my office camera quality", category: "LIFE" }),
  ];
  const fwd = buildCategoryTaskTree(twins, TZ, NOW)[0].tasks.map((t) => t.id);
  const rev = buildCategoryTaskTree([twins[1], twins[0]], TZ, NOW)[0].tasks.map((t) => t.id);
  check(
    "two tasks identical on star, rank, due date AND title still get ONE stable order",
    fwd.join(",") === rev.join(",") && fwd.join(",") === "aaa,zzz",
    `${fwd.join(",")} vs ${rev.join(",")} — a next-up that reorders when an unrelated field is written is not an answer to "what's next in Career?"`,
  );
}

// ── D-4: a merged category's count must cover its whole subtree ─────────────────────────────────
{
  const categoryRoots = buildCategoryTaskTree(
    [row({ id: "c1", category: "CAREER" }), row({ id: "c2", category: "CAREER" })], TZ, NOW);
  const journeyRoots: TopicNode[] = [
    node({ id: "category:CAREER", name: "Career", categoryAffinity: "CAREER",
           children: [node({ id: "t1", name: "Presentation Development", count: 2,
                             tasks: [] as never[] })] }),
  ];
  const merged = mergeTopicTree(journeyRoots, categoryRoots);
  const career = merged.find((n) => n.id === "category:CAREER")!;
  check(
    "a category's count covers its OWN tasks PLUS its nested topics — it cannot undercount",
    career.count === 4,
    `count=${career.count} (2 own + 2 under "Presentation Development"); counting only its own tasks is the grpTaskCount defect arrived at from the other side`,
  );
  // A category root journey supplied that the mirror has NO tasks for: its count must still roll up
  // its children. With `node.tasks.length > 0` alone this branch never fires, which is why the
  // earlier fixture (a root WITH its own tasks) reported EQUIVALENT.
  const noOwnTasks = mergeTopicTree(
    [node({ id: "category:LIFE", name: "Life & Personal", categoryAffinity: "LIFE",
            children: [node({ id: "l1", name: "Admin", count: 3 }), node({ id: "l2", name: "Errands", count: 4 })] })],
    []);
  check(
    "a category with NO tasks of its own still rolls up its nested topics' counts",
    noOwnTasks.find((n) => n.id === "category:LIFE")?.count === 7,
    `count=${noOwnTasks.find((n) => n.id === "category:LIFE")?.count} (3 + 4) — a root the mirror has no tasks for still cannot undercount`,
  );
  const topicOnly = mergeTopicTree(
    [node({ id: "solo", name: "Solo topic", count: 7 })], []);
  check(
    "a journey topic with a count and NOTHING beneath it keeps journey's number",
    topicOnly[0].count === 7,
    "the spec screenshot draws exactly these rows (\"Career Development 15\"); such a row is not expandable, so a count never sits above an empty list",
  );
}

// ── A category exists because TASKS are in it (the FAMILY divergence) ───────────────────────────
{
  const tree = buildCategoryTaskTree([row({ id: "f1", category: "FAMILY" })], TZ, NOW);
  check("a category with tasks but NO topics still renders — the gap that hid FAMILY from Huddle while his phone drew it",
    tree.length === 1 && tree[0].categoryAffinity === "FAMILY" && tree[0].tasks.length === 1,
    "groupByCategory only creates a root when a TOPIC claims the category");
}

// ── mergeTopicTree loses nothing from either side ───────────────────────────────────────────────
{
  const categoryRoots = buildCategoryTaskTree([row({ id: "c1", category: "CAREER" })], TZ, NOW);
  const journeyRoots: TopicNode[] = [
    node({ id: "category:CAREER", name: "Career", categoryAffinity: "CAREER",
           children: [node({ id: "topic-1", name: "Presentation Development", count: 2 })] }),
    node({ id: "category:LIFE", name: "Life & Personal", categoryAffinity: "LIFE",
           children: [node({ id: "topic-2", name: "Admin", count: 7 })] }),
    node({ id: "orphan", name: "Uncategorised topic" }),
  ];
  const merged = mergeTopicTree(journeyRoots, categoryRoots);
  const career = merged.find((n) => n.id === "category:CAREER")!;
  check("journey's topics nest INTO the mirror's category row, keeping that row's tasks",
    career.children.some((c) => c.id === "topic-1") && career.tasks.some((t) => t.id === "c1"),
    `${career.children.length} child, ${career.tasks.length} task — the mirror is the base, so the tree renders before journey deploys anything`);
  check("a journey category the mirror has no tasks for is still created, never dropped",
    !!merged.find((n) => n.id === "category:LIFE"),
    "nothing from journey is lost");
  check("an uncategorised journey topic stays top-level rather than being guessed into a category",
    !!merged.find((n) => n.id === "orphan"),
    "no inference");
  // A LENGTH assertion cannot see a REORDER, and that is exactly how this passed while the defect
  // was live: mergeTopicTree copied two levels, then sortNodes recursed and sorted the CALLER'S
  // grandchild arrays in place. Found by an independent verifier, not here. Snapshot the full
  // nested shape and compare it, so a reorder at ANY depth fails.
  const shape = (ns: readonly TopicNode[]): string =>
    ns.map((n) => `${n.id}(${n.tasks.map((t) => t.id).join("|")})[${shape(n.children)}]`).join(",");
  const beforeJourney = shape(journeyRoots);
  const beforeCategory = shape(categoryRoots);
  // FOUR levels on purpose. `.map(cloneNode)` at the push site copies the arrays a SHALLOW clone
  // would also reach, so a three-level fixture cannot tell a deep clone from a shallow one and
  // mutate.sh correctly reported EQUIVALENT — "not proven", not "guard is broken". The reorder is
  // only observable below that, which is where the real defect lived.
  const deep: TopicNode[] = [
    node({ id: "category:CAREER", name: "Career", categoryAffinity: "CAREER",
           children: [node({ id: "g", name: "G", children: [
             node({ id: "mid", name: "Mid", children: [node({ id: "gz", name: "zz" }), node({ id: "ga", name: "aa" })] }),
           ] })] }),
  ];
  const deepBefore = shape(deep);
  mergeTopicTree(deep, categoryRoots);
  check("merging does not MUTATE the inputs, at ANY depth — not even a reorder of grandchildren",
    shape(journeyRoots) === beforeJourney && shape(categoryRoots) === beforeCategory && shape(deep) === deepBefore,
    shape(deep) === deepBefore ? "callers hold their own arrays, nested" : `grandchildren reordered: ${deepBefore} -> ${shape(deep)}`);
}

// ── AC-10: NO ROW CAP anywhere in the data path ─────────────────────────────────────────────────
{
  // The owner explicitly rejected a row cap — "it should include all that comes back from the query
  // no matter how long that is" (AC-journey-widgets AC-10, which names "+N more" truncation as the
  // thing to avoid). A first draft of the renderer capped a category at 8 behind a "+N more"
  // button; that is removed. This pins the DATA half so the server can never reintroduce one.
  //
  // NOTE ON WHAT THIS DOES AND DOES NOT COVER: the cap that existed was in the COMPONENT, so no
  // offline assertion here could have caught it. AC-10 states its own observation method — compare
  // the rendered `li` count against the payload's length — which needs a DOM. That check is
  // BLOCKED-ON-DEPLOY via verify-uat.yml, and is recorded as such rather than claimed here.
  const many = Array.from({ length: 60 }, (_, i) => row({ id: `m${i}`, category: "VENTURES" }));
  const [ventures] = buildCategoryTaskTree(many, TZ, NOW);
  check("a category carrying 60 tasks returns all 60 — the data path never truncates",
    ventures.tasks.length === 60 && ventures.count === 60,
    `tasks=${ventures.tasks.length}, count=${ventures.count}`);
  check("the count and the carried rows agree at scale, so a UI cap could never be hidden by the number",
    ventures.count === ventures.tasks.length,
    "count is derived, not independent");
}

// ── An empty board is an empty tree, not a crash ────────────────────────────────────────────────
{
  check("no live tasks and no journey topics → an empty tree, which the UI renders as its empty state",
    buildCategoryTaskTree([], TZ, NOW).length === 0 && mergeTopicTree([], []).length === 0,
    "never throws");
}

// ── SUB-CATEGORIES: Category -> Topic -> Task, matching the owner's phone ───────────────────────
//
// Owner, 2026-10-15, with a screenshot of his Android home widget: "we forgot to include
// subcategories under a category like career before we get to tasks." The fixture below is his REAL
// Career data, measured from journey that day with the Android rule (topic category =
// category_affinity, else window_affinity[1]; tasks via task_topic_mappings): 13 topics whose open
// task counts sum to the "Career 8" his phone displays.
{
  const CAREER_TOPICS: Array<[string, number]> = [
    ["Career Development", 2], ["Debugging and Troubleshooting", 0], ["Grooming Management", 0],
    ["Fractional CTO Services", 1], ["Career Review Management", 0], ["Design Resource Management", 1],
    ["Software Development Lifecycle", 2], ["Presentation Development", 0], ["Career Development Tasks", 0],
    ["Team Collaboration Tools", 0], ["Vendor Communication", 0], ["AI Workflow Management", 1],
    ["Career Tools Integration", 1],
  ];
  const topics = CAREER_TOPICS.map(([name], i) => ({
    id: `t${String(i).padStart(2, "0")}`, topic_name: name, position: i === 12 ? 1 : 0,
    category_affinity: "CAREER", window_affinity: null, parent_topic_id: null,
  }));
  const rows: any[] = [];
  const mappings: Array<{ task_id: string; topic_id: string }> = [];
  CAREER_TOPICS.forEach(([, n], i) => {
    for (let k = 0; k < n; k++) {
      const id = `c${i}-${k}`;
      // Deliberately NOT category CAREER on the task itself for one of them: placement follows the
      // TOPIC's category (the Android rule), not the task's own column.
      rows.push(row({ id, title: `${id}`, category: i === 0 && k === 0 ? "LIFE" : "CAREER" }));
      mappings.push({ task_id: id, topic_id: `t${String(i).padStart(2, "0")}` });
    }
  });
  const tree = buildPrioritiesTree(rows, TZ, NOW, { topics, mappings });
  const career = tree.find((n) => n.categoryAffinity === "CAREER")!;
  check("SUB-CATEGORIES: the owner's real Career data counts 8, exactly what his phone shows",
    career?.count === 8, `count=${career?.count}`);
  check("SUB-CATEGORIES: all 13 topics render as children of Career, including the ones with 0 tasks",
    career.children.length === 13 && career.tasks.length === 0,
    `${career.children.length} topic rows, ${career.tasks.length} loose tasks`);
  const byName = new Map(career.children.map((c) => [c.name, c]));
  check("SUB-CATEGORIES: each topic carries exactly its own tasks and counts them",
    CAREER_TOPICS.every(([name, n]) => byName.get(name)!.tasks.length === n),
    CAREER_TOPICS.map(([name, n]) => `${name}=${byName.get(name)!.tasks.length}/${n}`).join(" "));
  check("SUB-CATEGORIES: a topic with 0 tasks has a BLANK count (null), as his phone draws it, not '0'",
    byName.get("Grooming Management")!.count === null,
    `count=${byName.get("Grooming Management")!.count}`);
  check("SUB-CATEGORIES: placement follows the TOPIC's category, not the task's own (Android rule)",
    byName.get("Career Development")!.tasks.some((t) => t.id === "c0-0") &&
      allTasks(tree.filter((n) => n.categoryAffinity === "LIFE")).length === 0,
    "a task whose own category is LIFE, linked to a Career topic, sits under Career");
}

{
  // window_affinity fallback — the half of the Android rule the old parser lacked.
  const tree = buildPrioritiesTree(
    [row({ id: "w1", category: "CAREER" })], TZ, NOW,
    { topics: [{ id: "tw", topic_name: "Evenings", category_affinity: null, window_affinity: ["LIFE"] }],
      mappings: [{ task_id: "w1", topic_id: "tw" }] });
  check("SUB-CATEGORIES: a topic with no category_affinity is filed by its first window_affinity",
    tree.find((n) => n.categoryAffinity === "LIFE")?.children[0]?.tasks[0]?.id === "w1",
    "Android: categoryAffinity ?: windowAffinity?.firstOrNull()");
}

{
  // Nothing is ever dropped, and nothing is counted twice.
  const topics = [
    { id: "ta", topic_name: "A", category_affinity: "CAREER" },
    { id: "tb", topic_name: "B", category_affinity: "CAREER" },
  ];
  const rows = [
    row({ id: "loose", category: "VENTURES" }),                 // linked to no topic
    row({ id: "ghost", category: "CAREER" }),                   // linked to a topic that doesn't exist
    row({ id: "twice", category: "CAREER" }),                   // linked to two topics
    row({ id: "done", category: "CAREER", status: "DONE" }),    // closed
    row({ id: "parked", category: "CAREER", tags: ["parking-lot"] }),
  ];
  const mappings = [
    { task_id: "ghost", topic_id: "t-missing" },
    { task_id: "twice", topic_id: "tb" }, { task_id: "twice", topic_id: "ta" },
    { task_id: "done", topic_id: "ta" }, { task_id: "parked", topic_id: "ta" },
  ];
  const tree = buildPrioritiesTree(rows, TZ, NOW, { topics, mappings });
  const all = allTasks(tree).sort();
  check("SUB-CATEGORIES: the tree shows exactly what the phone shows — linked + live (parked included), each once",
    all.join(",") === "parked,twice", `[${all.join(",")}] — loose/ghost have no reachable topic, done is closed`);
  check("SUB-CATEGORIES: a task with NO topic is NOT in the tree when topics are available — the phone's rule",
    !all.includes("loose") && !all.includes("ghost") && allTasks(tree.filter((n) => n.categoryAffinity === "VENTURES")).length === 0,
    "SupabaseTaskClient only reaches tasks through a mapping; the task stays on the board and in This Week");
  const fwd = findTopicMappings({ mappings }).get("twice");
  const rev = findTopicMappings({ mappings: [...mappings].reverse() }).get("twice");
  check("SUB-CATEGORIES: without timestamps, a task linked to two topics lands under ONE, the same on every read",
    fwd === "ta" && rev === "ta", `${fwd} / ${rev} — smallest topic id, the fallback for a journey that sends no created_at`);
  // With timestamps: the NEWEST link wins, which is what the owner's phone shows. Real values from
  // his board: "Prepare an inspections records database" -> Database Management at 13:06:59.099 and
  // Inspection Records Management at 13:06:59.191; his phone files it under the second.
  const timed = [
    { task_id: "insp", topic_id: "65784e06-db", created_at: "2026-09-21T13:06:59.099348+00:00" },
    { task_id: "insp", topic_id: "6658cd7e-ir", created_at: "2026-09-21T13:06:59.19153+00:00" },
  ];
  const nf = findTopicMappings({ mappings: timed }).get("insp");
  const nr = findTopicMappings({ mappings: [...timed].reverse() }).get("insp");
  check("SUB-CATEGORIES: with timestamps, the NEWEST link wins, matching the phone, in any row order",
    nf === "6658cd7e-ir" && nr === "6658cd7e-ir", `${nf} / ${nr} — the phone files it under Inspection Records Management`);
}

{
  // m7, INERT for the verifier: nothing asserted the ORDER of tasks inside a topic. That order is
  // what "what's next in <topic>?" reads, so it gets the same total-order guarantee as a category.
  const topics = [{ id: "ts", topic_name: "Sorted", category_affinity: "CAREER" }];
  const rows = [
    row({ id: "s-plain", category: "CAREER", title: "zzz" }),
    row({ id: "s-rank2", category: "CAREER", is_priority: true, priority_rank: 2, title: "b" }),
    row({ id: "s-rank1", category: "CAREER", is_priority: true, priority_rank: 1, title: "c" }),
  ];
  const mappings = rows.map((r) => ({ task_id: r.id, topic_id: "ts" }));
  const order = (rs: any[]) =>
    buildPrioritiesTree(rs, TZ, NOW, { topics, mappings })
      .find((n) => n.categoryAffinity === "CAREER")!.children[0].tasks.map((t) => t.id).join(",");
  check("SUB-CATEGORIES: tasks INSIDE a topic are ordered starred+ranked first, the same for any arrival order",
    order(rows) === "s-rank1,s-rank2,s-plain" && order([...rows].reverse()) === "s-rank1,s-rank2,s-plain",
    `${order(rows)} / reversed ${order([...rows].reverse())}`);
}

{
  // m8, INERT for the verifier: deleting the "not deployed" detection failed no test.
  check("SUB-CATEGORIES: journey's own 'Unknown tool' answer is read as tool-absent (a steady state), not an error",
    classifyTopicFailure("Unknown tool: get_task_topics", null) === "tool-absent" &&
      classifyTopicFailure(null, '{"error":"unknown tool"}') === "tool-absent",
    "execute-tool's own wording; the UI explains tool-absent instead of showing an error");
  check("SUB-CATEGORIES: any other failure is an error, shown with its text",
    classifyTopicFailure("permission denied for table task_topic_mappings", null) === "error" &&
      classifyTopicFailure(null, null) === "error",
    "a real failure must never be disguised as 'not deployed yet'");
}

{
  // Degradation: journey's tool not deployed / timed out → exactly the category-only tree.
  const rows = [row({ id: "d1", category: "CAREER" }), row({ id: "d2", category: "LIFE" })];
  const shape = (ns: TopicNode[]) => JSON.stringify(ns);
  check("SUB-CATEGORIES: with no topic payload the tree is IDENTICAL to the category-only tree",
    shape(buildPrioritiesTree(rows, TZ, NOW, undefined)) === shape(withKnownCategories(buildCategoryTaskTree(rows, TZ, NOW))) &&
      shape(buildPrioritiesTree(rows, TZ, NOW, { topics: [], mappings: [] })) === shape(withKnownCategories(buildCategoryTaskTree(rows, TZ, NOW))),
    "a missing journey tool must never cost the owner his categories");
}

{
  const payload = { topics: [{ id: "tp", topic_name: "P", category_affinity: "CAREER" }],
                    mappings: [{ task_id: "p1", topic_id: "tp" }] };
  const before = JSON.stringify(payload);
  buildPrioritiesTree([row({ id: "p1", category: "CAREER" })], TZ, NOW, payload);
  check("SUB-CATEGORIES: building the tree does not mutate journey's payload",
    JSON.stringify(payload) === before, "the proxy response is read, never written");
}

// ── THE DUPLICATION GUARD — this is the defect that actually shipped ────────────────────────────
//
// 2026-10-15, found by the owner, not by any test: the category tree was wired into
// `getPrioritiesWidget` only. `tools.ts` (`show_priorities_widget` — the path a scheduled 6am/8pm
// card goes through) built its OWN payload with a hardcoded `topics: {ok:false, roots:[],
// reason:"ok"}`. So Iris posted a card reading "No topics yet." while the identical data rendered a
// full tree on the docked widget. The feature looked unbuilt because two of its three doors were
// never opened.
//
// Prose would not have caught it and did not: this repo's own "extend, don't duplicate" rule and a
// comment at huddle.functions.ts:6429 BOTH warned about a second construction of this payload. So
// the guard is structural — the set of files allowed to call `buildPrioritiesBand` directly is
// pinned. A fourth surface that builds its own card fails this test and has to either use
// `composePrioritiesWidget` or come here and justify itself.
{
  const { readFileSync, readdirSync, statSync } = await import("node:fs");
  const { join } = await import("node:path");
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((e) => {
      const full = join(dir, e);
      return statSync(full).isDirectory() ? walk(full) : /\.tsx?$/.test(full) ? [full] : [];
    });

  const ALLOWED = new Set([
    // defines it, and defines the one composition every surface is meant to use
    "src/features/huddle/lib/tasks/widgets.server.ts",
    // band-only, by design: it needs the COUNTS for its message, never a card. Documented at its
    // call site. If this ever renders a widget, it must switch to composePrioritiesWidget.
    "src/features/huddle/lib/tasks/priority-check.server.ts",
  ]);

  // Watches EVERY builder of the card's pieces, not just the band. The verifier found the
  // original guard checked only buildPrioritiesBand, so a surface calling the tree builders
  // directly would have rebuilt half a card unnoticed: the exact defect this guard exists for.
  const callers = walk("src")
    .filter((f) => /\b(buildPrioritiesBand|buildPrioritiesTree|buildCategoryTaskTree)\s*\(/.test(readFileSync(f, "utf8")))
    .map((f) => f.replace(/\\/g, "/"))
    .sort();
  const rogue = callers.filter((f) => !ALLOWED.has(f));
  check(
    "no surface builds its own priorities payload (band OR tree) — every card goes through composePrioritiesWidget",
    rogue.length === 0,
    rogue.length
      ? `ROGUE: ${rogue.join(", ")} — use composePrioritiesWidget(email, tz) instead, or add it to ALLOWED with a reason`
      : `only ${callers.length} allowed caller(s): ${callers.map((f) => f.split("/").pop()).join(", ")}`,
  );
  check(
    "the allowlist is not stale — every file on it still calls one of the builders",
    [...ALLOWED].every((f) => callers.includes(f)),
    "an allowlist entry that no longer calls it would silently permit a future rogue caller of the same name",
  );
}

{
  // FAMILY — the phone draws every configured category (default LIFE, CAREER, VENTURES, EDUCATION,
  // FAMILY) whether or not a topic claims it. Owner, 2026-10-15: "show Family".
  const topics = [{ id: "tc", topic_name: "Career Development", category_affinity: "CAREER" }];
  const tree = buildPrioritiesTree([row({ id: "f1", category: "CAREER" })], TZ, NOW,
    { topics, mappings: [{ task_id: "f1", topic_id: "tc" }] });
  const order = tree.map((n) => n.categoryAffinity).join(",");
  // Order superseded 2026-10-15 by the owner: "anything with items should be at the top". Career is
  // the only category with a task here, so it leads; the four empty ones keep the phone's order below.
  check("FAMILY: with topics, all five known categories render — those with tasks first, then the phone's order",
    order === "CAREER,LIFE,VENTURES,EDUCATION,FAMILY", order);
  const fam = tree.find((n) => n.categoryAffinity === "FAMILY")!;
  check("FAMILY: an empty category is a real row with a BLANK count and nothing under it",
    !!fam && fam.name === "Family" && fam.count === null && fam.children.length === 0 && fam.tasks.length === 0,
    JSON.stringify(fam && { name: fam.name, count: fam.count, kids: fam.children.length, tasks: fam.tasks.length }));
  const deg = buildPrioritiesTree([row({ id: "f2", category: "FAMILY" }), row({ id: "f3", category: null }),
    row({ id: "f4", category: "SIDE_HUSTLE" })], TZ, NOW, undefined);
  const famRows = deg.filter((n) => n.categoryAffinity === "FAMILY");
  check("FAMILY: a category that HAS tasks is never duplicated by the empty-row fill",
    famRows.length === 1 && famRows[0].tasks.map((t) => t.id).join(",") === "f2",
    `${famRows.length} Family row(s), tasks=[${famRows.flatMap((n) => n.tasks.map((t) => t.id))}]`);
  check("FAMILY: the fill only ADDS — a dynamic category is kept, and Uncategorised is last of the rows WITH tasks",
    deg.map((n) => n.categoryAffinity).join(",") === "FAMILY,SIDE_HUSTLE,UNCATEGORISED,LIFE,CAREER,VENTURES,EDUCATION",
    deg.map((n) => n.categoryAffinity).join(","));
}

{
  // ORDER BY CONTENT — owner, 2026-10-15: "anything with items should be at the top grey empty topics
  // should be below by date."
  const topics = [
    { id: "t-late", topic_name: "Late", category_affinity: "CAREER" },
    { id: "t-soon", topic_name: "Soon", category_affinity: "CAREER" },
    { id: "t-undated", topic_name: "Undated", category_affinity: "CAREER" },
    { id: "t-old", topic_name: "Old empty", category_affinity: "CAREER", updated_at: "2026-01-01T00:00:00Z" },
    { id: "t-new", topic_name: "New empty", category_affinity: "CAREER", updated_at: "2026-10-01T00:00:00Z" },
    { id: "t-nodate", topic_name: "No-date empty", category_affinity: "CAREER" },
  ];
  const rows = [
    row({ id: "late", category: "CAREER", due_date: "2026-12-01" }),
    row({ id: "soon", category: "CAREER", due_date: "2026-10-20" }),
    row({ id: "undated", category: "CAREER" }),
  ];
  const mappings = [
    { task_id: "late", topic_id: "t-late" }, { task_id: "soon", topic_id: "t-soon" },
    { task_id: "undated", topic_id: "t-undated" },
  ];
  const tree = buildPrioritiesTree(rows, TZ, NOW, { topics, mappings });
  const career = tree.find((n) => n.categoryAffinity === "CAREER")!;
  const names = career.children.map((c) => c.name).join(",");
  check("ORDER: topics WITH tasks come first, soonest task date first, undated last",
    names.startsWith("Soon,Late,Undated,"), names);
  check("ORDER: EMPTY topics come after, most recently updated first, undated-topic last",
    names.endsWith(",New empty,Old empty,No-date empty"), names);
  check("ORDER: a category with tasks sorts above every empty category",
    tree[0].categoryAffinity === "CAREER", tree.map((n) => n.categoryAffinity).join(","));
}

console.log(`\n==================== ${pass} passed, ${fail} failed ====================`);
process.exit(fail === 0 ? 0 : 1);
