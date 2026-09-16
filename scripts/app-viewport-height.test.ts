// WHAT:       Proves the app shell's height tracks the height the user can SEE, so the bottom nav
//             lands above the on-screen keyboard instead of behind it.
// WHY:        2026-09-13, the owner on his phone: "why isn't the bottom [dock] staying at the bottom
//             of my device instead of being able to be scrolled up?" — screenshot showed the nav bar
//             floated to ~45% of screen height, a blank strip beneath it, keyboard below that.
//             `h-dvh` follows the LAYOUT viewport, which the keyboard does not shrink; the keyboard
//             shrinks the VISUAL viewport. So the column stayed full height, the nav sat under the
//             keyboard, and the browser PANNED the window over it — that pan is the "scrolling".
//             `interactive-widget=resizes-content` (routes/__root.tsx:83) is the declarative fix and
//             was already set, but it is CHROME-ON-ANDROID ONLY. `visualViewport` is universal.
// SUPERSEDES: nothing
// SUPERSEDED-BY: nothing -- current
// EVIDENCE:   the owner's screenshot; zero `visualViewport` references existed in src/ before this.
//
// Run:  bun scripts/app-viewport-height.test.ts   (npm run test:viewport-height)
//
// WHAT THIS CANNOT PROVE — stated up front, because the repo has shipped false PASSes before:
// a sandbox cannot open a soft keyboard. These assertions prove the MECHANISM given a viewport that
// reports a shrunken height; they do NOT prove the owner's phone behaves that way. Status stays
// MECHANISM ONLY until he looks at it.

import {
  attachAppViewportHeight,
  lockDocumentScroll,
  visibleHeightPx,
  APP_LOCK_CLASS,
} from "../src/features/huddle/hooks/useAppViewportHeight";

let pass = 0,
  fail = 0;
function check(label: string, cond: boolean, detail: string) {
  console.log(`  ${cond ? "PASS" : "FAIL"} ${label} — ${detail}`);
  cond ? pass++ : fail++;
}

/** A fake visual viewport + root, so the contract is testable with no DOM at all. */
function harness(vvInit: { height: number; offsetTop: number } | null) {
  const props: Record<string, string> = {};
  const listeners: Record<string, number> = {};
  const winListeners: Record<string, number> = {};
  const fns: Record<string, (() => void)[]> = {};

  const vv = vvInit && {
    ...vvInit,
    addEventListener(t: string, fn: () => void) {
      listeners[t] = (listeners[t] ?? 0) + 1;
      (fns[t] ??= []).push(fn);
    },
    removeEventListener(t: string) {
      listeners[t] = (listeners[t] ?? 0) - 1;
    },
  };
  const win = {
    visualViewport: vv ?? null,
    addEventListener(t: string, fn: () => void) {
      winListeners[t] = (winListeners[t] ?? 0) + 1;
      (fns[t] ??= []).push(fn);
    },
    removeEventListener(t: string) {
      winListeners[t] = (winListeners[t] ?? 0) - 1;
    },
  };
  const root = {
    style: {
      setProperty: (k: string, v: string) => {
        props[k] = v;
      },
      removeProperty: (k: string) => {
        delete props[k];
      },
    },
  };
  const fire = (t: string) => (fns[t] ?? []).forEach((f) => f());
  return { win, vv, root, props, listeners, winListeners, fire };
}

