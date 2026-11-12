// WHAT:       Pure rules for Fireflies meeting minutes: the minutes-source setting, recipients, the minutes
//             template Luna is given, Fireflies-summary formatting (custom template sections first), the
//             webhook signature check, the "send / skip / update" decision that keeps retries from
//             emailing twice, and a safe Markdown -> email-HTML renderer. No I/O.
// WHY:        Owner handoff 2026-11-10 ("Fireflies Webhook to Huddle Meeting Minutes"): when Fireflies
//             finishes a transcript, email minutes in one of two owner-chosen modes, never silently fall
//             back between them, and never send the same minutes twice on a webhook retry.
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   scripts/fireflies-minutes.test.ts; .claude/actions.md ACT:fireflies-minutes.

export const MINUTES_SOURCES = ["fireflies", "luna"] as const;
export type MinutesSource = (typeof MINUTES_SOURCES)[number];
export const MINUTES_SOURCE_LABEL: Record<MinutesSource, string> = {
  fireflies: "Fireflies summary",
  luna: "Luna from transcript",
};

/** Seeded defaults only -- the owner changes all of these in Settings -> Meeting minutes. */
export const DEFAULT_MINUTES_SOURCE: MinutesSource = "fireflies";
// No address literals here (public repo): the DEFAULT recipients are the owner's own linked addresses
// (identity.profile_emails -- his EDS and work mailboxes), resolved server-side and passed in as `fallback`.
export const DEFAULT_UPDATE_EMAILS = false;

export function parseMinutesSource(raw: unknown): MinutesSource {
  return raw === "luna" ? "luna" : DEFAULT_MINUTES_SOURCE;
}

const EMAIL_RE = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[a-z]{2,}$/i;

/** Stored or typed recipients -> a clean, de-duplicated, lower-cased list. null/garbage -> `fallback`
 *  (the owner's own linked addresses). An explicit list with no valid address is REJECTED (null) rather than silently replaced,
 *  so a typo in Settings can never quietly re-route minutes. */
export function parseRecipients(raw: unknown, fallback: string[] = []): string[] | null {
  const dflt = () => (fallback.length ? parseRecipients(fallback) : null);
  if (raw == null) return dflt();
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(/[\s,;]+/) : null;
  if (!list) return dflt();
  const out: string[] = [];
  for (const v of list) {
    const e = String(v ?? "").trim().toLowerCase();
    if (!e) continue;
    if (!EMAIL_RE.test(e)) return null;
    if (!out.includes(e)) out.push(e);
  }
  return out.length ? out.slice(0, 10) : null;
}

// ---------------------------------------------------------------- webhook signature

function hexToBytes(hex: string): Uint8Array | null {
  if (!/^[a-f0-9]{64}$/i.test(hex)) return null;
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Fireflies Webhooks V2: header `X-Hub-Signature: sha256=<hex>` = HMAC-SHA256(raw body, signing
 *  secret). Only that one format is accepted (V1's bare-hex form is refused). Constant-time compare. */
export async function verifyFirefliesSignature(
  rawBody: string,
  header: string | null | undefined,
  secret: string,
): Promise<boolean> {
  const m = String(header ?? "").trim().match(/^sha256=([a-f0-9]{64})$/i);
  if (!secret || !m) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const expected = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody)));
  const supplied = hexToBytes(m[1]);
  if (!supplied) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected[i] ^ supplied[i];
  return diff === 0;
}

// ---------------------------------------------------------------- transcript shapes

export interface FfSentence {
  speaker_name?: string | null;
  text?: string | null;
  start_time?: number | string | null; // the Fireflies schema types this as String (docs, 2026-11-10)
}
export interface FfSection {
  title?: string | null;
  content?: string | null;
}
export interface FfSummary {
  overview?: unknown;
  short_summary?: unknown;
  action_items?: unknown;
  outline?: unknown;
  shorthand_bullet?: unknown;
  bullet_gist?: unknown;
  keywords?: unknown;
  topics_discussed?: unknown;
  extended_sections?: FfSection[] | null;
}
export interface FfTranscript {
  id?: string;
  title?: string | null;
  date?: number | string | null;
  dateString?: string | null;
  sentences?: FfSentence[] | null;
  summary?: FfSummary | null;
}

