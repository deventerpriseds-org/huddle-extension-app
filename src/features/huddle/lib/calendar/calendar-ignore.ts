// WHAT:       THE one calendar-ignore decision for every event Huddle reads (EDS Graph calendarView AND the
//             OneDrive work feed), applied with the owner's OWN TaskOS settings read from journey.
// WHY:        Owner 2026-11-26: "does huddle not look to items in taskos? Why would they need separate ignore
//             approaches?" Option A: Huddle READS the TaskOS settings (journey get_my_config section
//             "calendar_ignore") and applies the SAME decision; Huddle keeps no copy of the settings. Before this,
//             Huddle hid EVERY tentative event (ignoring the owner's switch, which is OFF) and never hid Purple.
// SUPERSEDES: graph-email.server.ts isIgnoredCalendarEvent (blanket-tentative rule, journey marks it superseded
//             since 2026-11-20). That function is now a thin wrapper over this module.
// SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   .claude/ac-huddle-calendar-ignore.md AC-15..AC-24; scripts/calendar-ignore-parity.test.ts runs the
//             shared fixture whose verdicts were produced by journey's own isIgnoredCalendarEvent.
//
// This file is a PORT of the decision only (journey supabase/functions/_shared/calendar-ignore.ts
// isIgnoredCalendarEvent + _shared/meetings.ts otherPeople + _shared/onedrive-feed.ts feedAttendees /
// feedCategories). Parsing the owner's config stays in journey; this module receives already-resolved rules.
// Pure: no imports, so it runs under node and bun alike.

export interface CalendarAttendee {
  email: string;
  optional?: boolean;
  resource?: boolean;
  self?: boolean;
}

/** The owner's resolved rules, exactly the shape journey returns. */
export interface CalendarIgnoreRules {
  /** Title phrases, lower-cased; a title CONTAINING one is ignored. [] = no title rule. */
  phrases: string[];
  /** Ignore tentative GROUP invites (>= 2 other people)? */
  tentative: boolean;
  /** Category names, lower-cased; exact match after trim + case-fold. [] = no category rule. */
  categories: string[];
  /** The owner's own addresses, lower-cased; never counted as "another person". */
  ownerEmails: string[];
}

/** journey TENTATIVE_GROUP_MIN_OTHERS (calendar-ignore.ts:55). 0 = own hold, 1 = a 1:1 -- both kept. */
export const TENTATIVE_GROUP_MIN_OTHERS = 2;

/** The seed title list, journey DEFAULT_CALENDAR_IGNORE_TITLES. */
export const DEFAULT_IGNORE_TITLES: readonly string[] = ["work block"];

/**
 * FALLBACK when the owner's settings cannot be read (journey unreachable, no caller): journey's OWN default rule,
 * resolveIgnoreRules({}) -- work-block titles, tentative GROUP invites only, no categories. Owner-decided G-1
 * (2026-11-26): never the old blanket-tentative rule, never an empty calendar.
 */
export function fallbackIgnoreRules(): CalendarIgnoreRules {
  return { phrases: [...DEFAULT_IGNORE_TITLES], tentative: true, categories: [], ownerEmails: [] };
}

const lowerList = (v: unknown): string[] | null =>
  Array.isArray(v)
    ? [...new Set(v.filter((x): x is string => typeof x === "string" && !!x.trim()).map((x) => x.trim().toLowerCase()))]
    : null;

/**
 * Validate journey's answer FIELD BY FIELD (AC-5): a bad field takes its fallback value, good fields are still
 * honoured, nothing throws. `bad` names the fields that fell back (for the log line, never their values).
 */
export function parseIgnoreRules(raw: unknown): { rules: CalendarIgnoreRules; bad: string[] } {
  const fb = fallbackIgnoreRules();
  const o = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  const bad: string[] = [];
  if (!o) return { rules: fb, bad: ["phrases", "tentative", "categories", "ownerEmails"] };
  const phrases = lowerList(o.phrases);
  if (!phrases) bad.push("phrases");
  const tentative = typeof o.tentative === "boolean" ? o.tentative : null;
  if (tentative === null) bad.push("tentative");
  const categories = lowerList(o.categories);
  if (!categories) bad.push("categories");
  const ownerEmails = lowerList(o.ownerEmails);
  if (!ownerEmails) bad.push("ownerEmails");
  return {
    rules: {
      phrases: phrases ?? fb.phrases,
      tentative: tentative ?? fb.tentative,
      categories: categories ?? fb.categories,
      ownerEmails: ownerEmails ?? fb.ownerEmails,
    },
    bad,
  };
}

/** The rules with extra owner addresses (the caller's sign-in, the EDS mailbox, the feed mailbox) added. */
export function withOwnerEmails(rules: CalendarIgnoreRules, extra: Iterable<unknown>): CalendarIgnoreRules {
  const add = [...extra].map((e) => (typeof e === "string" ? e.trim().toLowerCase() : "")).filter(Boolean);
  return { ...rules, ownerEmails: [...new Set([...rules.ownerEmails, ...add])] };
}

