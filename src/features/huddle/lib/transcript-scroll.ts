// WHAT:       The chat transcript's scroll rules — where a thread opens, when it follows new messages,
//             and how older history is revealed on scroll-up without the view jumping.
// WHY:        2026-10-27, the owner: tapping a 1:1 heads-up deep-linked into the thread but landed at
//             the TOP of history, then loaded, and stayed at the top. Cause (HuddleView Transcript):
//             the "open at newest" scroll ran once on the thread switch, BEFORE the workspace history
//             arrived; when the whole history then rendered at once, the "follow new messages" rule
//             measured near-bottom AFTER the list had grown, saw thousands of px of distance, and
//             declined to move. The follow decision must come from the user's own last scroll, not
//             from a measurement taken after content grew under them.
//             It also rendered every message in the thread; best practice (and this module) is to
//             render the newest window and reveal older pages as the reader scrolls up.
// SUPERSEDES: the inline nearBottom-after-update check in HuddleView's Transcript.
// SUPERSEDED-BY: nothing -- current
// EVIDENCE:   scripts/transcript-scroll.test.ts replays the deep-link sequence against a fake container.
//
// Framework-free on purpose so the sequence is testable with no DOM (same shape as useAppViewportHeight).

/** Messages rendered when a thread opens. */
export const TRANSCRIPT_WINDOW = 40;
/** Messages revealed per scroll-up. */
export const TRANSCRIPT_PAGE = 40;
/** Within this distance of the bottom, the reader counts as "following" the conversation. */
export const NEAR_BOTTOM_PX = 200;
/** Within this distance of the top, the next older page is revealed. */
export const LOAD_OLDER_PX = 150;

export type ScrollMetrics = { scrollTop: number; scrollHeight: number; clientHeight: number };

export function isNearBottom(m: ScrollMetrics, px = NEAR_BOTTOM_PX): boolean {
  return m.scrollHeight - m.scrollTop - m.clientHeight < px;
}

/**
 * Index of the first rendered message. `pinnedStart === null` means "follow the newest window": the
 * start slides forward as messages arrive. Once the reader reveals older history the start is pinned,
 * so a message arriving at the bottom never removes one from the top under their eyes.
 */
export function windowStart(
  total: number,
  pinnedStart: number | null,
  size = TRANSCRIPT_WINDOW,
): number {
  if (pinnedStart === null) return Math.max(0, total - size);
  return Math.min(Math.max(0, pinnedStart), total);
}

export function olderStart(start: number, page = TRANSCRIPT_PAGE): number {
  return Math.max(0, start - page);
}

/** Reveal older history when the reader is near the top, or when the window does not fill the view
 *  (no scrollbar means no scroll event could ever ask for more). */
export function shouldRevealOlder(m: ScrollMetrics, start: number, px = LOAD_OLDER_PX): boolean {
  if (start <= 0) return false;
  return m.scrollTop < px || m.scrollHeight <= m.clientHeight;
}

/** scrollTop that keeps the same message under the reader after rows were prepended above it. */
export function anchoredScrollTop(before: ScrollMetrics, scrollHeightAfter: number): number {
  return before.scrollTop + (scrollHeightAfter - before.scrollHeight);
}

/**
 * Whether the transcript should stay pinned to the newest message. Decided by the reader's own
 * scrolls — NOT re-measured after content changes, because a bulk history load grows the list under
 * an untouched view and a post-growth measurement reads that as "the reader scrolled up".
 */
export function createFollowState() {
  let following = true;
  return {
    /** A thread was opened: land on the newest message. */
    open() {
      following = true;
    },
    /** The reader scrolled (or a programmatic scroll settled): record whether they are following. */
    onScroll(m: ScrollMetrics) {
      following = isNearBottom(m);
    },
    /** After the message list changed: pin to the newest? A turn the user just started always pins. */
    shouldPin(isPending: boolean): boolean {
      if (isPending) following = true;
      return following;
    },
    get following() {
      return following;
    },
  };
}