export function stamp(raw: number | string | null | undefined): string {
  const seconds = typeof raw === "string" ? Number(raw) : raw;
  if (raw === "" || typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) return "";
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** The transcript as Luna reads it: one `[mm:ss] Speaker: text` line per sentence. */
export function transcriptForModel(t: FfTranscript): string {
  return (t.sentences ?? [])
    .map((s) => {
      const text = String(s.text ?? "").trim();
      if (!text) return "";
      const who = String(s.speaker_name ?? "").trim() || "Speaker";
      const at = stamp(s.start_time);
      return `${at ? `[${at}] ` : ""}${who}: ${text}`;
    })
    .filter(Boolean)
    .join("\n");
}

function asText(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v.trim();
  if (Array.isArray(v)) return v.map((x) => (typeof x === "string" ? `- ${x.trim()}` : "")).filter(Boolean).join("\n");
  return "";
}

export type SummaryResult =
  | { ok: true; source: "custom" | "standard"; markdown: string }
  | { ok: false; error: "summary_missing" };

/** Fireflies-summary mode. Prefers the owner's CUSTOM template output (summary.extended_sections,
 *  produced when the summary is customised in the Fireflies dashboard). When that is absent it uses the
 *  STANDARD summary and says so in the email -- it never claims the custom template was used. When
 *  there is no summary at all it fails; it never falls back to Luna. */
export function firefliesSummaryMarkdown(t: FfTranscript): SummaryResult {
  const s = t.summary ?? {};
  const sections = (s.extended_sections ?? [])
    .map((x) => ({ title: String(x?.title ?? "").trim(), content: String(x?.content ?? "").trim() }))
    .filter((x) => x.content);
  if (sections.length) {
    const md = sections.map((x) => (x.title ? `## ${x.title}\n\n${x.content}` : x.content)).join("\n\n");
    return { ok: true, source: "custom", markdown: md };
  }
  const parts: string[] = [];
  const overview = asText(s.overview) || asText(s.short_summary);
  if (overview) parts.push(`## Summary\n\n${overview}`);
  const outline = asText(s.shorthand_bullet) || asText(s.outline) || asText(s.bullet_gist);
  if (outline) parts.push(`## Discussion\n\n${outline}`);
  const actions = asText(s.action_items);
  if (actions) parts.push(`## Action Items\n\n${actions}`);
  if (!parts.length) return { ok: false, error: "summary_missing" };
  return { ok: true, source: "standard", markdown: parts.join("\n\n") };
}

/** Shown at the top of a Fireflies-mode email built from the STANDARD summary, so the owner can see the
 *  custom template was not available through the API rather than assume it was applied. */
export const STANDARD_SUMMARY_NOTICE =
  "Note: Fireflies' API returned its standard summary for this meeting, not your custom summary " +
  "template (no custom sections were exposed). Switch to \"Luna from transcript\" in Huddle Settings -> " +
  "Meeting minutes to have the minutes written to the five-section template instead.";

// ---------------------------------------------------------------- Luna template

export const MINUTES_INSTRUCTIONS = `You write meeting minutes from a meeting transcript. Use ONLY facts stated in the transcript. Do not infer, guess, or add anything that was not said. Output GitHub-flavoured Markdown with exactly these five top-level sections, in this order, each as a "## " heading: Focus, Summary, Questions, Decisions, Action Items. Write nothing before the first heading and nothing after the last section.

## Focus
- Reverse-engineer the likely agenda from what participants actually discussed. Do not invent facts.
- Each major agenda item is a "### " heading phrased as an action ("Align on…", "Resolve…", "Decide…", "Plan…"), never a bare topic label.
- Under each, concise bullets for the points discussed.

## Summary
- Ignore chitchat, repetition, banter, off-topic remarks and status narration. Include only what is needed to understand the main discussions, decisions, issues and unresolved questions.
- Strictly begin with ONE plain sentence on its own line, no heading and no bold, stating the meeting's main outcome or purpose.
- Then exactly 2 or 3 sections, each with a 2-3 word "### " heading. Never use "#" or "##" headings inside the Summary.
- Keep the whole Summary under 250 words. At most 4 concise bullets per section.
- Include important discussions and decisions, issues, blockers, and open questions phrased as direct questions. Preserve relevant technical specifics. Refer to participants by first name.
- No action items, filler, commentary, or background that did not affect the outcome. No LaTeX. Do not repeat the same information across Summary sections.
- Use **bold** only for person names, tools and project names. Numbered lists only when sequence matters. No bold subheadings unless a section holds two clearly separate topics.

## Questions
- Each question asked during the call as a bullet. The answer given goes beneath it as a nested bullet. Leave an unanswered question with no nested answer.

## Decisions
- Structured bullets of decisions, grouped under "### " headings for each major topic or agenda item.

## Action Items
- Every task identified in the meeting: description, owner if one was named, and the transcript timestamp in [mm:ss] form.
- Group under "### Next 2 weeks" and "### Beyond". Infer the timeframe from transcript context when possible; do not require a spoken due date and never invent a calendar date.
- When nobody was assigned, write "Owner: unassigned" -- never guess an owner.

If a section has nothing in the transcript, write "- None recorded." under it.`;

export function minutesUserPrompt(title: string, dateLabel: string, transcript: string): string {
  return `Meeting: ${title || "Untitled meeting"}${dateLabel ? `\nDate: ${dateLabel}` : ""}\n\nTranscript:\n${transcript}`;
}

/** The five sections the template requires, so a model reply that skipped one is caught, not emailed. */
export function missingTemplateSections(md: string): string[] {
  const want = ["Focus", "Summary", "Questions", "Decisions", "Action Items"];
  return want.filter((h) => !new RegExp(`^##\\s+${h}\\s*$`, "im").test(md));
}

// ---------------------------------------------------------------- dates + subject

export function meetingDateMs(t: FfTranscript): number | null {
  const d = t.date;
  if (typeof d === "number" && Number.isFinite(d)) return d < 1e12 ? d * 1000 : d;
  const p = Date.parse(String(t.dateString ?? d ?? ""));
  return Number.isFinite(p) ? p : null;
}

export function meetingDateLabel(ms: number | null, tz = "America/New_York"): string {
  if (ms == null) return "";
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, month: "short", day: "numeric", year: "numeric" }).format(
    new Date(ms),
  );
}