const cleanEmail = (raw: unknown): string => (typeof raw === "string" ? raw.trim().toLowerCase() : "");

/** journey meetings.ts otherPeople: drops empty email, rooms, `self`, and the owner's own addresses. */
export function otherPeople(attendees: unknown, ownerEmails: Iterable<string>): CalendarAttendee[] {
  const owners = new Set<string>();
  for (const e of ownerEmails) {
    const c = cleanEmail(e);
    if (c) owners.add(c);
  }
  const list = Array.isArray(attendees) ? (attendees as CalendarAttendee[]) : [];
  return list.filter((a) => {
    if (!a || !a.email) return false;
    if (a.resource === true) return false;
    if (a.self === true) return false;
    return !owners.has(cleanEmail(a.email));
  });
}

/** Tentative AND a group. No attendee list = not a group (kept): missing a meeting is the harm. */
export function isTentativeGroup(e: { showAs?: unknown; attendees?: unknown }, ownerEmails: Iterable<string>): boolean {
  if (String(e?.showAs ?? "").toLowerCase() !== "tentative") return false;
  return otherPeople(e?.attendees, ownerEmails).length >= TENTATIVE_GROUP_MIN_OTHERS;
}

/** Any of the event's category names exactly equal to a listed one (trim + case-fold). Non-array = none. */
export function hasIgnoredCategory(categories: unknown, ignored: readonly string[]): boolean {
  if (!ignored.length || !Array.isArray(categories)) return false;
  return categories.some((c) => typeof c === "string" && ignored.includes(c.trim().toLowerCase()));
}

/** Title contains any phrase, case-insensitively. */
export function hasIgnoredTitle(title: unknown, phrases: readonly string[]): boolean {
  const t = String(title ?? "").toLowerCase();
  return phrases.some((p) => !!p && t.includes(p));
}

/** THE decision: dropped if ANY rule matches -- a title phrase, a listed category (independent of the tentative
 *  switch), or a tentative GROUP invite when the owner's tentative switch is on. */
export function isIgnoredByRules(
  e: { subject?: unknown; showAs?: unknown; attendees?: unknown; categories?: unknown },
  rules: CalendarIgnoreRules,
): boolean {
  if (hasIgnoredTitle(e?.subject, rules.phrases)) return true;
  if (hasIgnoredCategory(e?.categories, rules.categories)) return true;
  return rules.tentative && isTentativeGroup(e, rules.ownerEmails);
}

/** journey onedrive-feed.ts feedCategories: string names only, as sent; anything else becomes []. */
export function normalizeCategories(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((c): c is string => typeof c === "string" && !!c.trim()) : [];
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/** journey onedrive-feed.ts parseAddress (a bare string without "@" has NO address). */
function feedAddress(v: unknown): string {
  if (v && typeof v === "object") {
    const ea = ((v as Record<string, unknown>).emailAddress ?? v) as Record<string, unknown>;
    return str(ea.address).toLowerCase();
  }
  const s = str(v);
  const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(s);
  if (m) return m[2].trim().toLowerCase();
  return s.includes("@") ? s.toLowerCase() : "";
}

/** journey onedrive-feed.ts feedAttendees: the connector's "a@x; b@y" strings -> attendees, de-duplicated. */
export function feedAttendees(rec: Record<string, unknown>): CalendarAttendee[] {
  const out: CalendarAttendee[] = [];
  const seen = new Set<string>();
  const add = (v: unknown, flags: { optional?: boolean; resource?: boolean }) => {
    for (const part of str(v).split(/[;,]/)) {
      const email = feedAddress(part);
      if (!email || seen.has(email)) continue;
      seen.add(email);
      out.push({ email, ...flags });
    }
  };
  add(rec.requiredAttendees, {});
  add(rec.optionalAttendees, { optional: true });
  add(rec.resourceAttendees, { resource: true });
  return out;
}

/** journey meetings.ts normalizeAttendees(event, 'outlook'): Graph `attendees` -> attendees (type resource /
 *  optional flags; an entry with no address is skipped). */
export function graphAttendees(raw: unknown): CalendarAttendee[] {
  const list = Array.isArray(raw) ? raw : [];
  const out: CalendarAttendee[] = [];
  for (const a of list) {
    if (!a || typeof a !== "object") continue;
    const r = a as { emailAddress?: { address?: unknown }; type?: unknown };
    const email = cleanEmail(r.emailAddress?.address);
    if (!email) continue;
    const type = String(r.type ?? "").toLowerCase();
    out.push({
      email,
      ...(type === "optional" ? { optional: true } : {}),
      ...(type === "resource" ? { resource: true } : {}),
    });
  }
  return out;
}
