// WHAT:       Proves a thread opened by a push deep link lands on the NEWEST message even though its
//             history arrives after the thread is on screen, and that older history is revealed on
//             scroll-up without moving the message under the reader.
// WHY:        2026-10-27, the owner: tapping a 1:1 heads-up deep-linked into the thread but showed the
//             TOP of history, loaded, and stayed at the top until scrolled by hand. The old Transcript
//             measured "near bottom" AFTER the bulk history render had grown the list, so it read an
//             untouched view as "reader scrolled up" and declined to pin.
// SUPERSEDES: nothing
// SUPERSEDED-BY: nothing -- current
// EVIDENCE:   src/features/huddle/lib/transcript-scroll.ts header; the pre-fix rule is replayed below
//             (case A2) and lands at the top, which is the reported behaviour.
//
// Run:  bun scripts/transcript-scroll.test.ts   (npm run test:transcript-scroll)
//
// WHAT THIS CANNOT PROVE: real layout. A fake container stands in for the browser's scroll box, so
// this proves the RULES; whether the owner's phone lands at the bottom stays MECHANISM ONLY until he
// taps a heads-up and sees it.

import {
  TRANSCRIPT_PAGE,
  TRANSCRIPT_WINDOW,
  anchoredScrollTop,
  pinnedStartOnScroll,
  createFollowState,
  isNearBottom,
  olderStart,
  shouldRevealOlder,
  windowStart,
  type ScrollMetrics,
} from "../src/features/huddle/lib/transcript-scroll";

let pass = 0,
  fail = 0;
function check(label: string, cond: boolean, detail: string) {
  console.log(`  ${cond ? "PASS" : "FAIL"} ${label} — ${detail}`);
  if (cond) pass++;
  else fail++;
}

const ROW = 90; // px per rendered message
const VIEW = 600; // visible height of the transcript

/** A scroll box holding `rows` rendered messages, scrolled to `scrollTop` (clamped like a browser). */
function box(rows: number, scrollTop: number): ScrollMetrics {
  const scrollHeight = Math.max(VIEW, rows * ROW);
  return {
    scrollHeight,
    clientHeight: VIEW,
    scrollTop: Math.min(Math.max(0, scrollTop), scrollHeight - VIEW),
  };
}
const bottomOf = (rows: number) => box(rows, Number.MAX_SAFE_INTEGER);

console.log("A. push deep link: thread opens empty, history lands afterwards");
{
  const follow = createFollowState();
  follow.open();
  // Thread on screen before the workspace download finishes: nothing rendered, nothing scrolled.
  let el = box(0, 0);
  check("A0 pins on open", follow.shouldPin(false), "empty thread, no scroll yet");
  // History arrives in one go. No scroll event fires (content grew, the reader did nothing).
  const total = 300;
  const rendered = total - windowStart(total, null);
  el = box(rendered, el.scrollTop);
  check(
    "A1 still pins after the bulk history load",
    follow.shouldPin(false),
    `scrollTop=${el.scrollTop}, scrollHeight=${el.scrollHeight}`,
  );
  // The pre-fix rule measured AFTER the growth. Replaying it reproduces the owner's report.
  check(
    "A2 the old post-update measurement would NOT have pinned",
    !isNearBottom(el),
    `distance=${el.scrollHeight - el.scrollTop - el.clientHeight}px`,
  );
  // The heads-up's own reply is back-filled a beat later: still pinned.
  check(
    "A3 back-filled reply after load still pins",
    follow.shouldPin(false),
    "no reader scroll in between",
  );
}

console.log("B. reader scrolled up into history");
{
  const follow = createFollowState();
  follow.open();
  follow.onScroll(box(TRANSCRIPT_WINDOW, 400)); // well above the bottom
  check("B1 a new message does not yank them down", !follow.shouldPin(false), "following=false");
  check("B2 sending a message does pin", follow.shouldPin(true), "isPending=true");
  follow.onScroll(box(TRANSCRIPT_WINDOW, 400));
  follow.onScroll(bottomOf(TRANSCRIPT_WINDOW));
  check(
    "B3 scrolling back to the bottom resumes following",
    follow.shouldPin(false),
    "near bottom again",
  );
  follow.onScroll(box(TRANSCRIPT_WINDOW, 0));
  follow.open();
  check(
    "B4 re-opening the thread lands at the bottom again",
    follow.shouldPin(false),
    "open() resets",
  );
}

