// WHAT:       The Fireflies -> Huddle pipeline. handleFirefliesWebhook verifies a signed Webhooks V2
//             delivery and only QUEUES it (one DB write, answers in ~1s). processDueFirefliesMeetings --
//             run by the existing once-a-minute run-turn heartbeat -- then, per meeting under a lease,
//             INDEPENDENTLY (a) emails meeting minutes in the owner's chosen mode (Fireflies summary |
//             Luna from transcript) and (b) upserts the transcript Markdown into OneDrive
//             /Automation/transcripts. Neither waits on, or fails because of, the other.
// WHY:        Owner handoff 2026-11-10 (Fireflies Webhook to Huddle Meeting Minutes), extending draft PR
//             #188, which saved transcripts to OneDrive but sent no minutes and was not retry-safe.
// SUPERSEDES: PR #188's handleFirefliesWebhook (OneDrive-only, throws on any failure).
// SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   scripts/fireflies-minutes.test.ts; docs/qc-evidence/VERIFY-fireflies-minutes-1.md (why the
//             work moved out of the request); Fireflies docs read 2026-11-10 (fireflies-docs-read.yml run
//             42816565367): "respond with a 2xx within 30 seconds ... not retried" and meeting.summarized.
//
// Never logs or stores transcript text, summary text, API keys or Graph response bodies -- only ids,
// statuses and short error codes.
import { emailFromOptions, getAppToken, graphEmailConfigured } from "../email/graph-email.server";
import {
  firefliesSummaryMarkdown,
  markdownToEmailHtml,
  meetingDateLabel,
  meetingDateMs,
  meetingInputHash,
  minutesSubject,
  minutesUserPrompt,
  stamp,
  missingTemplateSections,
  MINUTES_INSTRUCTIONS,
  parseMinutesSource,
  parseRecipients,
  planEmail,
  retryDelaySec,
  safeMeetingId,
  SUMMARY_WAIT_MS,
  TRANSCRIPT_WAIT_MS,
  STANDARD_SUMMARY_NOTICE,
  transcriptForModel,
  verifyFirefliesSignature,
  type FfTranscript,
  type MinutesSource,
} from "./minutes";

const FIREFLIES_GRAPHQL = "https://api.fireflies.ai/graphql";
const GRAPH = "https://graph.microsoft.com/v1.0";
const MAX_TRANSCRIPT_BYTES = 10 * 1024 * 1024;
const TRANSCRIPT_FOLDER = "Automation/transcripts";

type FirefliesWebhook = {
  event?: unknown;
  meeting_id?: unknown;
  reprocessed_at?: unknown;
};

/** The two Webhooks V2 events this pipeline acts on (docs: meeting.transcribed = transcript ready;
 *  meeting.summarized = summary generated, which Fireflies-summary mode needs). */
export const HANDLED_EVENTS = ["meeting.transcribed", "meeting.summarized"] as const;

type FirefliesTranscript = {
  id?: string;
  title?: string;
  date?: string;
  dateString?: string;
  duration?: number;
  organizer_email?: string;
  host_email?: string;
  participants?: string[];
  meeting_attendees?: Array<{ displayName?: string; name?: string; email?: string }>;
  transcript_url?: string;
  sentences?: Array<{
    speaker_name?: string;
    text?: string;
    start_time?: number | string;
    end_time?: number | string;
  }>;
  summary?: {
    overview?: unknown;
    action_items?: unknown;
    keywords?: unknown;
    topics_discussed?: unknown;
    short_summary?: unknown;
    outline?: unknown;
    shorthand_bullet?: unknown;
    extended_sections?: Array<{ title?: string | null; content?: string | null }> | null;
  };
};

function env(name: string): string {
  return String(process.env[name] ?? "").trim();
}

function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

function graphUserPath(mailbox: string): string {
  return "/users/" + encodeURIComponent(mailbox) + "/drive";
}

