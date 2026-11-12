// WHAT:          Offline proof that (1) the work turn receives what the user CONFIRMED (DoD + approach),
//                (2) every confirm ask names the task instead of "this", and (3) every confirm ask and work
//                result carries real links plus a short summary of the product/service.
// WHY:           Owner, 2026-11-05: "if i answer to ezra, this is confirmed, and my zipcode is 21158, will he
//                have the context?" — the work turn ran with history [] and the title only, so the ZIP never
//                reached it. "a link should be a baseline addition … verva research should include a link and
//                a summary". "it has a pattern of before I get started on 'this' instead of the task".
// SUPERSEDES:    nothing. SUPERSEDED-BY: nothing -- current.
// EVIDENCE:      azure-pg-query run 42082407681 (Ezra's ask asking for the ZIP; openers "before I get going on this").
// Run: bun scripts/confirm-ask-context.test.ts
import { readFileSync } from "node:fs";

const SRC = `${import.meta.dir}/../src/features/huddle/lib/tasks`;
const { agreedBrief, confirmIntentDirective, researchDirective } = await import(
  `${SRC}/autowork.server.ts`
);
const groomSrc = readFileSync(`${SRC}/groom.ts`, "utf8");
const awSrc = readFileSync(`${SRC}/autowork.server.ts`, "utf8");

let p = 0,
  f = 0;
const t = (n: string, c: boolean, d = "") => {
  c ? (p++, console.log("PASS  " + n)) : (f++, console.log("FAIL  " + n + (d && "  — " + d)));
};

console.log("--- the work turn carries what the user confirmed ---");
const brief = agreedBrief({
  dod: "Compare 3–5 shops near ZIP 21158 with reviews",
  approach: "Search Bel Air MD shops",
});
t("confirmed DoD reaches the work turn", brief.includes("ZIP 21158"));
t("approved approach reaches the work turn", brief.includes("Search Bel Air MD shops"));
t("specifics must be used", /use every specific they gave/i.test(brief));
const work = researchDirective(
  {
    id: "t9",
    title: "Research someone to install brakes",
    category: "LIFE",
    assigned_agent: "ezra-miles",
  },
  { dod: "Compare shops near ZIP 21158", approach: null },
);
t(
  "the work directive itself opens with the confirmed brief",
  work.startsWith("WHAT THE USER CONFIRMED") && work.includes("ZIP 21158"),
);
t("nothing confirmed -> no block", agreedBrief({}) === "" && agreedBrief() === "");
t(
  "the call site passes the engagement state's DoD + approach",
  /researchDirective\(task, agreed\)/.test(awSrc) &&
    /eng\?\.confirmed_dod \?\? task\.definition_of_done/.test(awSrc) &&
    /eng\?\.proposed_approach/.test(awSrc),
);
t(
  "the work directive requires links + a short summary",
  /Always include the relevant ` \+\s*`links you found, and for any product, service, tool or provider a short plain summary/.test(
    awSrc,
  ),
);

console.log("\n--- confirm asks name the task and carry links ---");
const task = {
  id: "t1",
  title: "Research Verva AI writing improvement app",
  assigned_agent: "tess-sutton",
};
for (const followUp of [false, true]) {
  const d = confirmIntentDirective(task, { followUp });
  const k = followUp ? "re-ask" : "first ask";
  t(`${k}: names the task in plain words`, /NAMES THE TASK|BY NAMING THE TASK/.test(d));
  t(`${k}: forbids "this" as the subject`, /never "this/.test(d));
  t(
    `${k}: no longer models "before I get going on this"`,
    !/before I get going on this/.test(d) && !/Circling back on this one/.test(d),
  );
  if (!followUp) {
    t(
      `${k}: always includes real links`,
      /ALWAYS include, in the message, the most relevant link/.test(d) &&
        /never ` \+?\s*`?invent a URL|never invent a URL/.test(d),
    );
  } else {
    // Owner 2026-11-12 option a-narrow: re-asks were 38 of 43 Tavily searches in a week.
    t(
      `${k}: does NOT search the web`,
      /Do NOT search the web for this follow-up/.test(d) && !/with your web search/.test(d),
    );
    t(`${k}: never invents a URL`, /Never invent a URL/.test(d));
  }
  t(
    `${k}: summary of the product for knowledge`,
    /one-to-two sentence summary of what it is/.test(d),
  );
}

console.log("\n--- re-asks are not handed the web-search tool ---");
t(
  "turnPayload's webSearch defaults on and is overridable",
  /webSearch: opts\.webSearch \?\? true/.test(awSrc),
);
t(
  "the confirm-ask enqueue turns web search off for re-asks only",
  /"push",\s*\{\s*webSearch: !followUp/.test(awSrc),
);

console.log("\n--- grooming: an app fix is not agent work ---");
t(
  "app/system bug fix is a 'none' example",
  /fixing a bug or a broken section in an app or system/.test(groomSrc) &&
    /Fix the\s+Nexus assignments section/.test(groomSrc),
);

console.log(`\n${p}/${p + f} passed`);
process.exit(f ? 1 : 0);