// ── THE DEFECT ITSELF: keyboard open, visible height shrinks, the shell must shrink with it ──────
{
  const h = harness({ height: 844, offsetTop: 0 });
  const teardown = attachAppViewportHeight(h.win as any, h.root as any);
  check(
    "with the keyboard CLOSED the shell is the full visible height",
    h.props["--app-h"] === "844px",
    `--app-h = ${h.props["--app-h"]}`,
  );

  // Keyboard opens: the visual viewport shrinks. The LAYOUT viewport (what h-dvh reads) would not.
  h.vv!.height = 450;
  h.fire("resize");
  check(
    "when the keyboard OPENS the shell follows the VISIBLE height, not the layout viewport",
    h.props["--app-h"] === "450px",
    `--app-h = ${h.props["--app-h"]} — h-dvh alone would still read 844px and bury the nav`,
  );

  // The browser pans the visible region down the taller layout viewport — the screenshot's state.
  h.vv!.offsetTop = 120;
  h.fire("scroll");
  check(
    "mid-PAN the shell stays anchored — offsetTop is subtracted, not ignored",
    h.props["--app-h"] === "330px",
    `--app-h = ${h.props["--app-h"]} (450 - 120); ignoring offsetTop leaves the bar drifting`,
  );

  teardown?.();
  check(
    "teardown hands the layout back to the CSS fallback rather than pinning a stale height",
    h.props["--app-h"] === undefined,
    `--app-h after teardown = ${String(h.props["--app-h"])}`,
  );
  check(
    "every listener added is removed — no leak across remounts",
    h.listeners["resize"] === 0 && h.listeners["scroll"] === 0 && h.winListeners["orientationchange"] === 0,
    `resize=${h.listeners["resize"]} scroll=${h.listeners["scroll"]} orientationchange=${h.winListeners["orientationchange"]}`,
  );
}

// ── DEGRADING IS THE DESIGN: no visualViewport must leave 100dvh untouched, never set a guess ────
{
  const h = harness(null);
  const teardown = attachAppViewportHeight(h.win as any, h.root as any);
  check(
    "a browser with NO visualViewport sets nothing — the 100dvh fallback stands unchanged",
    teardown === null && h.props["--app-h"] === undefined,
    `teardown=${String(teardown)}, --app-h=${String(h.props["--app-h"])} — setting a guess here would REGRESS working browsers`,
  );
}
{
  const teardown = attachAppViewportHeight(undefined, harness(null).root as any);
  check(
    "no window at all (SSR) is a no-op, not a crash",
    teardown === null,
    `teardown=${String(teardown)}`,
  );
}

// ── A negative can never reach CSS as `height: -Npx` ─────────────────────────────────────────────
check(
  "a pan deeper than the viewport clamps to 0 instead of emitting a negative height",
  visibleHeightPx({ height: 100, offsetTop: 400 }) === 0,
  `-> ${visibleHeightPx({ height: 100, offsetTop: 400 })}px`,
);
check(
  "fractional viewport heights are rounded, never handed to CSS as a long float",
  visibleHeightPx({ height: 843.6667, offsetTop: 0 }) === 844,
  `-> ${visibleHeightPx({ height: 843.6667, offsetTop: 0 })}px`,
);

// ── THE SECOND DEFECT: the DOCUMENT must not pan. Owner, after the height fix shipped: "if I swipe
//    up on the button row at the bottom the entire app slides up leaving white space still."
//    The bottom nav is the only region that is not its own scroll container, so a drag there chains
//    to the document — and html/body carried no height, no overflow and no overscroll-behavior.
{
  const classes = (): { el: { classList: { add: (c: string) => void; remove: (c: string) => void } }; has: () => boolean } => {
    const s = new Set<string>();
    return {
      el: { classList: { add: (c: string) => s.add(c), remove: (c: string) => s.delete(c) } },
      has: () => s.has(APP_LOCK_CLASS),
    };
  };
  const root = classes();
  const body = classes();
  const unlock = lockDocumentScroll(root.el, body.el);
  check(
    "the lock is applied to BOTH html and body — one alone still lets the document pan",
    root.has() && body.has(),
    `html=${root.has()} body=${body.has()}`,
  );
  unlock();
  check(
    "unlocking removes it from BOTH — a stranded lock leaves /auth and the error routes unscrollable",
    !root.has() && !body.has(),
    `html=${root.has()} body=${body.has()}`,
  );
}
{
  // SSR / a missing body must not throw, and must still hand back a callable unlock.
  let threw = false;
  let unlock: (() => void) | null = null;
  try {
    unlock = lockDocumentScroll(undefined, undefined);
    unlock();
  } catch {
    threw = true;
  }
  check(
    "no document (SSR) is a no-op that still returns a usable unlock, never a crash",
    !threw && typeof unlock === "function",
    `threw=${threw}, unlock=${typeof unlock}`,
  );
}

console.log(`\n==================== ${pass} passed, ${fail} failed ====================`);
process.exit(fail === 0 ? 0 : 1);
