// Native Huddle email via Microsoft Graph — app-only (client credentials).
//
// This is Huddle's OWN email sender: no journey-voice proxy, no n8n. It uses the
// Entra app's client credentials to get a Graph app token and POSTs to
// /users/{from}/sendMail, so it can send as any mailbox in the tenant the app is
// permitted to (Mail.Send application permission). Default sender is
// dev@enterpriseds.io; HUDDLE_EMAIL_FROM overrides the allow-list (first = default).

const GRAPH = "https://graph.microsoft.com/v1.0";

function firstEnv(names: string[]): string | undefined {
  for (const n of names) {
    const v = process.env[n];
    if (v && v.trim()) return v.trim();
  }
  return undefined;
}

/** Allowed "from" mailboxes; the first is the default. Comma-separated env. */
export function emailFromOptions(): string[] {
  const raw = firstEnv(["HUDDLE_EMAIL_FROM"]) ?? "dev@enterpriseds.io";
  const list = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return list.length ? list : ["dev@enterpriseds.io"];
}

export function defaultFrom(): string {
  return emailFromOptions()[0];
}

/** Whether the Graph app credentials are present at runtime. */
export function graphEmailConfigured(): boolean {
  return (
    !!firstEnv(["GRAPH_CLIENT_ID", "AZURE_CLIENT_ID"]) &&
    !!firstEnv(["GRAPH_CLIENT_SECRET", "AZURE_CLIENT_SECRET"]) &&
    !!firstEnv(["ENTRA_TENANT_ID", "AZURE_TENANT_ID"])
  );
}

async function getAppToken(): Promise<string> {
  const tenant = firstEnv(["ENTRA_TENANT_ID", "AZURE_TENANT_ID"]);
  const clientId = firstEnv(["GRAPH_CLIENT_ID", "AZURE_CLIENT_ID"]);
  const secret = firstEnv(["GRAPH_CLIENT_SECRET", "AZURE_CLIENT_SECRET"]);
  if (!tenant || !clientId || !secret) {
    throw new Error(
      "Microsoft Graph app credentials not configured on the server (need AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET).",
    );
  }
  const res = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: secret,
      scope: "https://graph.microsoft.com/.default",
      grant_type: "client_credentials",
    }),
  });
  if (!res.ok) {
    throw new Error(`Graph token request failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  }
  const json = (await res.json()) as { access_token?: string };
  if (!json.access_token) throw new Error("Graph token response had no access_token");
  return json.access_token;
}

export interface SendEmailInput {
  to: string | string[];
  subject: string;
  body: string;
  from?: string;
  cc?: string | string[];
  html?: boolean;
}

export interface SendEmailResult {
  ok: boolean;
  from?: string;
  to?: string[];
  error?: string;
}

function toRecipients(v: string | string[] | undefined) {
  if (!v) return [];
  const arr = Array.isArray(v) ? v : [v];
  return arr
    .map((a) => a.trim())
    .filter(Boolean)
    .map((address) => ({ emailAddress: { address } }));
}

export interface DraftEmailResult {
  ok: boolean;
  from?: string;
  id?: string;
  webLink?: string;
  error?: string;
}

/**
 * Create a REAL draft in the mailbox's Drafts folder via Graph POST
 * /users/{from}/messages (unlike sendGraphEmail, which sends immediately). Returns
 * the created message's id and webLink so the caller can prove the draft exists.
 * Recipients are optional for a draft. Requires the Graph app to hold Mail.ReadWrite
 * application permission (a 403 here means that consent is missing).
 */
export async function createGraphDraft(input: SendEmailInput): Promise<DraftEmailResult> {
  const options = emailFromOptions();
  const requested = (input.from ?? "").trim();
  const from = requested || options[0];
  if (!options.some((o) => o.toLowerCase() === from.toLowerCase())) {
    return { ok: false, error: `"${from}" is not an allowed mailbox. Available: ${options.join(", ")}.` };
  }
  const subject = String(input.subject ?? "").trim();
  if (!subject) return { ok: false, error: "A subject is required." };

  try {
    const token = await getAppToken();
    const res = await fetch(`${GRAPH}/users/${encodeURIComponent(from)}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        subject,
        body: { contentType: input.html ? "HTML" : "Text", content: input.body ?? "" },
        toRecipients: toRecipients(input.to),
        ccRecipients: toRecipients(input.cc),
      }),
    });
    if (res.status === 201) {
      const j = (await res.json()) as { id?: string; webLink?: string };
      return { ok: true, from, id: j.id, webLink: j.webLink };
    }
    const text = await res.text();
    let msg = `Graph create-draft failed (${res.status})`;
    try {
      const j = JSON.parse(text);
      msg = j?.error?.message ? `${msg}: ${j.error.message}` : `${msg}: ${text.slice(0, 200)}`;
    } catch {
      msg = `${msg}: ${text.slice(0, 200)}`;
    }
    return { ok: false, from, error: msg };
  } catch (err) {
    return { ok: false, from, error: err instanceof Error ? err.message : String(err) };
  }
}

