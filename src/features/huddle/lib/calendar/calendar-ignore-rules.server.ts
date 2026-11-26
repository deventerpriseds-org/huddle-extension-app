// WHAT:       Reads the owner's TaskOS calendar-ignore settings from journey (get_my_config section
//             "calendar_ignore") for one caller, caches them <= 60 s per owner, and falls back to journey's
//             default rule when journey cannot answer.
// WHY:        Owner 2026-11-26 option A: Huddle follows the settings the owner edits in TaskOS, with no Huddle copy.
//             One calendar read must not call journey several times (AC-7/AC-8), and a journey outage must never
//             empty or crash the calendar (AC-4, G-1).
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   .claude/ac-huddle-calendar-ignore.md AC-4..AC-12; scripts/calendar-ignore-rules.test.ts.
//
// Transport: the existing invokeJourneyTool -> journey huddle-proxy /tool -> execute-tool. No new secret.
// The proxy module is imported lazily so this file (and its tests) load without the web framework.

import { fallbackIgnoreRules, parseIgnoreRules, type CalendarIgnoreRules } from "./calendar-ignore";

export interface IgnoreRulesCaller {
  entra_object_id?: string;
  entra_email?: string;
}

/** G-6: settings are cached at most this long per owner. */
export const IGNORE_RULES_TTL_MS = 60_000;
/** AC-12: the longest a calendar read waits for the settings before taking the fallback. */
export const IGNORE_RULES_TIMEOUT_MS = 5_000;

type Invoke = (req: {
  toolName: string;
  args: Record<string, string>;
  caller: IgnoreRulesCaller;
}) => Promise<{ ok: boolean; output?: unknown; error?: string }>;

export interface LoadIgnoreRulesDeps {
  invoke?: Invoke;
  now?: () => number;
  timeoutMs?: number;
}

export interface LoadedIgnoreRules {
  rules: CalendarIgnoreRules;
  /** "owner" = journey answered (fields may still have fallen back individually); "fallback" = it did not. */
  from: "owner" | "fallback";
}

const cache = new Map<string, { at: number; rules: CalendarIgnoreRules }>();

/** Test hook: forget every cached owner. */
export function clearIgnoreRulesCache(): void {
  cache.clear();
}

/** The cache key: the caller's identity, never shared between owners (AC-9). "" = no usable identity. */
export function ignoreRulesCacheKey(caller: IgnoreRulesCaller | undefined): string {
  const id = (caller?.entra_object_id ?? "").trim();
  if (id) return `oid:${id}`;
  const em = (caller?.entra_email ?? "").trim().toLowerCase();
  return em ? `email:${em}` : "";
}

const defaultInvoke: Invoke = async (req) => {
  const { invokeJourneyTool } = await import("../journey/proxy.functions");
  return invokeJourneyTool(req);
};

/** A failure KIND for the log line: an HTTP status, journey's error code, or an exception class. Never text
 *  from the response (it can carry user data). */
function failureKind(r: { ok: boolean; error?: string } | null, err?: unknown): string {
  if (err !== undefined) {
    if (err instanceof Error && err.message === "calendar_ignore_timeout") return "timeout";
    return err instanceof Error ? err.name || "Error" : typeof err;
  }
  const m = /journey \/tool (\d{3})/.exec(String(r?.error ?? ""));
  if (m) return `http_${m[1]}`;
  if (/non-JSON/.test(String(r?.error ?? ""))) return "non_json";
  return r && !r.ok ? "ok_false" : "unknown";
}

/**
 * The owner's rules for `caller`. No caller identity -> the fallback and NO journey call (AC-6). A failure is
 * logged once (kind only) and NOT cached, so the next read asks journey again (AC-10).
 */
export async function loadCalendarIgnoreRules(
  caller: IgnoreRulesCaller | undefined,
  deps: LoadIgnoreRulesDeps = {},
): Promise<LoadedIgnoreRules> {
  const key = ignoreRulesCacheKey(caller);
  if (!key) return { rules: fallbackIgnoreRules(), from: "fallback" };
  const now = deps.now ?? Date.now;
  const hit = cache.get(key);
  if (hit && now() - hit.at <= IGNORE_RULES_TTL_MS) return { rules: hit.rules, from: "owner" };
  const invoke = deps.invoke ?? defaultInvoke;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, rej) => {
      timer = setTimeout(() => rej(new Error("calendar_ignore_timeout")), deps.timeoutMs ?? IGNORE_RULES_TIMEOUT_MS);
    });
    const r = await Promise.race([
      invoke({ toolName: "get_my_config", args: { section: "calendar_ignore" }, caller: caller ?? {} }),
      timeout,
    ]);
    if (!r || !r.ok) {
      console.error(`[calendar-ignore] owner settings unavailable (${failureKind(r)}); using the default rule`);
      return { rules: fallbackIgnoreRules(), from: "fallback" };
    }
    let parsed: unknown;
    try {
      parsed = typeof r.output === "string" ? JSON.parse(r.output) : r.output;
    } catch {
      console.error("[calendar-ignore] owner settings unavailable (non_json_output); using the default rule");
      return { rules: fallbackIgnoreRules(), from: "fallback" };
    }
    const { rules, bad } = parseIgnoreRules(parsed);
    if (bad.length === 4) {
      console.error("[calendar-ignore] owner settings unavailable (bad_shape); using the default rule");
      return { rules, from: "fallback" };
    }
    if (bad.length) console.error(`[calendar-ignore] owner settings field(s) invalid (${bad.join(",")}); those use the default`);
    cache.set(key, { at: now(), rules });
    return { rules, from: "owner" };
  } catch (err) {
    console.error(`[calendar-ignore] owner settings unavailable (${failureKind(null, err)}); using the default rule`);
    return { rules: fallbackIgnoreRules(), from: "fallback" };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
