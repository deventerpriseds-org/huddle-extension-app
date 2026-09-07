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

export async function getAppToken(): Promise<string> {
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
  /** D4b: swept by the recipient gate. NOTE: no tool schema exposes bcc today and neither
   *  sendGraphEmail nor createGraphDraft puts bccRecipients on the Graph wire -- this field exists so
   *  that the day a caller DOES pass one, the gate already counts it instead of silently ignoring a
   *  recipient. Defence in depth, not a live hole. */
  bcc?: string | string[];
  html?: boolean;
  /** The signed-in user this send is on behalf of. Used ONLY by sendGraphEmail's email-send gate
   *  (identity.agent_workflow_config.email_send_enabled) - never put on the wire to Graph.
   *  Omitting it means the gate cannot find an affirmative permission, so the send is REFUSED.
   *  createGraphDraft ignores it: drafting is always allowed. */
  callerEmail?: string | null;
  /** Optional agent id, so a per-agent override in email_send_agent_overrides can apply. */
  callerAgentId?: string;
  /** D4b: the OWNER'S OWN message text for this turn -- the ONLY admissible evidence that he asked
   *  for an ON-REQUEST address. Never the agent's reply, a system prompt, retrieved memory, or any
   *  tool argument the model chose: admitting model output here would let an agent manufacture its
   *  own authorisation. A surface that cannot supply it omits it, and on-request addresses draft. */
  ownerTurnText?: string | null;
}

