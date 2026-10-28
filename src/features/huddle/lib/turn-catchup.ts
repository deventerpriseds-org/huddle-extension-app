// WHAT:       Where the app-global turn back-fill starts after a fresh load.
// WHY:        2026-10-28. Workspace saves were rejected for 10 days (2,003,215 chars against a 2,000,000
//             cap), so new messages lived only in the running app's memory. An APK update restarted the
//             app; the reload got the saved workspace (newest message 2026-10-15) and the back-fill
//             resumed from this device's cursor (recent), so 147 Iris turns in between were never
//             fetched again. Start no later than the newest message the hydrated workspace holds.
// SUPERSEDES: nothing
// SUPERSEDED-BY: nothing -- current
// EVIDENCE:   identity.workspace_state + chat.pending_turns queries, .claude/actions.md ACT:deeplink-opens-at-top

type CatchUpMessage = { id: string; ts?: number; demo?: boolean };

/** Newest timestamp among messages that prove history was saved up to that point. */
export function newestSavedTs(messages: readonly CatchUpMessage[]): number {
  let newest = 0;
  for (const m of messages) {
    // Reminder rows carry their own fire time and demo rows are seeded; neither proves anything.
    if (m.demo || m.id.startsWith("rem-")) continue;
    if (typeof m.ts === "number" && m.ts > newest) newest = m.ts;
  }
  return newest;
}

/** The cursor to resume the back-fill from: never later than the newest saved message. */
export function catchUpCursor(cursor: number, messages: readonly CatchUpMessage[]): number {
  const newest = newestSavedTs(messages);
  return newest > 0 ? Math.min(cursor, newest) : cursor;
}