export function minutesSubject(title: string | null | undefined, dateLabel: string, isUpdate = false): string {
  const clean = String(title ?? "").replace(/[\r\n]+/g, " ").trim().slice(0, 150) || "Untitled meeting";
  return `${isUpdate ? "Updated meeting minutes" : "Meeting minutes"}: ${clean}${dateLabel ? ` (${dateLabel})` : ""}`;
}

// ---------------------------------------------------------------- idempotency + retry policy

export type EmailPlan = "send" | "send_update" | "not_needed";

/** Given what the ledger says was already emailed, should this pass email? Minutes already sent for the
 *  SAME input are never sent again; changed input is emailed again only when the owner switched on update
 *  emails. (Concurrency is handled by the per-meeting lease, not here.) */
export function planEmail(prior: { email_status: string | null; content_hash: string | null }, hash: string, updateEmails: boolean): EmailPlan {
  if (prior.email_status !== "sent") return "send";
  if (prior.content_hash !== hash && updateEmails) return "send_update";
  return "not_needed";
}

/** Fireflies-summary mode waits this long after the first delivery for meeting.summarized before it
 *  gives up and records fireflies_summary_missing. */
export const SUMMARY_WAIT_MS = 3 * 60 * 60 * 1000;
/** Luna mode waits this long for transcript sentences to appear before giving up. */
export const TRANSCRIPT_WAIT_MS = 60 * 60 * 1000;

/** Verify loop 3, D9: the hosting ceiling stops a pass at ~45s, and the slow steps run one after another
 *  (Fireflies query <=12s, a schema-retry query <=12s, Luna <=25s, then the Graph token + send, which have
 *  no timeout of their own). So the pass keeps a budget measured from its own start:
 *  - the email send must START by SEND_CUTOFF_MS, leaving ~15s for token + send + recording "sent";
 *  - Luna gets only the time left before that cutoff (at most 25s), and is skipped under MIN_LUNA_MS. */
export const SEND_CUTOFF_MS = 30_000;
export const LUNA_MAX_MS = 25_000;
export const MIN_LUNA_MS = 8_000;
/** Consecutive passes that were stopped before they finished (never released) before the meeting is given
 *  up with a visible failure. A pass that finishes -- success, waiting or failure -- resets the count. */
export const MAX_UNFINISHED_PASSES = 5;

/** Milliseconds Luna may use given the time the pass has already spent; 0 = not enough time this pass. */
export function lunaBudgetMs(elapsedMs: number): number {
  const left = Math.min(LUNA_MAX_MS, SEND_CUTOFF_MS - elapsedMs);
  return left >= MIN_LUNA_MS ? left : 0;
}

