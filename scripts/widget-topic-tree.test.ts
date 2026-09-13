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

import {
  buildTopicTree,
  categoryLabel,
  displayCategory,
  CATEGORY_ROOT_PREFIX,
} from "../src/features/huddle/lib/tasks/widgets.server";

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
    "categories render in journey's DISPLAY_CATEGORIES order, not in topic-position order",
    roots.map((r) => r.categoryAffinity).join(",") === "CAREER,VENTURES,EDUCATION",
    `order: [${roots.map((r) => r.categoryAffinity).join(", ")}] — fixed by DISPLAY_CATEGORIES regardless of the topics' own positions`,
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

// ── THE CLOBBER CASE. journey's tree is category > group > SUB-GROUP > task (f0ab561). Category
//    and sub-group nesting COMPOSE. The first version of groupByCategory bailed out on
//    `roots.some(n => n.children.length > 0)`, so one sub-group appearing deleted the whole category
//    level — and journey is actively building toward populated parent_topic_id. Owner caught it.
{
  const roots = buildTopicTree({
    topics: [
      { id: "g1", topic_name: "Fundraising", parent_topic_id: null, category_affinity: "VENTURES", task_count: 5 },
      { id: "s1", topic_name: "Seed round", parent_topic_id: "g1", category_affinity: "VENTURES", task_count: 3 },
      { id: "g2", topic_name: "Promotion case", parent_topic_id: null, category_affinity: "CAREER", task_count: 4 },
    ],
  });
  const ventures = roots.find((r) => r.categoryAffinity === "VENTURES");
  check(
    "a SUB-GROUP does not delete the category level — the two nest, they are not alternatives",
    roots.length === 2 &&
      roots.every((r) => r.id.startsWith(CATEGORY_ROOT_PREFIX)) &&
      ventures?.children[0]?.id === "g1" &&
      ventures?.children[0]?.children[0]?.id === "s1",
    `category > group > sub-group = ${roots.length} categories, Ventures > ${ventures?.children[0]?.name} > ${ventures?.children[0]?.children[0]?.name}`,
  );
  check(
    "a category counts its WHOLE subtree, so a sub-group's tasks are not lost from the total",
    ventures?.count === 8,
    `Ventures = ${ventures?.count} (group 5 + sub-group 3) — direct children alone would read 5`,
  );
}

{
  const roots = buildTopicTree({
    topics: [
      { topic_name: "Promotion case", category_affinity: "CAREER", count: 3, children: [{ topic_name: "Evidence pack", count: 3 }] },
    ],
  });
  check(
    "a pre-nested payload keeps its nesting AND still gets its category row",
    roots.length === 1 &&
      roots[0].id.startsWith(CATEGORY_ROOT_PREFIX) &&
      roots[0].children[0]?.children.length === 1,
    `roots: [${names(roots)}] > ${roots[0]?.children[0]?.name} > ${roots[0]?.children[0]?.children[0]?.name}`,
  );
}

{
  const roots = buildTopicTree({
    topics: [
      { id: "g", topic_name: "Group", parent_topic_id: null },
      { id: "s", topic_name: "Sub", parent_topic_id: "g", category_affinity: "LIFE" },
    ],
  });
  check(
    "a group with no category of its own is placed by a category found beneath it",
    roots.length === 1 && roots[0].categoryAffinity === "LIFE" && roots[0].children[0]?.id === "g",
    `placed under [${names(roots)}]`,
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

// ── journey MERGES six raw keys into five display rows (f0ab561 CATEGORY_DISPLAY_MAP). ───────────
//    An earlier version of this file rendered one row per raw key — a separate "Personal" and a
//    separate "Prof. Education". That is what journey's `main` does and it is NOT what the owner
//    sees; his screenshot has exactly five rows.
check(
  "PROF_EDUCATION and EDUCATION collapse into ONE Education row",
  displayCategory("PROF_EDUCATION") === "EDUCATION" && displayCategory("EDUCATION") === "EDUCATION",
  `PROF_EDUCATION -> ${displayCategory("PROF_EDUCATION")}`,
);
check(
  "PERSONAL folds into LIFE, labelled 'Life & Personal'",
  displayCategory("PERSONAL") === "LIFE" && categoryLabel("LIFE") === "Life & Personal",
  `PERSONAL -> ${displayCategory("PERSONAL")} -> "${categoryLabel("LIFE")}"`,
);
{
  const roots = buildTopicTree({
    topics: [
      { id: "a", topic_name: "Degree", parent_topic_id: null, category_affinity: "EDUCATION", task_count: 1 },
      { id: "b", topic_name: "Certification", parent_topic_id: null, category_affinity: "PROF_EDUCATION", task_count: 19 },
      { id: "c", topic_name: "Errands", parent_topic_id: null, category_affinity: "PERSONAL", task_count: 2 },
      { id: "d", topic_name: "Health", parent_topic_id: null, category_affinity: "LIFE", task_count: 27 },
    ],
  });
  check(
    "the merge happens end-to-end: four raw keys render as TWO category rows, not four",
    roots.length === 2 && roots.find((r) => r.name === "Education")?.count === 20,
    `rows: [${names(roots)}]; Education = ${roots.find((r) => r.name === "Education")?.count} (1 + 19)`,
  );
  check(
    "known categories render in journey's fixed order — Life & Personal before Education",
    roots[0]?.name === "Life & Personal",
    `order: [${names(roots)}] (DISPLAY_CATEGORIES = LIFE, CAREER, VENTURES, EDUCATION, FAMILY)`,
  );
}
{
  const roots = buildTopicTree({
    topics: [
      { id: "u", topic_name: "Side gig", parent_topic_id: null, category_affinity: "SIDE_HUSTLE" },
      { id: "k", topic_name: "Promotion", parent_topic_id: null, category_affinity: "CAREER" },
    ],
  });
  check(
    "an UNKNOWN category passes through, humanized, and sorts AFTER every known one",
    roots.length === 2 && roots[0].name === "Career" && roots[1].name === "Side Hustle",
    `order: [${names(roots)}] — 532da6b's hybrid dynamic detection; the map is an ORDERING, not an allow-list`,
  );
}

console.log(`\n==================== ${pass} passed, ${fail} failed ====================`);
process.exit(fail === 0 ? 0 : 1);
