// WHAT:       Proves `buildTopicTree` produces the CATEGORY → topic shape journey actually draws,
//             from the payload shape journey's table actually holds.
// WHY:        Measured 2026-09-13 against journey (supabase project wwxgajrtmslzklnyplah):
//               select count(*), count(parent_topic_id), count(distinct category_affinity)
//                 from public.task_topic_index;   ->  158, 0, 5
//             `parent_topic_id` is NULL on EVERY row. `buildTopicTree` nested on parent_topic_id
//             alone, so the live payload would have rendered as 158 FLAT ROWS -- never the five
//             collapsible category rows in the owner's screenshot. NOTHING tested buildTopicTree at
//             all before this file, and every fixture written by hand invented a parent_topic_id the
//             real table has never contained. Same defect class as the pink band: green logic over a
//             shape nobody had looked at.
// SUPERSEDES: nothing
// SUPERSEDED-BY: nothing -- current
// EVIDENCE:   the query above; journey-voice/src/pages/Priorities.tsx:284 (`categoryKeys.map`) is
//             where journey itself groups by category before nesting by parent; the owner's
//             screenshot reads Ventures 40 and open non-test tasks with category=VENTURES measured
//             exactly 40.
//
// Run:  bun scripts/widget-topic-tree.test.ts   (npm run test:widget-topics)

import { buildTopicTree, categoryLabel, CATEGORY_ROOT_PREFIX } from "../src/features/huddle/lib/tasks/widgets.server";

let pass = 0,
  fail = 0;
function check(label: string, cond: boolean, detail: string) {
  console.log(`  ${cond ? "PASS" : "FAIL"} ${label} — ${detail}`);
  cond ? pass++ : fail++;
}

const names = (ns: { name: string }[]) => ns.map((n) => n.name).join(", ");

// ── The REAL shape: flat, parent_topic_id null everywhere, category_affinity populated ──────────
// Field names and values are journey's own, from the select the Android bridge runs verbatim
// (android-bridge-template SupabaseTaskClient.kt:219).
const LIVE_SHAPE = {
  topics: [
    { id: "t1", topic_name: "Huddle rollout", parent_topic_id: null, category_affinity: "VENTURES", position: 1, task_count: 12 },
    { id: "t2", topic_name: "Fundraising", parent_topic_id: null, category_affinity: "VENTURES", position: 2, task_count: 28 },
    { id: "t3", topic_name: "Promotion case", parent_topic_id: null, category_affinity: "CAREER", position: 0, task_count: 25 },
    { id: "t4", topic_name: "Certification", parent_topic_id: null, category_affinity: "PROF_EDUCATION", position: 3, task_count: 19 },
  ],
};

{
  const roots = buildTopicTree(LIVE_SHAPE);
  check(
    "the live shape (no parent_topic_id anywhere) groups into CATEGORY roots, not a flat list",
    roots.length === 3 && roots.every((r) => r.id.startsWith(CATEGORY_ROOT_PREFIX)),
    `${roots.length} roots: [${names(roots)}] — a flat list would have been 4 topic rows`,
  );

  const career = roots.find((r) => r.categoryAffinity === "CAREER");
  const ventures = roots.find((r) => r.categoryAffinity === "VENTURES");

  check(
    "every topic lands under its own category and none is lost",
    roots.reduce((n, r) => n + r.children.length, 0) === 4 && ventures?.children.length === 2,
    `4 topics in, ${roots.reduce((n, r) => n + r.children.length, 0)} out; Ventures holds ${ventures?.children.length}`,
  );

  check(
    "a category row's count is the SUM of its topics' counts (the screenshot's Ventures 40)",
    ventures?.count === 40,
    `Ventures count = ${ventures?.count} (12 + 28)`,
  );

  check(
    "categories sort by their earliest topic's position, so journey's own ordering still drives the rail",
    roots[0]?.categoryAffinity === "CAREER",
    `order: [${roots.map((r) => r.categoryAffinity).join(", ")}] — Career's topic is position 0`,
  );

  check(
    "the category root carries categoryAffinity, so the coloured spine resolves at depth 0",
    Boolean(career?.categoryAffinity) && career?.parentId === null,
    `Career root: categoryAffinity=${career?.categoryAffinity}, parentId=${String(career?.parentId)}`,
  );
}