export interface SendEmailResult {
  ok: boolean;
  from?: string;
  to?: string[];
  error?: string;
  /** D4b: true when the send was refused on recipient scope and a real draft was created instead.
   *  `ok` stays FALSE on a degraded send, deliberately: the house style tells every agent to claim an
   *  email was "sent" only if send_email returned success, so a truthy result here would make the
   *  agent report a send that did not happen. */
  drafted?: boolean;
  draftId?: string;
  draftWebLink?: string;
  /** The recipients that blocked the send, so the agent can say WHICH address caused the draft. */
  blockedRecipients?: string[];
  /** True when the D4a GLOBAL gate refused this send (as opposed to Graph failing). Lets the
   *  orchestrator degrade to a draft ONLY on a refusal, and surface a genuine transport failure as
   *  itself instead of mislabelling it "not one of your own addresses". */
  gateRefused?: boolean;
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
        bccRecipients: toRecipients(input.bcc),
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

/**
 * D4b: resolve, for ONE send attempt, whether every recipient clears the recipient-scoped gate.
 *
 * Pulled out of sendGraphEmail so BOTH the send path and the orchestrator (`sendOrDraftEmail`) reach
 * the same verdict from the same code -- two copies of an authorisation decision is how one surface
 * ends up gated and another not, which is the defect class this repo has already paid for twice.
 *
 * FAILS CLOSED: any throw yields a "draft" verdict with an explanatory reason, never a "send".
 */
async function resolveRecipientScope(input: SendEmailInput): Promise<{
  decision: "send" | "draft" | "no-recipients";
  blocked: string[];
  reason: string;
}> {
  try {
    const { resolveSelfSendPolicy } = await import("../identity/agent-workflow-config.server");
    const { classifySendScope, draftReasonSentence } = await import("./self-send-gate");
    const { selfRows, tierMap, tiersReadable } = await resolveSelfSendPolicy(input.callerEmail);
    const scope = classifySendScope({
      to: input.to,
      cc: input.cc,
      bcc: input.bcc,
      selfRows,
      tierMap,
      tiersReadable,
      ownerTurnText: input.ownerTurnText,
    });
    return {
      decision: scope.decision,
      blocked: scope.blocked.map((b) => b.address || b.raw),
      reason: scope.blocked.length ? draftReasonSentence(scope.blocked) : "",
    };
  } catch (err) {
    console.error(
      "[resolveRecipientScope] recipient-scope resolution failed; failing CLOSED (draft):",
      err instanceof Error ? err.message : err,
    );
    return { decision: "draft", blocked: [], reason: "Saved to drafts instead of sending: the recipient check could not be completed." };
  }
}

export async function sendGraphEmail(input: SendEmailInput): Promise<SendEmailResult> {
  // D4b RECIPIENT SCOPE (2026-09-07). Owner: "when I want it to send me a summary or digest or other
  // email it should be able to do so - it's other recipients that should be draft". A message whose
  // recipients are ALL his own sendable addresses bypasses the GLOBAL flag below; anything else still
  // has to satisfy it. Note the direction: this can only ever SKIP the global gate for mail going to
  // the owner himself, and it can never open the global gate for anyone else.
  const scope = await resolveRecipientScope(input);
  const selfOnly = scope.decision === "send";
  if (!selfOnly) {
  // EMAIL SEND GATE - BACKSTOP (2026-09-07). The PRIMARY gate is at tool assembly: when sending is
  // disabled, `send_email` is never offered to the model on either surface (huddle.functions.ts for
  // text, voice/realtime-tools.server.ts for the Realtime session). This is belt and braces for the
  // case the primary gate is bypassed - a stale minted toolset still held by a live voice session, a
  // cached tool definition, or a future call site that forgets the gate. It is the LAST thing between
  // an agent and real mail leaving the tenant, so it fails CLOSED in every direction: no callerEmail,
  // a config-read error, or an explicit false all refuse. The error names the exact setting to flip.
  {
    // Even LOADING the config module is inside the try: a module-resolution failure must fail CLOSED
    // (drafts only) and never throw out of a tool call. `false` is the only safe value here.
    const allowed = await (async () => {
      try {
        const { isEmailSendEnabled } = await import("../identity/agent-workflow-config.server");
        return await isEmailSendEnabled(input.callerEmail, input.callerAgentId);
      } catch (err) {
        console.error(
          "[sendGraphEmail] email-send-gate resolution failed; failing CLOSED (drafts only):",
          err instanceof Error ? err.message : err,
        );
        return false;
      }
    })();
    if (!allowed) {
      return {
        ok: false,
        // Structural marker so sendOrDraftEmail can tell "the GATE refused" from "Graph failed".
        // Sniffing the message text for that distinction would break the moment the wording changed.
        gateRefused: true,
        error:
          "Sending email is currently disabled - agents may only prepare drafts. Use create_email_draft " +
          "instead; the draft lands in the mailbox's Drafts folder ready to review and send by hand. " +
          "(To re-enable sending, set identity.agent_workflow_config.email_send_enabled = true for this " +
          "user; it takes effect on the next turn, no redeploy needed.)",
      };
    }
  }
  }
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
          bccRecipients: toRecipients(input.bcc),
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

/**
 * D4b: THE ORCHESTRATOR every agent-facing dispatch site should call instead of `sendGraphEmail`.
 *
 * Send when the recipients clear the gate; otherwise create a REAL draft and say so. The owner's
 * requirement in one function: "when I want it to send me a summary or digest or other email it
 * should be able to do so -- it's other recipients that should be draft."
 *
 * WHY THE DEGRADATION LIVES HERE AND NOT INSIDE `sendGraphEmail`. That function's backstop has a
 * proven property, asserted by `voice-toolset-hidden.test.ts` 4d: when the gate is closed it REFUSES
 * WITHOUT TOUCHING THE NETWORK AT ALL. Creating a draft is a Graph call. Folding the draft into the
 * refusal would have destroyed that property -- the backstop would start making network calls on the
 * refusal path -- and the only way to keep the existing test green would have been to weaken it. So
 * the authorisation DECISION stays in the one choke point and the degradation ACTION happens one
 * layer out, where drafting already lives.
 *
 * `ok` is FALSE on a degraded send even though a draft was successfully created. That is deliberate:
 * the shared house style tells every agent to say an email was "sent" only if `send_email` returned
 * success. A truthy result would make the agent claim a send that never happened, which is the exact
 * dishonesty the D4a work existed to prevent.
 */
export async function sendOrDraftEmail(input: SendEmailInput): Promise<SendEmailResult> {
  const scope = await resolveRecipientScope(input);
  if (scope.decision === "send") return sendGraphEmail(input);

  // Not self-only. The GLOBAL D4a flag may still permit it (that is what the owner flips when he is
  // ready for third-party sending); sendGraphEmail re-checks it and refuses if not.
  if (scope.decision !== "no-recipients") {
    const sent = await sendGraphEmail(input);
    if (sent.ok) return sent;
    // Degrade ONLY when the gate refused. If the send was PERMITTED and Graph failed (a 5xx, an
    // expired secret, a missing consent), that is a transport failure and must surface as itself --
    // reporting it as "saved to drafts because X is not one of your addresses" would be a false
    // explanation of a real outage, and would hide it from whoever has to fix it.
    if (!sent.gateRefused) return sent;
  }

  const draft = await createGraphDraft(input);
  const why =
    scope.decision === "no-recipients"
      ? "Saved to drafts instead of sending: no recipient was given."
      : scope.reason || "Saved to drafts instead of sending: a recipient is not one of your own addresses.";
  if (!draft.ok) {
    return {
      ok: false,
      from: draft.from,
      blockedRecipients: scope.blocked,
      error: `${why} The draft could not be created either: ${draft.error ?? "unknown error"}`,
    };
  }
  return {
    ok: false,
    drafted: true,
    from: draft.from,
    draftId: draft.id,
    draftWebLink: draft.webLink,
    blockedRecipients: scope.blocked,
    error:
      `${why} It is waiting in the ${draft.from} Drafts folder for you to review and send.` +
      (draft.webLink ? ` (${draft.webLink})` : ""),
  };
}
