// WHAT:       Pins the board card's "Open in journey" deep link: the URL is journey's configured base +
//             `/tasks?...task=<journey task uuid>`, it is ABSENT when the base is not configured, and the
//             link cannot start a card drag or reach the card's handlers.
// WHY:        Owner, 2026-10-29: "I can't click to go to the task in journey" -> "Add the deep links".
// SUPERSEDES: nothing
// SUPERSEDED-BY: nothing -- current
// EVIDENCE:   run with `npm run test:journey-link`; docs/qc-evidence/FIX-board-journey-deeplink.md.
import { readFileSync } from "node:fs";
import {
  buildJourneyTaskUrl,
  journeyAppBaseUrl,
  JOURNEY_APP_URL_DEFAULT,
  JOURNEY_APP_URL_ENV,
} from "../src/features/huddle/lib/journey/journey-links";

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`);
}

const ID = "3f2b9c1e-7a4d-4e8b-9c0a-1b2c3d4e5f60";

// --- the builder -----------------------------------------------------------------------------------
check("href = configured base + /tasks route + task id",
  buildJourneyTaskUrl("https://journey.example", ID), `https://journey.example/tasks?view=kanban&task=${ID}`);
check("trailing slashes on the base are not doubled",
  buildJourneyTaskUrl("https://journey.example///", ID), `https://journey.example/tasks?view=kanban&task=${ID}`);
check("the task id is URL-encoded",
  buildJourneyTaskUrl("https://journey.example", "a b&c"), "https://journey.example/tasks?view=kanban&task=a%20b%26c");
check("no link when the base is empty (not configured)", buildJourneyTaskUrl("", ID), null);
check("no link when the base is undefined", buildJourneyTaskUrl(undefined, ID), null);
check("no link when the base is whitespace", buildJourneyTaskUrl("   ", ID), null);
check("no link when the base is not http(s)", buildJourneyTaskUrl("javascript:alert(1)", ID), null);
check("no link when the base is a bare path", buildJourneyTaskUrl("/tasks", ID), null);
check("no link when the task id is empty", buildJourneyTaskUrl("https://journey.example", ""), null);

// --- the configured base ---------------------------------------------------------------------------
check("default is journey's published host (bridge.config.json)", JOURNEY_APP_URL_DEFAULT, "https://journey-voice.lovable.app");
const env = (import.meta as { env?: Record<string, string | undefined> }).env;
const envWritable = !!env;
check("import.meta.env is readable in this runner", envWritable, true);
if (env) {
  delete env[JOURNEY_APP_URL_ENV];
  check("unset override -> default host", journeyAppBaseUrl(), JOURNEY_APP_URL_DEFAULT);
  env[JOURNEY_APP_URL_ENV] = "https://staging.journey.example";
  check("override is honoured", journeyAppBaseUrl(), "https://staging.journey.example");
  check("override flows into the card href", buildJourneyTaskUrl(journeyAppBaseUrl(), ID),
    `https://staging.journey.example/tasks?view=kanban&task=${ID}`);
  env[JOURNEY_APP_URL_ENV] = "";
  check("override set to empty -> links OFF", buildJourneyTaskUrl(journeyAppBaseUrl(), ID), null);
  delete env[JOURNEY_APP_URL_ENV];
}

// --- the card wiring (BoardCard is unexported and pulls MSAL/store/server fns, so pin the source) ---
const view = readFileSync(new URL("../src/features/huddle/components/BoardView.tsx", import.meta.url), "utf8");
const card = view.slice(view.indexOf("function BoardCard("));
check("card href is built from the configured base + THIS task's id",
  /const journeyHref = buildJourneyTaskUrl\(journeyAppBaseUrl\(\), task\.id\);/.test(card), true);
check("the link renders only when there is an href", /\{journeyHref && \(\s*(?:\/\/[^\n]*\n\s*)*<a\b/.test(card), true);
const anchor = card.slice(card.indexOf('data-testid="open-in-journey"'), card.indexOf("Open in journey\n"));
check("anchor uses that href", /href=\{journeyHref\}/.test(anchor), true);
check("opens in a new tab, without opener", /target="_blank"/.test(anchor) && /rel="noopener noreferrer"/.test(anchor), true);
check("click does not reach the card", /onClick=\{\(e\) => e\.stopPropagation\(\)\}/.test(anchor), true);
check("dragging the link never starts a card drag",
  /draggable=\{false\}/.test(anchor) && /onDragStart=\{\(e\) => e\.stopPropagation\(\)\}/.test(anchor), true);
check("visible label + icon", /<ExternalLink size=\{11\} aria-hidden="true" \/>\s*$/.test(anchor.trimEnd() + "\n") || /<ExternalLink[^>]*\/>/.test(anchor), true);
check("BoardCard is the only card component (desktop + mobile both render it)",
  (view.match(/<BoardCard\b/g) ?? []).length, 2);

console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
process.exit(failures ? 1 : 0);