/** Whether there is still time to start the email send in this pass. */
export function canStartSend(elapsedMs: number): boolean {
  return elapsedMs <= SEND_CUTOFF_MS;
}

/** Backoff between worker attempts: 1, 2, 4, 8, 16, 30 (cap) minutes. */
export function retryDelaySec(attempts: number): number {
  return Math.min(60 * 2 ** Math.max(0, attempts - 1), 1800);
}

// ---------------------------------------------------------------- safe Markdown -> email HTML

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function inline(s: string): string {
  // Escape FIRST; only then add the two tags we allow. No links, images or raw HTML survive.
  return esc(s)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\s][^*]*)\*(?!\*)/g, "$1<em>$2</em>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
}

/** Markdown (headings, bullets incl. nesting, numbered lists, bold/italic/code, paragraphs) -> an HTML
 *  fragment for an email body. Every character of the source is HTML-escaped before formatting, so
 *  transcript text can never inject markup. */
export function markdownToEmailHtml(md: string, fontStyle = "font-family:Calibri,Arial,Helvetica,sans-serif;font-size:11pt;color:#000000"): string {
  const out: string[] = [];
  const stack: Array<{ tag: "ul" | "ol"; indent: number }> = [];
  const closeTo = (indent: number) => {
    while (stack.length && stack[stack.length - 1].indent >= indent) out.push(`</li></${stack.pop()!.tag}>`);
  };
  let para: string[] = [];
  const flushPara = () => {
    if (para.length) out.push(`<p style="margin:0 0 8px 0">${para.map(inline).join("<br>")}</p>`);
    para = [];
  };
  for (const rawLine of String(md ?? "").replace(/\r\n?/g, "\n").split("\n")) {
    const line = rawLine.replace(/\t/g, "    ");
    const h = line.match(/^\s*(#{1,6})\s+(.*)$/);
    const li = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
    if (!line.trim()) {
      flushPara();
      continue;
    }
    if (h) {
      flushPara();
      closeTo(0);
      const lvl = Math.min(4, h[1].length + 1); // # -> h2 ... keeps email headings modest
      out.push(`<h${lvl} style="margin:14px 0 6px 0">${inline(h[2].trim())}</h${lvl}>`);
      continue;
    }
    if (li) {
      flushPara();
      const indent = li[1].length;
      const tag: "ul" | "ol" = /\d/.test(li[2]) ? "ol" : "ul";
      closeTo(indent + 1); // leave any deeper lists
      const top = stack[stack.length - 1];
      if (top && top.indent === indent && top.tag === tag) {
        out.push("</li>"); // sibling item
      } else {
        if (top && top.indent === indent) out.push(`</li></${stack.pop()!.tag}>`); // list type changed
        out.push(`<${tag} style="margin:0 0 6px 0">`); // new (possibly nested) list
        stack.push({ tag, indent });
      }
      out.push(`<li>${inline(li[3])}`);
      continue;
    }
    if (stack.length && /^\s{2,}\S/.test(line)) {
      out.push(`<br>${inline(line.trim())}`);
      continue;
    }
    closeTo(0);
    para.push(line.trim());
  }
  flushPara();
  closeTo(0);
  return `<div style="${fontStyle}">${out.join("")}</div>`;
}

/** Short, stable content hash (FNV-1a 64 as hex) of the meeting INPUT (transcript + Fireflies summary),
 *  never of generated minutes -- Luna's wording differs run to run, so hashing output would make every
 *  retry look "changed". Same input => same hash => no second email. */
export function contentHash(s: string): string {
  let h = 0xcbf29ce484222325n;
  for (const ch of new TextEncoder().encode(s)) {
    h ^= BigInt(ch);
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, "0");
}

/** Hash of the meeting INPUT (transcript + Fireflies summary) used for the "changed?" check. */
export function meetingInputHash(t: FfTranscript): string {
  return contentHash(transcriptForModel(t) + "\n--summary--\n" + JSON.stringify(t.summary ?? null));
}

/** A Fireflies meeting id is used verbatim as the stable OneDrive filename, so it must already be safe:
 *  anything outside [A-Za-z0-9_-] (or empty / over 120 chars) is REJECTED, never cleaned -- cleaning would
 *  let two different ids share one file (verify loop 1, C2). */
export function safeMeetingId(id: string): string | null {
  const s = String(id ?? "").trim();
  return /^[A-Za-z0-9_-]{1,120}$/.test(s) ? s : null;
}