async function ensureDriveFolder(token: string, mailbox: string, path: string): Promise<void> {
  const encoded = encodePath(path);
  const lookup = await fetch(GRAPH + graphUserPath(mailbox) + "/root:/" + encoded, {
    headers: { Authorization: "Bearer " + token },
    signal: AbortSignal.timeout(10_000),
  });
  if (lookup.ok) return;
  if (lookup.status !== 404) throw new Error("onedrive_folder_lookup_" + lookup.status);

  const segments = path.split("/").filter(Boolean);
  if (!segments.length) return;
  const leaf = segments.pop()!;
  const parent = segments.join("/");
  if (parent) await ensureDriveFolder(token, mailbox, parent);

  const parentPath = parent
    ? "/root:/" + encodePath(parent) + ":/children"
    : "/root/children";
  const create = await fetch(GRAPH + graphUserPath(mailbox) + parentPath, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: leaf,
      folder: {},
      "@microsoft.graph.conflictBehavior": "fail",
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (create.ok || create.status === 409) return;
  throw new Error("onedrive_folder_create_" + create.status);
}

function textBlock(value: unknown): string {
  if (value == null || value === "") return "";
  if (typeof value === "string") return value.trim();
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function formatTranscript(transcript: FirefliesTranscript): string {
  const title = String(transcript.title ?? "Untitled meeting").trim() || "Untitled meeting";
  const attendees = (transcript.meeting_attendees ?? [])
    .map((person) => {
      const name = String(person.displayName ?? person.name ?? "").trim();
      const email = String(person.email ?? "").trim();
      return name && email ? name + " <" + email + ">" : name || email;
    })
    .filter(Boolean);
  const date = transcript.dateString ?? transcript.date ?? "";
  const lines = [
    "# " + title,
    "",
    date ? "- Meeting date: " + date : "",
    typeof transcript.duration === "number" ? "- Duration: " + transcript.duration + " seconds" : "",
    attendees.length ? "- Attendees: " + attendees.join(", ") : "",
    transcript.transcript_url ? "- Fireflies transcript: " + transcript.transcript_url : "",
    "",
  ].filter((line, index, all) => line !== "" || all[index - 1] !== "");

  const overview = textBlock(transcript.summary?.overview ?? transcript.summary?.short_summary);
  if (overview) lines.push("## Summary", "", overview, "");

  const actionItems = textBlock(transcript.summary?.action_items);
  if (actionItems) lines.push("## Action items", "", actionItems, "");

  const keywords = textBlock(transcript.summary?.keywords);
  if (keywords) lines.push("## Keywords", "", keywords, "");

  lines.push("## Transcript", "");
  for (const sentence of transcript.sentences ?? []) {
    const speaker = String(sentence.speaker_name ?? "Speaker").trim() || "Speaker";
    const at = stamp(sentence.start_time);
    const time = at ? "[" + at + "] " : "";
    const spoken = String(sentence.text ?? "").trim();
    if (spoken) lines.push(time + speaker + ": " + spoken);
  }
  return lines.join("\n").trimEnd() + "\n";
}

const TRANSCRIPT_FIELDS =
  "id title date dateString duration organizer_email host_email participants transcript_url " +
  "meeting_attendees { displayName name email } " +
  "sentences { speaker_name text start_time end_time } ";
const SUMMARY_BASE = "overview short_summary action_items keywords topics_discussed outline shorthand_bullet";

async function firefliesQuery(meetingId: string, summaryFields: string) {
  const apiKey = env("FIREFLIES_API_KEY");
  if (!apiKey) throw new Error("fireflies_api_key_not_configured");
  const query =
    "query Transcript($transcriptId: String!) { transcript(id: $transcriptId) { " +
    TRANSCRIPT_FIELDS +
    "summary { " +
    summaryFields +
    " } } }";
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 12_000);
  try {
    const response = await fetch(FIREFLIES_GRAPHQL, {
      method: "POST",
      headers: { Authorization: "Bearer " + apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables: { transcriptId: meetingId } }),
      signal: ctl.signal,
    });
    if (!response.ok) throw new Error("fireflies_api_http_" + response.status);
    return (await response.json()) as {
      data?: { transcript?: FirefliesTranscript | null };
      errors?: Array<{ message?: string }>;
    };
  } catch (e) {
    if ((e as { name?: string })?.name === "AbortError") throw new Error("fireflies_api_timeout");
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** Fetch transcript + summary. Asks for the custom-template output (summary.extended_sections) first;
 *  if the API rejects that field it re-asks without it, so a schema difference costs the CUSTOM sections
 *  only (the email then says the standard summary was used) -- never the whole meeting. */
async function fetchTranscript(meetingId: string): Promise<{ transcript: FirefliesTranscript; customFieldAvailable: boolean }> {
  let result = await firefliesQuery(meetingId, SUMMARY_BASE + " extended_sections { title content }");
  let customFieldAvailable = true;
  if (result.errors?.length && result.errors.some((e) => /extended_sections|SummarySection|Cannot query field/i.test(e.message ?? ""))) {
    customFieldAvailable = false;
    console.warn("[fireflies] summary.extended_sections not accepted by the API; using standard summary fields");
    result = await firefliesQuery(meetingId, SUMMARY_BASE);
  }
  if (!result.data?.transcript) {
    throw new Error(result.errors?.length ? "fireflies_transcript_unavailable" : "fireflies_transcript_not_found");
  }
  return { transcript: result.data.transcript, customFieldAvailable };
}

function onedriveMailbox(): string {
  return env("FIREFLIES_ONEDRIVE_MAILBOX") || emailFromOptions()[0] || "";
}

/** Whose settings + identity the minutes belong to. Huddle is single-owner; the OneDrive mailbox is the
 *  owner's EDS address, so it doubles as the settings key unless FIREFLIES_OWNER_EMAIL overrides it. */
export function minutesOwner(): string {
  return (env("FIREFLIES_OWNER_EMAIL") || onedriveMailbox()).toLowerCase();
}

async function saveTranscript(transcript: FirefliesTranscript, meetingId: string): Promise<string> {
  if (!graphEmailConfigured()) throw new Error("graph_not_configured");
  const mailbox = onedriveMailbox();
  if (!mailbox) throw new Error("onedrive_mailbox_not_configured");
  const id = safeMeetingId(meetingId);
  if (!id) throw new Error("invalid_meeting_id");

  const token = await getAppToken();
  await ensureDriveFolder(token, mailbox, TRANSCRIPT_FOLDER);

  const bytes = new TextEncoder().encode(formatTranscript(transcript));
  if (bytes.length > MAX_TRANSCRIPT_BYTES) throw new Error("transcript_too_large");

  // Stable meeting-id filename: a retry or a Fireflies resend overwrites the same file (Graph PUT by path).
  const path = TRANSCRIPT_FOLDER + "/fireflies-" + id + ".md";
  const response = await fetch(GRAPH + graphUserPath(mailbox) + "/root:/" + encodePath(path) + ":/content", {
    method: "PUT",
    headers: { Authorization: "Bearer " + token, "Content-Type": "text/markdown; charset=utf-8" },
    body: bytes,
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error("onedrive_upload_" + response.status);
  return "/" + path;
}

/** The default recipients: the owner's own linked addresses (identity.profile_emails) that Huddle's
 *  existing send gate will AUTO-send to (lib/email/self-send-gate.ts resolveTier). An address the gate
 *  would turn into a draft is left out of the default, so the default can never produce a refused send. */
async function ownerAddresses(owner: string): Promise<string[]> {
  try {
    const { sendableTiers } = await import("./recipient-check.server");
    const list = (await sendableTiers(owner)).filter((r) => r.sends).map((r) => r.address);
    return list.length ? list : [owner];
  } catch {
    return [owner];
  }
}

export interface MinutesSettings {
  source: MinutesSource;
  recipients: string[] | null; // null = invalid stored list (visible error, no send)
  updateEmails: boolean;
}

export async function loadMinutesSettings(owner: string): Promise<MinutesSettings> {
  const store = await import("./minutes-store.server");
  const row = await store.getMinutesSettings(owner);
  return {
    source: parseMinutesSource(row?.minutes_source),
    recipients: parseRecipients(row?.recipients ?? null, await ownerAddresses(owner)),
    updateEmails: row?.update_emails === true,
  };
}

type Generated =
  | { ok: true; markdown: string; kind: "custom" | "standard" | "luna" }
  /** `wait`: the data may still arrive (summary not generated yet / transcript not ready) -- try again
   *  later until the wait window ends. `transient`: a model/network failure worth retrying. */
  | { ok: false; error: string; transient?: boolean; wait?: boolean };

/** Produce minutes in EXACTLY the selected mode. No fallback between modes, ever. */
export async function generateMinutes(
  source: MinutesSource,
  t: FfTranscript,
  callModel: (instructions: string, input: string) => Promise<string> = callLuna,
): Promise<Generated> {
  if (source === "fireflies") {
    const r = firefliesSummaryMarkdown(t);
    if (!r.ok) return { ok: false, error: "fireflies_summary_missing", wait: true };
    return {
      ok: true,
      kind: r.source,
      markdown: r.source === "standard" ? `_${STANDARD_SUMMARY_NOTICE}_\n\n${r.markdown}` : r.markdown,
    };
  }
  const transcript = transcriptForModel(t);
  if (!transcript.trim()) return { ok: false, error: "transcript_missing", wait: true };
  let text: string;
  try {
    text = await callModel(
      MINUTES_INSTRUCTIONS,
      minutesUserPrompt(String(t.title ?? ""), meetingDateLabel(meetingDateMs(t)), transcript),
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: /abort/i.test(msg) ? "luna_timeout" : "luna_failed", transient: true };
  }
  const md = text.trim();
  if (!md) return { ok: false, error: "luna_empty", transient: true };
  const missing = missingTemplateSections(md);
  if (missing.length) return { ok: false, error: "luna_template_incomplete:" + missing.join("|"), transient: true };
  return { ok: true, kind: "luna", markdown: md };
}

/** The existing Huddle Luna path: callOpenAIResponses on the gpt-5.6-luna tier (model-policy LADDER). */
async function callLuna(instructions: string, input: string): Promise<string> {
  const { callOpenAIResponses } = await import("../openai-responses.server");
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 25_000); // fetch(<=12s) + Luna(<=25s) stays under the ~45s ceiling
  try {
    const r = await callOpenAIResponses({
      model: "gpt-5.6-luna",
      reasoningEffort: "low",
      instructions,
      transcript: [{ role: "user", content: input }],
      maxToolHops: 0,
      signal: ctl.signal,
    });
    if (ctl.signal.aborted) throw new Error("aborted");
    return r.text;
  } finally {
    clearTimeout(timer);
  }
}


/** A Graph send error reduced to a short code -- never Graph's own message text (it can echo request
 *  details). e.g. "Graph sendMail failed (403): ..." -> "graph_send_403". */
export function safeSendError(err: string | undefined, gateRefused?: boolean): string {
  if (gateRefused) return "email_refused_by_send_gate";
  const m = String(err ?? "").match(/\((\d{3})\)/);
  if (m) return "graph_send_" + m[1];
  if (/token/i.test(String(err ?? ""))) return "graph_token_failed";
  return "email_send_failed";
}

function errCode(e: unknown, fallback: string): string {
  const m = e instanceof Error ? e.message : "";
  return /^[a-z0-9_:|.-]{1,80}$/i.test(m) ? m : fallback;
}

export type EmailOutcome =
  | { status: "sent"; kind: string; update: boolean }
  | { status: "not_needed" }
  | { status: "waiting"; reason: string }
  | { status: "failed"; error: string; final: boolean };

async function emailBranch(
  row: { meeting_id: string; email_status: string | null; content_hash: string | null; created_at: string; queue_version: string },
  t: FfTranscript,
  owner: string,
  nowMs: number,
): Promise<EmailOutcome> {
  const store = await import("./minutes-store.server");
  const id = row.meeting_id;
  const v = String(row.queue_version);
  const settings = await loadMinutesSettings(owner); // read at processing time, every pass
  const hash = meetingInputHash(t);
  const plan = planEmail(row, hash, settings.updateEmails);
  if (plan === "not_needed") {
    await store.recordEmailNotNeeded(id, v);
    return { status: "not_needed" };
  }
  if (!settings.recipients?.length) {
    await store.recordEmailProblem(id, v, settings.source, "recipients_invalid", true);
    return { status: "failed", error: "recipients_invalid", final: true };
  }
  const gen = await generateMinutes(settings.source, t);
  if (!gen.ok) {
    const age = nowMs - (Date.parse(row.created_at) || nowMs);
    const window = gen.error === "transcript_missing" ? TRANSCRIPT_WAIT_MS : SUMMARY_WAIT_MS;
    if (gen.wait && age < window) {
      await store.recordEmailProblem(id, v, settings.source, "waiting:" + gen.error, false);
      return { status: "waiting", reason: gen.error };
    }
    const final = !gen.transient;
    await store.recordEmailProblem(id, v, settings.source, gen.error, final);
    return { status: "failed", error: gen.error, final };
  }
  const update = plan === "send_update";
  const dateLabel = meetingDateLabel(meetingDateMs(t));
  const heading = `# ${String(t.title ?? "Untitled meeting").trim() || "Untitled meeting"}${dateLabel ? `\n\n${dateLabel}` : ""}`;
  const sourceLine =
    gen.kind === "luna"
      ? "_Minutes written by Luna from the full Fireflies transcript._"
      : gen.kind === "custom"
        ? "_Minutes from your Fireflies custom summary._"
        : "_Minutes from the Fireflies summary._";
  const { sendGraphEmail } = await import("../email/graph-email.server");
  const sent = await sendGraphEmail({
    to: settings.recipients,
    subject: minutesSubject(t.title, dateLabel, update),
    body: markdownToEmailHtml(`${heading}\n\n${sourceLine}\n\n${gen.markdown}`),
    html: true,
    callerEmail: owner,
  });
  if (sent.ok) {
    await store.recordEmailSent(id, v, { source: settings.source, kind: gen.kind, hash, recipients: settings.recipients });
    return { status: "sent", kind: gen.kind, update };
  }
  const error = safeSendError(sent.error, sent.gateRefused);
  const final = !!sent.gateRefused; // the gate will refuse again; a Graph/network failure may recover
  await store.recordEmailProblem(id, v, settings.source, error, final);
  return { status: "failed", error, final };
}

/** Work one leased meeting: fetch it once, then email and OneDrive side by side. Never throws. */
export async function processMeeting(
  row: import("./minutes-store.server").MeetingRow,
  nowMs = Date.now(),
): Promise<{ email?: EmailOutcome; onedrive?: { ok: boolean; path?: string; error?: string }; error?: string }> {
  const store = await import("./minutes-store.server");
  const id = row.meeting_id;
  const v = String(row.queue_version);
  const release = async (retrySec: number, failed: boolean) => {
    await store.releaseMeeting(id, v, retrySec, failed).catch(() => {});
    if (failed) await store.giveUpIfExhausted(id).catch(() => false);
  };
  let t: FirefliesTranscript;
  try {
    t = (await fetchTranscript(id)).transcript;
  } catch (e) {
    const code = errCode(e, "fireflies_fetch_failed");
    console.error("[fireflies] fetch failed", id, code);
    await store.recordEmailProblem(id, v, "unknown", code, false).catch(() => {});
    await release(retryDelaySec(row.attempts + 1), true);
    return { error: code };
  }
  const ms = meetingDateMs(t as FfTranscript);
  await store
    .recordMeetingInfo(id, t.title ? String(t.title).slice(0, 300) : null, ms != null ? new Date(ms).toISOString() : null)
    .catch(() => {});

  const [emailR, driveR] = await Promise.allSettled([
    row.pending_email ? emailBranch(row, t as FfTranscript, row.owner_email, nowMs) : Promise.resolve(undefined),
    row.pending_onedrive
      ? (async () => {
          const path = await saveTranscript(t, id);
          await store.recordOneDrive(id, v, { ok: true, path });
          return { ok: true as const, path };
        })()
      : Promise.resolve(undefined),
  ]);

  const email: EmailOutcome | undefined =
    emailR.status === "fulfilled" ? emailR.value : { status: "failed", error: errCode(emailR.reason, "email_branch_failed"), final: false };
  let onedrive: { ok: boolean; path?: string; error?: string } | undefined;
  if (driveR.status === "fulfilled") onedrive = driveR.value;
  else {
    onedrive = { ok: false, error: errCode(driveR.reason, "onedrive_failed") };
    await store.recordOneDrive(id, v, onedrive).catch(() => {});
  }
  if (emailR.status === "rejected") {
    await store.recordEmailProblem(id, v, "unknown", (email as { error: string }).error, false).catch(() => {});
  }
  if (email?.status === "failed") console.error("[fireflies] minutes email failed", id, email.error);
  if (onedrive && !onedrive.ok) console.error("[fireflies] onedrive save failed", id, onedrive.error);

  // Still-pending work comes back on the next due pass. Waiting for Fireflies' summary polls every 5
  // minutes and is NOT a failure (the 3h window decides when it gives up); a real failure backs off and
  // counts toward the attempt cap, after which the row records a visible final failure.
  const failed = (email?.status === "failed" && !email.final) || (onedrive ? !onedrive.ok : false);
  const retry = failed ? retryDelaySec(row.attempts + 1) : 300;
  await release(retry, failed);
  return { email, onedrive };
}

/** Called by the once-a-minute run-turn heartbeat (scheduler.server runDueScheduledJobs). One meeting
 *  per tick keeps a pass well inside the ~45s hosting ceiling. Never throws. */
export async function processDueFirefliesMeetings(limit = 1, nowMs = Date.now()): Promise<number> {
  if (!env("FIREFLIES_API_KEY") || !process.env.AZURE_PG_URL) return 0;
  try {
    const store = await import("./minutes-store.server");
    const rows = await store.claimDueMeetings(limit);
    for (const row of rows) await processMeeting(row, nowMs);
    return rows.length;
  } catch (e) {
    console.error("[fireflies] worker pass failed", errCode(e, "worker_failed"));
    return 0;
  }
}

export interface WebhookResult {
  accepted: boolean;
  ignored?: boolean;
  meetingId?: string;
  queued?: boolean;
}

/** Handle one Fireflies Webhooks V2 delivery: verify, validate, QUEUE. Fireflies allows 30s and does not
 *  retry a request that timed out, so no Fireflies / model / Graph call happens here -- the heartbeat
 *  worker does that. A queue write that fails throws, the route answers 503, and Fireflies retries. */
export async function handleFirefliesWebhook(rawBody: string, signature: string | null): Promise<WebhookResult> {
  if (!(await verifyFirefliesSignature(rawBody, signature, env("FIREFLIES_WEBHOOK_SECRET")))) {
    throw new Error("invalid_webhook_signature");
  }
  let payload: FirefliesWebhook;
  try {
    payload = JSON.parse(rawBody) as FirefliesWebhook;
  } catch {
    throw new Error("invalid_webhook_json");
  }
  if (!(HANDLED_EVENTS as readonly unknown[]).includes(payload.event)) return { accepted: true, ignored: true };
  if (typeof payload.meeting_id !== "string" || !payload.meeting_id.trim()) throw new Error("missing_meeting_id");
  const meetingId = safeMeetingId(payload.meeting_id);
  if (!meetingId) throw new Error("invalid_meeting_id");
  const reprocessedAt =
    typeof payload.reprocessed_at === "number" && Number.isFinite(payload.reprocessed_at) ? payload.reprocessed_at : null;

  const owner = minutesOwner();
  if (!owner) throw new Error("minutes_owner_not_configured");
  const store = await import("./minutes-store.server");
  const { queued } = await store.recordWebhook(meetingId, owner, String(payload.event), reprocessedAt);
  return { accepted: true, meetingId, queued };
}
