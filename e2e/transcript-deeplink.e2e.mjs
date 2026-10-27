// WHAT:       Headless replay of the push deep-link open: land in a 1:1 by `?huddle=dm-<agent>`, then
//             deliver a long history LATE (as the workspace download does), and check where the real
//             Transcript ends up — plus scroll-up paging and "don't yank a reader who scrolled up".
// WHY:        2026-10-27, the owner: tapping a 1:1 heads-up opened the thread at the TOP of history and
//             stayed there after it loaded. See src/features/huddle/lib/transcript-scroll.ts.
// SUPERSEDES: nothing
// SUPERSEDED-BY: nothing -- current
// EVIDENCE:   run output (A/B against the pre-fix Transcript) recorded in the PR.
//
// Run:  VITE_E2E_AUTH_BYPASS=1 npx vite dev --port 4173 --host 127.0.0.1 &
//       PORT=4173 node e2e/transcript-deeplink.e2e.mjs
//
// WHAT THIS CANNOT PROVE: the owner's phone. This is desktop Chromium on the dev build with the auth
// bypass; status stays MECHANISM ONLY until he taps a real heads-up.
import { chromium } from "playwright";

const PORT = process.env.PORT || "4173";
const HUDDLE = "dm-sam-trent";
const TOTAL = 300;
const SEL = '[data-testid="transcript"], section > div.overflow-y-auto';

let failed = 0;
const report = (ok, label, detail) => {
  console.log(`${ok ? "✅ PASS" : "❌ FAIL"} ${label} — ${detail}`);
  if (!ok) failed++;
};

const browser = await chromium.launch(
  process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {},
);
const page = await browser.newPage({ viewport: { width: 420, height: 860 } });
await page.goto(`http://127.0.0.1:${PORT}/?huddle=${HUDDLE}`, { waitUntil: "networkidle" });
await page.waitForSelector(SEL, { timeout: 30000 });

// A real cold open shows the deep-linked thread BEFORE the workspace download lands: the 1:1 is
// active, it has no history yet, and it sits at scrollTop 0. Model exactly that, and ASSERT it, because
// this harness once passed the pre-fix code for the wrong reason: the dev bypass seeds the workspace
// with no deep-link handling, so the group thread was showing and the late "history" switched threads
// (and a thread switch always scrolled to the bottom). Chromium's scroll anchoring also masks the bug
// whenever the view starts scrolled down; it does not apply at scrollTop 0, which is the owner's case.
await page.evaluate(async (huddle) => {
  const { useHuddleStore } = await import("/src/features/huddle/store.ts");
  useHuddleStore.setState((s) => ({
    activeHuddleId: huddle,
    messages: s.messages.filter((m) => m.huddleId !== huddle),
  }));
}, HUDDLE);
await page.waitForTimeout(400);
const before = await page.evaluate(
  async ({ huddle, sel }) => {
    const { useHuddleStore } = await import("/src/features/huddle/store.ts");
    const el = document.querySelector(sel);
    return {
      active: useHuddleStore.getState().activeHuddleId === huddle,
      top: el.scrollTop,
      scrollable: el.scrollHeight > el.clientHeight,
    };
  },
  { huddle: HUDDLE, sel: SEL },
);
const validStart = before.active && before.top === 0 && !before.scrollable;
report(
  validStart,
  "precondition: deep-linked 1:1 is open, empty, at the top",
  JSON.stringify(before),
);
if (!validStart) {
  await browser.close();
  console.log("\nprecondition failed -- the run below would not model the deep link");
  process.exit(1);
}

// Deliver the history late, through the same entry point the workspace download uses.
await page.waitForTimeout(800);
await page.evaluate(
  async ({ huddle, total }) => {
    const store = await import("/src/features/huddle/store.ts");
    const t0 = Date.now() - total * 60_000;
    const messages = Array.from({ length: total }, (_, i) => ({
      id: `e2e-${i}`,
      huddleId: huddle,
      author: i % 2 ? { kind: "user" } : { kind: "agent", agentId: "sam-trent" },
      text: `Test-message ${i} — ` + "lorem ipsum dolor sit amet ".repeat(1 + (i % 4)),
      ts: t0 + i * 60_000,
    }));
    store.hydrateFromRemote({ activeHuddleId: huddle, messages, showDemoData: false });
  },
  { huddle: HUDDLE, total: TOTAL },
);
await page.waitForTimeout(1200);

const metrics = () =>
  page.$eval(SEL, (el) => ({
    top: Math.round(el.scrollTop),
    height: el.scrollHeight,
    client: el.clientHeight,
    rendered: el.querySelectorAll("*").length,
    text: el.innerText,
  }));

let m = await metrics();
const dist = m.height - m.top - m.client;
report(
  dist < 5,
  "lands on the newest message after a late history load",
  `distance from bottom=${dist}px`,
);
report(
  m.text.includes(`Test-message ${TOTAL - 1} `),
  "newest message is rendered (presence only; position is the check above)",
  `contains #${TOTAL - 1}`,
);
const renders = (n) => m.text.includes(`Test-message ${n} `);
report(!renders(0), "oldest history is NOT rendered up front", `message #0 rendered=${renders(0)}`);
await page.screenshot({ path: "/tmp/transcript-deeplink-landed.png" });

// Scroll to the top: an older page is revealed and the reader stays on the same message.
const firstBefore = await page.$eval(SEL, (el) => {
  const top = el.getBoundingClientRect().top;
  const row = [...el.querySelectorAll("*")].find(
    (n) => /^Test-message \d+ /.test(n.textContent || "") && n.children.length === 0,
  );
  return row ? { text: row.textContent.slice(0, 18) } : null;
});
await page.$eval(SEL, (el) => {
  el.scrollTop = 0;
});
await page.waitForTimeout(600);
m = await metrics();
const revealed = TOTAL - 40 - 40;
report(
  m.text.includes(`Test-message ${revealed} `),
  "scrolling to the top reveals the previous page",
  `contains #${revealed}`,
);
report(m.top > 200, "the view did not jump to the very top after prepending", `scrollTop=${m.top}`);
console.log(`   (first row before scroll-up: ${firstBefore?.text ?? "n/a"})`);

// While scrolled up, a new message arrives: the reader is NOT yanked to the bottom.
const topBefore = m.top;
await page.evaluate(
  async ({ huddle, total }) => {
    const { useHuddleStore } = await import("/src/features/huddle/store.ts");
    useHuddleStore.setState((s) => ({
      messages: [
        ...s.messages,
        {
          id: "e2e-new",
          huddleId: huddle,
          author: { kind: "agent", agentId: "sam-trent" },
          text: `Test-message ${total} new`,
          ts: Date.now(),
        },
      ],
    }));
  },
  { huddle: HUDDLE, total: TOTAL },
);
await page.waitForTimeout(500);
m = await metrics();
report(
  Math.abs(m.top - topBefore) < 5,
  "a new message does not yank a reader who scrolled up",
  `scrollTop ${topBefore} → ${m.top}`,
);

await browser.close();
console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
