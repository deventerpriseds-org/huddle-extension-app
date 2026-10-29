// WHAT:       Builds the "Open in journey" deep link for a board card: journey's public app URL + the
//             route that opens ONE task (`/tasks?task=<uuid>`).
// WHY:        Owner, 2026-10-29: "I can't click to go to the task in journey" -> "Add the deep links".
//             Huddle had no knowledge of journey's APP URL at all (only the server-side Supabase
//             JOURNEY_PROXY_URL), so this is the one place it lives.
// SUPERSEDES: nothing
// SUPERSEDED-BY: nothing -- current
// EVIDENCE:   docs/qc-evidence/FIX-board-journey-deeplink.md; scripts/board-journey-link.test.ts.

/**
 * journey's published host, READ from journey-voice `public/bridge.config.json:4` (`baseUrl`) — the
 * same value journey's own digest deep links default to (`_shared/digest-content.ts`
 * `APP_BASE_URL_DEFAULT`). Not a secret: it is the public URL of a web app.
 */
export const JOURNEY_APP_URL_DEFAULT = "https://journey-voice.lovable.app";

/** Build-time override. Unset -> the default above; set to an empty string -> links switched OFF. */
export const JOURNEY_APP_URL_ENV = "VITE_JOURNEY_APP_URL";

/** The base URL the card links use, or "" when explicitly switched off. */
export function journeyAppBaseUrl(): string {
  const env = (import.meta as { env?: Record<string, string | undefined> }).env;
  const override = env?.[JOURNEY_APP_URL_ENV];
  return override === undefined ? JOURNEY_APP_URL_DEFAULT : override.trim();
}

/**
 * The URL that opens `taskId` in journey, or `null` when there is nothing valid to link to (no base,
 * a non-http base, or no id). journey's TasksPage (`src/pages/TasksPage.tsx`) reads `?task=`, opens
 * that task's detail modal, then strips the param. `view=kanban` is explicit so TasksPage's
 * default-view redirect has nothing to rewrite.
 */
export function buildJourneyTaskUrl(baseUrl: string | null | undefined, taskId: string | null | undefined): string | null {
  const base = (baseUrl ?? "").trim().replace(/\/+$/, "");
  const id = (taskId ?? "").trim();
  if (!base || !id || !/^https?:\/\/[^/\s]+/i.test(base)) return null;
  return `${base}/tasks?view=kanban&task=${encodeURIComponent(id)}`;
}
