// WHAT:       The Fireflies -> Huddle pipeline: verify a signed Webhooks V2 delivery, fetch the meeting's
//             transcript + summary, then INDEPENDENTLY (a) email meeting minutes in the owner's chosen
//             mode (Fireflies summary | Luna from transcript) and (b) upsert the transcript Markdown into
//             OneDrive /Automation/transcripts. Neither waits on, or fails because of, the other.
// WHY:        Owner handoff 2026-11-10 (Fireflies Webhook to Huddle Meeting Minutes), extending draft PR
//             #188, which saved transcripts to OneDrive but sent no minutes and was not retry-safe.
// SUPERSEDES: PR #188's handleFirefliesWebhook (OneDrive-only, throws on any failure).
// SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   scripts/fireflies-minutes.test.ts; .claude/actions.md ACT:fireflies-minutes.
//
// Never logs or stores transcript text, summary text, API keys or Graph response bodies -- only ids,
// statuses and short error codes.
import { emailFromOptions, getAppToken, graphEmailConfigured } from "../email/graph-email.server";
import {
  decideDelivery,
  firefliesSummaryMarkdown,
  markdownToEmailHtml,
  meetingDateLabel,
  meetingDateMs,
  meetingInputHash,
  minutesSubject,
  minutesUserPrompt,
  missingTemplateSections,
  MINUTES_INSTRUCTIONS,
  parseMinutesSource,
  parseRecipients,
  safeMeetingId,
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
    start_time?: number;
    end_time?: number;
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
    const time =
      typeof sentence.start_time === "number"
        ? "[" +
          String(Math.floor(sentence.start_time / 60)).padStart(2, "0") +
          ":" +
          String(Math.floor(sentence.start_time % 60)).padStart(2, "0") +
          "] "
        : "";
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
  const timer = setTimeout(() => ctl.abort(), 15_000);
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
  | { ok: false; error: string; transient?: boolean };

/** Produce minutes in EXACTLY the selected mode. No fallback between modes, ever. */
export async function generateMinutes(
  source: MinutesSource,
  t: FfTranscript,
  callModel: (instructions: string, input: string) => Promise<string> = callLuna,
): Promise<Generated> {
  if (source === "fireflies") {
    const r = firefliesSummaryMarkdown(t);
    if (!r.ok) return { ok: false, error: "fireflies_summary_missing" };
    return {
      ok: true,
      kind: r.source,
      markdown: r.source === "standard" ? `_${STANDARD_SUMMARY_NOTICE}_\n\n${r.markdown}` : r.markdown,
    };
  }
  const transcript = transcriptForModel(t);
  if (!transcript.trim()) return { ok: false, error: "transcript_missing" };
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
  const timer = setTimeout(() => ctl.abort(), 32_000); // under the ~45s hosting ceiling
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

export type EmailOutcome =
  | { status: "sent"; kind: string; recipients: string[]; update: boolean }
  | { status: "skipped"; reason: "already_sent" | "in_flight" }
  | { status: "failed"; error: string; transient: boolean };

async function deliverMinutes(
  meetingId: string,
  t: FfTranscript,
  settings: MinutesSettings,
  owner: string,
  prior: { email_status: string | null; content_hash: string | null },
  hash: string,
): Promise<EmailOutcome> {
  const store = await import("./minutes-store.server");
  const decision = decideDelivery(prior, hash, settings.updateEmails);
  if (decision === "skip_already_sent") return { status: "skipped", reason: "already_sent" };
  if (decision === "skip_in_flight") return { status: "skipped", reason: "in_flight" };

  if (!settings.recipients?.length) {
    await store.recordEmailSkipped(meetingId, settings.source, "recipients_invalid");
    return { status: "failed", error: "recipients_invalid", transient: false };
  }
  const gen = await generateMinutes(settings.source, t);
  if (!gen.ok) {
    await store.recordEmailSkipped(meetingId, settings.source, gen.error);
    return { status: "failed", error: gen.error, transient: !!gen.transient };
  }
  // Atomic: only one concurrent delivery for this meeting gets past here.
  if (!(await store.claimEmail(meetingId, hash, decision === "send_update"))) {
    return { status: "skipped", reason: "in_flight" };
  }
  const update = decision === "send_update";
  const dateLabel = meetingDateLabel(meetingDateMs(t));
  const heading = `# ${String(t.title ?? "Untitled meeting").trim() || "Untitled meeting"}${dateLabel ? `\n\n${dateLabel}` : ""}`;
  const sourceLine =
    gen.kind === "luna"
      ? "_Minutes written by Luna from the full Fireflies transcript._"
      : gen.kind === "custom"
        ? "_Minutes from your Fireflies custom summary._"
        : "_Minutes from the Fireflies summary._";
  const md = `${heading}\n\n${sourceLine}\n\n${gen.markdown}`;
  const { sendGraphEmail } = await import("../email/graph-email.server");
  const sent = await sendGraphEmail({
    to: settings.recipients,
    subject: minutesSubject(t.title, dateLabel, update),
    body: markdownToEmailHtml(md),
    html: true,
    callerEmail: owner,
  });
  const error = sent.ok
    ? undefined
    : sent.gateRefused
      ? "email_send_refused_by_gate (recipients must be your own addresses, or sending must be enabled)"
      : (sent.error ?? "email_send_failed").replace(/[\r\n]+/g, " ").slice(0, 200);
  await store.recordEmail(meetingId, {
    ok: sent.ok,
    source: settings.source,
    kind: gen.kind,
    hash,
    recipients: settings.recipients,
    error,
  });
  if (!sent.ok) return { status: "failed", error: error!, transient: !sent.gateRefused };
  return { status: "sent", kind: gen.kind, recipients: settings.recipients, update };
}

export interface WebhookResult {
  accepted: boolean;
  ignored?: boolean;
  meetingId?: string;
  minutesSource?: MinutesSource;
  email?: EmailOutcome;
  onedrive?: { ok: boolean; path?: string; error?: string };
  /** true when something failed that a Fireflies retry could fix -> the route answers 503. */
  retry?: boolean;
}

/** Handle one Fireflies Webhooks V2 delivery. Email and OneDrive run side by side; each records its
 *  own result, and one failing never blocks the other. */
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

  if (payload.event !== "meeting.transcribed") return { accepted: true, ignored: true };
  if (typeof payload.meeting_id !== "string" || !payload.meeting_id.trim()) {
    throw new Error("missing_meeting_id");
  }
  const meetingId = payload.meeting_id.trim();
  if (!safeMeetingId(meetingId)) throw new Error("invalid_meeting_id");

  const owner = minutesOwner();
  if (!owner) throw new Error("minutes_owner_not_configured");
  const settings = await loadMinutesSettings(owner); // read at processing time, every delivery

  const { transcript } = await fetchTranscript(meetingId);
  const store = await import("./minutes-store.server");
  const ms = meetingDateMs(transcript as FfTranscript);
  const prior = await store.noteDelivery(
    meetingId,
    owner,
    transcript.title ? String(transcript.title).slice(0, 300) : null,
    ms != null ? new Date(ms).toISOString() : null,
  );
  // noteDelivery returns the row AFTER the upsert; email/hash fields are untouched by it, so they are the
  // prior delivery's state.
  const hash = meetingInputHash(transcript as FfTranscript);

  const [emailR, driveR] = await Promise.allSettled([
    deliverMinutes(meetingId, transcript as FfTranscript, settings, owner, prior, hash),
    (async () => {
      const path = await saveTranscript(transcript, meetingId);
      await store.recordOneDrive(meetingId, { ok: true, path });
      return { ok: true as const, path };
    })(),
  ]);

  const email: EmailOutcome =
    emailR.status === "fulfilled"
      ? emailR.value
      : { status: "failed", error: errCode(emailR.reason, "email_pipeline_failed"), transient: true };
  let onedrive: WebhookResult["onedrive"];
  if (driveR.status === "fulfilled") onedrive = driveR.value;
  else {
    onedrive = { ok: false, error: errCode(driveR.reason, "onedrive_failed") };
    await store.recordOneDrive(meetingId, onedrive).catch(() => {});
  }
  if (email.status === "failed") console.error("[fireflies] minutes email failed", meetingId, email.error);
  if (!onedrive.ok) console.error("[fireflies] onedrive save failed", meetingId, onedrive.error);

  return {
    accepted: true,
    meetingId,
    minutesSource: settings.source,
    email,
    onedrive,
    retry: (email.status === "failed" && email.transient) || !onedrive.ok,
  };
}

function errCode(e: unknown, fallback: string): string {
  const m = e instanceof Error ? e.message : "";
  return /^[a-z0-9_:|. -]{1,120}$/i.test(m) ? m : fallback;
}