// ── A category with no counts at all must render BLANK, never 0 (the spec's Family row) ─────────
{
  const roots = buildTopicTree({
    topics: [
      { id: "f1", topic_name: "Kids", parent_topic_id: null, category_affinity: "FAMILY" },
      { id: "f2", topic_name: "Household", parent_topic_id: null, category_affinity: "FAMILY" },
    ],
  });
  check(
    "a category whose topics report no count keeps count NULL — the spec draws a blank, never a 0",
    roots.length === 1 && roots[0].count === null,
    `count = ${String(roots[0]?.count)} (0 would render a literal "0" the spec never shows)`,
  );
}

// ── Precedence: REAL nesting must win. Grouping is only for the no-parent case. ──────────────────
{
  const roots = buildTopicTree({
    topics: [
      { id: "p1", topic_name: "Parent", parent_topic_id: null, category_affinity: "LIFE" },
      { id: "c1", topic_name: "Child", parent_topic_id: "p1", category_affinity: "LIFE" },
    ],
  });
  check(
    "when parent_topic_id IS populated, real nesting wins and no category root is synthesized",
    roots.length === 1 && roots[0].id === "p1" && roots[0].children[0]?.id === "c1",
    `roots: [${names(roots)}] with ${roots[0]?.children.length} child — journey may start populating parents later`,
  );
}

{
  const roots = buildTopicTree({
    topics: [
      { topic_name: "Career", count: 3, children: [{ topic_name: "Promotion case", count: 3 }] },
    ],
  });
  check(
    "an already-nested payload is trusted as-is and never re-grouped",
    roots.length === 1 && roots[0].children.length === 1 && !roots[0].id.startsWith(CATEGORY_ROOT_PREFIX),
    `root id = ${roots[0]?.id}`,
  );
}

// ── A topic with no category must survive as its own row, never be dropped or bucketed as "Other" ─
{
  const roots = buildTopicTree({
    topics: [
      { id: "a", topic_name: "Categorised", parent_topic_id: null, category_affinity: "LIFE" },
      { id: "b", topic_name: "Orphan", parent_topic_id: null, category_affinity: null },
    ],
  });
  check(
    "a topic with NO category stays a top-level row rather than vanishing",
    roots.some((r) => r.name === "Orphan") && roots.some((r) => r.categoryAffinity === "LIFE"),
    `roots: [${names(roots)}]`,
  );
}

// ── Nothing to group on at all: unchanged behaviour, no empty category roots ─────────────────────
{
  const roots = buildTopicTree({ topics: [{ id: "x", topic_name: "Solo", parent_topic_id: null }] });
  check(
    "no category on any node = no grouping, and the topic still renders",
    roots.length === 1 && roots[0].name === "Solo",
    `roots: [${names(roots)}]`,
  );
}

// ── Labels: journey's own display names, and an UNKNOWN key must still render ────────────────────
check(
  "PROF_EDUCATION uses journey's own label, not the raw key",
  categoryLabel("PROF_EDUCATION") === "Prof. Education",
  `-> "${categoryLabel("PROF_EDUCATION")}" (journey-voice KanbanBoard.tsx:57)`,
);
check(
  "an unknown category key still renders, humanized — the map is a LOOKUP, not an allow-list",
  categoryLabel("SIDE_HUSTLE") === "Side Hustle",
  `-> "${categoryLabel("SIDE_HUSTLE")}" — categories are user config, so a new one must work with no code change`,
);

console.log(`\n==================== ${pass} passed, ${fail} failed ====================`);
process.exit(fail === 0 ? 0 : 1);