export interface CalendarEvent {
  subject: string;
  start: string | null;
  end: string | null;
  location: string | null;
  isAllDay: boolean;
  organizer: string | null;
}

export interface CalendarReadResult {
  ok: boolean;
  mailbox?: string;
  events?: CalendarEvent[];
  error?: string;
}

/**
 * Read a mailbox's Outlook/M365 calendar for a time range via Graph
 * GET /users/{mailbox}/calendarView. App-only, so it reuses the same client-credentials
 * token as email; requires the Graph app to hold **Calendars.Read** application permission
 * (a 403 here means that consent is missing). Times are ISO 8601; `timeZone` sets the
 * Prefer: outlook.timezone header so start/end come back in the user's zone.
 * NOTE: this reads the Microsoft/Outlook calendar only — a Google-only calendar won't appear.
 */
export async function getGraphCalendarEvents(input: {
  mailbox?: string;
  startISO: string;
  endISO: string;
  timeZone?: string;
  top?: number;
}): Promise<CalendarReadResult> {
  const mailbox = (input.mailbox ?? "").trim() || defaultFrom();
  const top = Math.min(Math.max(input.top ?? 50, 1), 100);
  try {
    const token = await getAppToken();
    // Build the query string by hand so the OData $-params stay literal (URLSearchParams
    // would percent-encode "$select" to "%24select").
    const qs =
      `startDateTime=${encodeURIComponent(input.startISO)}` +
      `&endDateTime=${encodeURIComponent(input.endISO)}` +
      `&$select=${encodeURIComponent("subject,start,end,location,isAllDay,organizer")}` +
      `&$orderby=${encodeURIComponent("start/dateTime")}` +
      `&$top=${top}`;
    const res = await fetch(`${GRAPH}/users/${encodeURIComponent(mailbox)}/calendarView?${qs}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Prefer: `outlook.timezone="${input.timeZone ?? "UTC"}"`,
      },
    });
    if (!res.ok) {
      const text = await res.text();
      let msg = `Graph calendarView failed (${res.status})`;
      try {
        const j = JSON.parse(text);
        msg = j?.error?.message ? `${msg}: ${j.error.message}` : `${msg}: ${text.slice(0, 200)}`;
      } catch {
        msg = `${msg}: ${text.slice(0, 200)}`;
      }
      return { ok: false, mailbox, error: msg };
    }
    const j = (await res.json()) as {
      value?: Array<{
        subject?: string;
        start?: { dateTime?: string };
        end?: { dateTime?: string };
        location?: { displayName?: string };
        isAllDay?: boolean;
        organizer?: { emailAddress?: { name?: string; address?: string } };
      }>;
    };
    const events: CalendarEvent[] = (j.value ?? []).map((e) => ({
      subject: e.subject?.trim() || "(no subject)",
      start: e.start?.dateTime ?? null,
      end: e.end?.dateTime ?? null,
      location: e.location?.displayName?.trim() || null,
      isAllDay: !!e.isAllDay,
      organizer: e.organizer?.emailAddress?.name || e.organizer?.emailAddress?.address || null,
    }));
    return { ok: true, mailbox, events };
  } catch (err) {
    return { ok: false, mailbox, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function sendGraphEmail(input: SendEmailInput): Promise<SendEmailResult> {
  const options = emailFromOptions();
  const requested = (input.from ?? "").trim();
  const from = requested || options[0];
  // Only allow sending as an allow-listed mailbox.
  if (!options.some((o) => o.toLowerCase() === from.toLowerCase())) {
    return {
      ok: false,
      error: `"${from}" is not an allowed sender. Available: ${options.join(", ")}.`,
    };
  }
  const to = toRecipients(input.to);
  if (to.length === 0) return { ok: false, error: "At least one recipient (to) is required." };
  const subject = String(input.subject ?? "").trim();
  if (!subject) return { ok: false, error: "A subject is required." };

  try {
    const token = await getAppToken();
    const res = await fetch(`${GRAPH}/users/${encodeURIComponent(from)}/sendMail`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        message: {
          subject,
          body: { contentType: input.html ? "HTML" : "Text", content: input.body ?? "" },
          toRecipients: to,
          ccRecipients: toRecipients(input.cc),
        },
        saveToSentItems: true,
      }),
    });
    if (res.status === 202) {
      return { ok: true, from, to: to.map((r) => r.emailAddress.address) };
    }
    const text = await res.text();
    // Surface the common "app not permitted / no consent" case clearly.
    let msg = `Graph sendMail failed (${res.status})`;
    try {
      const j = JSON.parse(text);
      msg = j?.error?.message ? `${msg}: ${j.error.message}` : `${msg}: ${text.slice(0, 200)}`;
    } catch {
      msg = `${msg}: ${text.slice(0, 200)}`;
    }
    return { ok: false, from, error: msg };
  } catch (err) {
    return { ok: false, from, error: err instanceof Error ? err.message : String(err) };
  }
}
