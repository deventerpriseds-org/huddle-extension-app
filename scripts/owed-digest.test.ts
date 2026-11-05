// WHAT:       Proves the owed-correspondence digest's decisions: zero owed -> NOTHING (null, so neither
//             chat nor email can send), only owed|drafted rows count, oldest first, the cap keeps the
//             true total, untrusted names/subjects are HTML-escaped in the email, and the job is wired
//             into the scheduler, Settings, the turn payload and the client mappers.
// WHY:        Owner, 2026-11-05: "if none are due i get nothing ... if 1+ i get a reminder/report on who
//             I still owe ... with the ability to dismiss".
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   .claude/actions.md ACT:owed-digest. Run: bun scripts/owed-digest.test.ts
//
// PURE FUNCTIONS + source-wiring checks. Delivery is proven by a live dry run + one real run.

import {
  ageLabel,
  buildOwedDigest,
  OWED_DIGEST_MAX_ITEMS,
  type OwedRowLike,
} from "../src/features/huddle/lib/email/owed-digest";
import { SCHEDULING_DEFAULTS } from "../src/features/huddle/lib/identity/scheduling-config.server";
import { readFileSync } from "node:fs";

let failed = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail !== undefined ? ` -- ${JSON.stringify(detail)}` : ""}`,
  );
  if (!ok) failed++;
}

const NOW = Date.parse("2026-11-05T15:00:00Z");
const row = (
  id: string,
  hoursAgo: number | null,
  status = "owed",
  extra: Partial<OwedRowLike> = {},
): OwedRowLike => ({
  id,
  from_name: `Person ${id}`,
  from_address: `${id}@example.com`,
  subject: `Subject ${id}`,
  received_at: hoursAgo === null ? null : new Date(NOW - hoursAgo * 3_600_000).toISOString(),
  status,
  draft_web_link: null,
  ...extra,
});

// 1. Nothing owed -> nothing at all.
check("empty list -> null (nothing sent)", buildOwedDigest([], { nowMs: NOW }) === null);
check(
  "only settled rows -> null",
  buildOwedDigest([row("a", 5, "replied"), row("b", 3, "dismissed")], { nowMs: NOW }) === null,
);

// 2. Only owed|drafted count.
const mixed = buildOwedDigest(
  [
    row("a", 5, "replied"),
    row("b", 3, "owed"),
    row("c", 30, "drafted", { draft_web_link: "https://outlook/x" }),
  ],
  { nowMs: NOW, appUrl: "https://app.example/" },
);
check("mixed -> total counts owed+drafted only", mixed?.total === 2, mixed?.total);
check("mixed -> settled row absent", !!mixed && !mixed.card.items.some((i) => i.emailId === "a"));
check(
  "oldest first",
  mixed?.card.items.map((i) => i.emailId).join(",") === "c,b",
  mixed?.card.items.map((i) => i.emailId),
);
check(
  "drafted flag + link carried",
  mixed?.card.items[0].drafted === true && mixed.card.items[0].draftWebLink === "https://outlook/x",
);
check("owed row has no draft link", mixed?.card.items[1].draftWebLink === undefined);
check(
  "email subject names the count",
  mixed?.email.subject === "You still owe 2 email replies",
  mixed?.email.subject,
);
check(
  "email links to Iris's 1:1 (no double slash)",
  !!mixed?.email.html.includes('href="https://app.example/?huddle=dm-iris-chase"'),
);
check("directive forbids tools/drafting", !!mixed?.directive.includes("do not call tools"));
check(
  "singular wording",
  buildOwedDigest([row("z", 1)], { nowMs: NOW })?.email.subject === "You still owe 1 email reply",
);

// 3. Cap keeps the true total.
const many = Array.from({ length: OWED_DIGEST_MAX_ITEMS + 7 }, (_, i) => row(`r${i}`, i + 1));
const capped = buildOwedDigest(many, { nowMs: NOW });
check(
  "cap: items capped",
  capped?.card.items.length === OWED_DIGEST_MAX_ITEMS,
  capped?.card.items.length,
);
check(
  "cap: total is the real count",
  capped?.total === OWED_DIGEST_MAX_ITEMS + 7 && capped?.card.total === OWED_DIGEST_MAX_ITEMS + 7,
);
check("cap: email says how many more", !!capped?.email.html.includes("…and 7 more."));

// 4. Sender-controlled text is escaped in the HTML email.
const evil = buildOwedDigest(
  [row("e", 2, "owed", { from_name: "<script>x</script>", subject: 'a"&b' })],
  { nowMs: NOW },
);
check(
  "html: name escaped",
  !!evil && !evil.email.html.includes("<script>") && evil.email.html.includes("&lt;script&gt;"),
);
check("html: subject escaped", !!evil?.email.html.includes("a&quot;&amp;b"));

// 5. Age labels.
check("age 30m", ageLabel(new Date(NOW - 30 * 60_000).toISOString(), NOW) === "30m");
check("age 5h", ageLabel(new Date(NOW - 5 * 3_600_000).toISOString(), NOW) === "5h");
check("age 3d", ageLabel(new Date(NOW - 72 * 3_600_000).toISOString(), NOW) === "3d");
check("age null", ageLabel(null, NOW) === "");
check(
  "undated rows go last",
  buildOwedDigest([row("n", null), row("o", 2)], { nowMs: NOW })?.card.items[1].emailId === "n",
);

// 6. Wiring.
check(
  "default cadence exists and is user-overridable",
  Array.isArray(SCHEDULING_DEFAULTS.owedDigest?.hours) &&
    SCHEDULING_DEFAULTS.owedDigest.hours.length > 0,
);
const sched = readFileSync("src/features/huddle/lib/tasks/scheduler.server.ts", "utf8");
check(
  "scheduler: job row",
  sched.includes('{ key: "owedDigest", idPrefix: "owed-digest", jobType: "owed-digest" }'),
);
check(
  "scheduler: fire case posts the route",
  sched.includes('job.job_type === "owed-digest"') &&
    sched.includes('"/api/public/run-owed-digest"'),
);
const panel = readFileSync("src/features/huddle/components/SchedulingPanel.tsx", "utf8");
check(
  "settings panel lists the key",
  /JOB_TYPE_KEYS: JobTypeKey\[\] = \[[^\]]*"owedDigest"/s.test(panel),
);
const cfgFns = readFileSync(
  "src/features/huddle/lib/identity/scheduling-config.functions.ts",
  "utf8",
);
check(
  "settings save validator accepts the key",
  /JOB_TYPE_KEYS = \[[^\]]*"owedDigest"/s.test(cfgFns),
);
const hf = readFileSync("src/features/huddle/lib/huddle.functions.ts", "utf8");
check("payload schema carries owedDigest", /\n  owedDigest: z\n/.test(hf));
check(
  "card attached to target reply",
  hf.includes(
    "owedDigest: data.owedDigest && nextId === data.targetAgentId ? data.owedDigest : undefined",
  ),
);
check(
  "card delivered even with no model reply (both exits)",
  (hf.match(/ensureOwedDigestDelivered\(\);/g) ?? []).length === 2,
);
for (const f of [
  "src/features/huddle/components/HuddleApp.tsx",
  "src/features/huddle/components/HuddleView.tsx",
]) {
  const src = readFileSync(f, "utf8");
  check(
    `client mapper keeps the field: ${f.split("/").pop()}`,
    src.includes("owedDigest: reply.owedDigest,") && src.includes("owedDigest?: OwedDigestCard;"),
  );
}
const runner = readFileSync("src/features/huddle/lib/email/owed-digest.server.ts", "utf8");
check(
  "runner returns nothing-sent when digest is null",
  runner.includes('if (!digest) return { ok: true, owed: 0, reconciled, skipped: "none-owed" };'),
);
const iResult = runner.indexOf("export interface OwedDigestRunResult {");
const resultType = runner
  .slice(iResult, runner.indexOf("\n}", iResult))
  .replace(/\/\*\*[\s\S]*?\*\//g, "");
check(
  "public result type carries no names/subjects/addresses",
  !/from|subject|address|name/i.test(resultType.replace(/OwedDigestRunResult/, "")),
  resultType,
);

console.log(failed ? `\n${failed} FAILED` : "\nALL PASS");
process.exit(failed ? 1 : 0);
