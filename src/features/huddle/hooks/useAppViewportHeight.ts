// WHAT:       Keeps the CSS variable `--app-h` equal to the height the user can ACTUALLY SEE, so the
//             app shell ends exactly where the on-screen keyboard begins instead of behind it.
// WHY:        2026-09-13, the owner on his phone: the bottom nav bar did not stay at the bottom of
//             the device and could be "scrolled up", floating above a blank strip with the keyboard
//             below it. `h-dvh` tracks the LAYOUT viewport — it shrinks when the browser's URL bar
//             retracts, but NOT for the keyboard, which shrinks only the VISUAL viewport. So the
//             column stayed full height, its last child (the nav) sat under the keyboard, and the
//             browser panned the visual viewport over the taller layout viewport. That pan is what
//             reads as scrolling; the document itself never scrolled.
// SUPERSEDES: nothing. It LAYERS OVER `interactive-widget=resizes-content` (routes/__root.tsx:83),
//             which is the right declaration and is already set — but it is CHROME-ON-ANDROID ONLY.
//             Firefox, Samsung Internet and most WebViews ignore it, so on those the layout was
//             always going to break. `window.visualViewport` is the one mechanism every modern
//             browser implements, which is why the fix lives here rather than in more meta tags.
// SUPERSEDED-BY: nothing -- current
// EVIDENCE:   the owner's screenshot (nav at ~45% of screen height, blank strip beneath it, keyboard
//             below that) and the absence of ANY `visualViewport` reference in `src/` before this file.
//
// NOT USER-CONFIRMED. This is a perceptual, device-specific behaviour: a sandbox cannot open a soft
// keyboard, so nothing here proves the owner's phone is fixed. Status stays MECHANISM ONLY until he
// says it stays put. See the repo rule on perceptual UAT.

import { useEffect } from "react";

/** The part of the visual viewport the user can actually see right now.
 *
 *  `height` is the visible region. `offsetTop` is how far the browser has ALREADY PANNED that region
 *  down the layout viewport — subtracting it keeps the shell anchored mid-pan, which is precisely the
 *  state in the owner's screenshot (nav floated up, blank strip beneath, keyboard below that).
 *  Clamped at 0 so a transient negative can never produce a `height: -Npx` shell. */
export function visibleHeightPx(vv: { height: number; offsetTop: number }): number {
  return Math.round(Math.max(0, vv.height - vv.offsetTop));
}

/** Minimal shapes, so this is testable without a DOM and honest about what it actually touches. */
type ViewportLike = {
  height: number;
  offsetTop: number;
  addEventListener: (t: string, fn: () => void) => void;
  removeEventListener: (t: string, fn: () => void) => void;
};
type WindowLike = {
  visualViewport?: ViewportLike | null;
  addEventListener: (t: string, fn: () => void) => void;
  removeEventListener: (t: string, fn: () => void) => void;
};
type RootLike = {
  style: { setProperty: (k: string, v: string) => void; removeProperty: (k: string) => void };
};
type LockableLike = { classList: { add: (c: string) => void; remove: (c: string) => void } };

/** The class that stops the DOCUMENT panning — see `@utility app-locked` in styles.css. */
export const APP_LOCK_CLASS = "app-locked";

/**
 * Lock `<html>` and `<body>` so the document cannot be panned, and return the unlock.
 *
 * SEPARATE FROM THE HEIGHT, AND BOTH ARE NEEDED. Sizing the shell to the visible height stops the
 * nav being pushed BELOW the fold; this stops the whole app being DRAGGED up. The owner hit the
 * second one after the first was fixed: *"if I swipe up on the button row at the bottom the entire
 * app slides up leaving white space still."* The bottom nav is the only region that is not its own
 * scroll container, so a drag there chains to the document.
 *
 * Scoped to the app shell's lifetime ON PURPOSE: `/auth` and the error routes use `min-h-screen`
 * and need ordinary page scrolling. A global rule in the stylesheet would break them.
 */
export function lockDocumentScroll(root: LockableLike | undefined, body: LockableLike | undefined): () => void {
  root?.classList.add(APP_LOCK_CLASS);
  body?.classList.add(APP_LOCK_CLASS);
  return () => {
    root?.classList.remove(APP_LOCK_CLASS);
    body?.classList.remove(APP_LOCK_CLASS);
  };
}

/**
 * Subscribe `root`'s `--app-h` to `win`'s visual viewport. Returns a teardown, or **null when there
 * is nothing to subscribe to** — no window, or a browser with no `visualViewport`.
 *
 * DEGRADING IS THE DESIGN, NOT AN OVERSIGHT: the consumer reads `var(--app-h, 100dvh)`, so when this
 * returns null the app keeps exactly today's `100dvh` behaviour. The variable is only ever set to a
 * REAL MEASURED number — never to a guess — so this change can only be neutral or better, never worse.
 */
export function attachAppViewportHeight(win: WindowLike | undefined, root: RootLike): (() => void) | null {
  const vv = win?.visualViewport;
  if (!win || !vv) return null;

  const apply = () => root.style.setProperty("--app-h", `${visibleHeightPx(vv)}px`);

  apply();
  vv.addEventListener("resize", apply);
  vv.addEventListener("scroll", apply);
  // Rotation can resize the window without firing a visualViewport resize first.
  win.addEventListener("orientationchange", apply);

  return () => {
    vv.removeEventListener("resize", apply);
    vv.removeEventListener("scroll", apply);
    win.removeEventListener("orientationchange", apply);
    // Hand the layout back to the CSS fallback rather than leaving a stale pixel height pinned — a
    // frozen `--app-h` after unmount would be worse than never having set it.
    root.style.removeProperty("--app-h");
  };
}

/**
 * For as long as the app shell is mounted: publish `--app-h` (so the shell ends where the keyboard
 * begins) AND lock the document (so the shell cannot be dragged around). Two distinct defects, both
 * owner-reported, both required — see each function's own note.
 */
export function useAppViewportHeight(): void {
  useEffect(() => {
    if (typeof window === "undefined") return;
    const unlock = lockDocumentScroll(
      document.documentElement as unknown as LockableLike,
      document.body as unknown as LockableLike,
    );
    const detach = attachAppViewportHeight(
      window as unknown as WindowLike,
      document.documentElement as unknown as RootLike,
    );
    return () => {
      detach?.();
      // Unlock LAST and ALWAYS — even if the height subscription never attached. Leaving the
      // document fixed after unmount would strand `/auth` and the error routes unscrollable.
      unlock();
    };
  }, []);
}
