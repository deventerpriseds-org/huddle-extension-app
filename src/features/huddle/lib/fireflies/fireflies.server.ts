import { emailFromOptions, getAppToken, graphEmailConfigured } from "../email/graph-email.server";

const FIREFLIES_GRAPHQL = "https://api.fireflies.ai/graphql";
const GRAPH = "https://graph.microsoft.com/v1.0";
const MAX_WEBHOOK_BYTES = 16_384;
const MAX_TRANSCRIPT_BYTES = 10 * 1024 * 1024;
const TRANSCRIPT_FOLDER = "automation/transcripts";

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
  };
};

function env(name: string): string {
  return String(process.env[name] ?? "").trim();
}

function hexToBytes(hex: string): Uint8Array | null {
  if (!/^[a-f0-9]{64}$/i.test(hex)) return null;
  const result = new Uint8Array(32);
  for (let i = 0; i < result.length; i++) {
    result[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return result;
}

async function validWebhookSignature(rawBody: string, header: string | null): Promise<boolean> {
  const secret = env("FIREFLIES_WEBHOOK_SECRET");
  const match = header?.match(/^sha256=([a-f0-9]{64})$/i);
  if (!secret || !match) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const expected = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody)),
  );
  const supplied = hexToBytes(match[1]);
  if (!supplied || supplied.length !== expected.length) return false;

  let difference = 0;
  for (let i = 0; i < expected.length; i++) difference |= expected[i] ^ supplied[i];
  return difference === 0;
}

function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

function graphUserPath(mailbox: string): string {
  return "/users/" + encodeURIComponent(mailbox) + "/drive";
}

async function ensureDriveFolder(token: string, mailbox: string, path: string): Promise<void> {
  const encoded = encodePath(path);
  const lookup = await fetch(GRAPH + graphUserPath(mailbox) + "/root:/" + encoded);
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

async function fetchTranscript(meetingId: string): Promise<FirefliesTranscript> {
  const apiKey = env("FIREFLIES_API_KEY");
  if (!apiKey) throw new Error("fireflies_api_key_not_configured");

  const query =
    "query Transcript($transcriptId: String!) { transcript(id: $transcriptId) { " +
    "id title date dateString duration organizer_email host_email participants transcript_url " +
    "meeting_attendees { displayName name email } " +
    "sentences { speaker_name text start_time end_time } " +
    "summary { overview short_summary action_items keywords topics_discussed } } }";

  const response = await fetch(FIREFLIES_GRAPHQL, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables: { transcriptId: meetingId } }),
  });
  if (!response.ok) throw new Error("fireflies_api_http_" + response.status);

  const result = (await response.json()) as {
    data?: { transcript?: FirefliesTranscript | null };
    errors?: unknown[];
  };
  if (result.errors?.length || !result.data?.transcript) {
    throw new Error("fireflies_transcript_unavailable");
  }
  return result.data.transcript;
}

function safeTranscriptId(id: string): string {
  const safe = id.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 120);
  if (!safe) throw new Error("invalid_meeting_id");
  return safe;
}

async function saveTranscript(transcript: FirefliesTranscript, meetingId: string): Promise<void> {
  if (!graphEmailConfigured()) throw new Error("graph_not_configured");
  const mailbox = env("FIREFLIES_ONEDRIVE_MAILBOX") || emailFromOptions()[0];
  if (!mailbox) throw new Error("onedrive_mailbox_not_configured");

  const token = await getAppToken();
  await ensureDriveFolder(token, mailbox, TRANSCRIPT_FOLDER);

  const markdown = formatTranscript(transcript);
  const bytes = new TextEncoder().encode(markdown);
  if (bytes.length > MAX_TRANSCRIPT_BYTES) throw new Error("transcript_too_large");

  const fileName = "fireflies-" + safeTranscriptId(meetingId) + ".md";
  const path = TRANSCRIPT_FOLDER + "/" + fileName;
  const response = await fetch(
    GRAPH + graphUserPath(mailbox) + "/root:/" + encodePath(path) + ":/content",
    {
      method: "PUT",
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "text/markdown; charset=utf-8",
      },
      body: bytes,
    },
  );
  if (!response.ok) throw new Error("onedrive_upload_" + response.status);
}

/** Handle a Fireflies V2 meeting.transcribed delivery and upsert a transcript into OneDrive. */
export async function handleFirefliesWebhook(
  rawBody: string,
  signature: string | null,
): Promise<{ accepted: boolean; ignored?: boolean; meetingId?: string }> {
  if (!(await validWebhookSignature(rawBody, signature))) {
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
  const transcript = await fetchTranscript(meetingId);
  await saveTranscript(transcript, meetingId);
  return { accepted: true, meetingId };
}