console.log("C. windowing: render the newest page, reveal older on scroll-up");
{
  check(
    "C1 opens on the newest window",
    windowStart(300, null) === 300 - TRANSCRIPT_WINDOW,
    `start=${windowStart(300, null)}`,
  );
  check(
    "C2 short thread renders whole",
    windowStart(12, null) === 0,
    `start=${windowStart(12, null)}`,
  );
  check(
    "C3 following window slides as messages arrive",
    windowStart(301, null) === 301 - TRANSCRIPT_WINDOW,
    `start=${windowStart(301, null)}`,
  );
  check(
    "C4 a pinned start does not move when a message arrives",
    windowStart(301, 220) === 220,
    `start=${windowStart(301, 220)}`,
  );
  check(
    "C5 a pinned start clamps if the list shrinks",
    windowStart(100, 220) === 100,
    `start=${windowStart(100, 220)}`,
  );
  check(
    "C6 older page steps back one page",
    olderStart(260) === 260 - TRANSCRIPT_PAGE,
    `start=${olderStart(260)}`,
  );
  check(
    "C7 older page floors at the first message",
    olderStart(15) === 0,
    `start=${olderStart(15)}`,
  );
}

console.log("D. revealing older history");
{
  check(
    "D1 near the top with more history reveals",
    shouldRevealOlder(box(40, 50), 260),
    "scrollTop=50",
  );
  check("D2 mid-thread does not reveal", !shouldRevealOlder(box(40, 1500), 260), "scrollTop=1500");
  check("D3 nothing older means nothing to reveal", !shouldRevealOlder(box(40, 0), 0), "start=0");
  check(
    "D4 a window that does not fill the view reveals (no scrollbar to ask)",
    shouldRevealOlder(box(3, 0), 10),
    "scrollHeight<=clientHeight",
  );
  // The anchor row sat 20px below the viewport top; 40 rows were prepended above it, so it moved down
  // by 40*ROW. Keeping it at 20px means scrolling down by exactly that much.
  const prepended = 40 * ROW;
  const top = anchoredScrollTop(50, 20, 20 + prepended);
  check(
    "D5 prepending keeps the same message under the reader",
    top === 50 + prepended,
    `scrollTop 50 → ${top} after ${prepended}px prepended`,
  );
  // Same render ALSO appends a new message at the bottom. The anchor row's own position is unchanged by
  // that, so the result must be too. The old height-delta formula added the new row's height here.
  const topWithNewRow = anchoredScrollTop(50, 20, 20 + prepended);
  const oldFormula = 50 + (prepended + ROW);
  check(
    "D6 a new message arriving in the same render does not shift the reader",
    topWithNewRow === 50 + prepended && topWithNewRow !== oldFormula,
    `scrollTop ${topWithNewRow} (height-delta anchoring would give ${oldFormula})`,
  );
  check(
    "D7 browser already held the row: no extra scroll",
    anchoredScrollTop(3650, 20, 20) === 3650,
    "delta 0",
  );
}

console.log("E. scrolling up freezes the window");
{
  check(
    "E1 following keeps the sliding window",
    pinnedStartOnScroll(true, null, 260) === null,
    "null",
  );
  check(
    "E2 scrolling up pins the current start",
    pinnedStartOnScroll(false, null, 260) === 260,
    "260",
  );
  check("E3 an existing pin is kept", pinnedStartOnScroll(false, 220, 260) === 220, "220");
  check("E4 a short thread pins at 0 too", pinnedStartOnScroll(false, null, 0) === 0, "0");
  check(
    "E5 once pinned, a new message does not drop the top row",
    windowStart(301, pinnedStartOnScroll(false, null, windowStart(300, null))) === 260,
    `start stays ${windowStart(301, 260)}`,
  );
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
