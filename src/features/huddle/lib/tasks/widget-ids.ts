// WHAT:       The two tree-node id constants, in a module with NO server imports, so the client widget
//             (JourneyWidgets.tsx) can read them without bundling widgets.server.ts.
// WHY:        The ⋮ menu must tell a category row from a topic row, and must not offer Push on the
//             Uncategorised bucket. widgets.server.ts re-exports both, so there is still one definition.
// SUPERSEDES: the literal definitions that lived in widgets.server.ts.
// SUPERSEDED-BY: nothing -- current.

/** Synthetic category roots are ids, not topics — prefixed so they can never collide with a
 *  journey topic uuid, and so a click handler can tell them apart. */
export const CATEGORY_ROOT_PREFIX = "category:";

/** Bucket for a live task whose `category` is null/blank. Not a journey value — a Huddle-side
 *  holding row, so an unmapped task is visible instead of silently absent. */
export const UNCATEGORISED_CATEGORY = "UNCATEGORISED";
