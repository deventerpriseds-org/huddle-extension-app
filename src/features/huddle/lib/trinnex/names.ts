// WHAT:       THE one shared, pure name parser for the Trinnex workspace: (1) people names suggested from a
//             meeting title OR a file name, (2) a Fireflies speaker label classified and matched to the people list.
//             Used by the Meetings lane and the Library lane; there is no second parser.
// WHY:        The approved prototype carried two parsers (meetings.html titleNames, library.html nameHits) that
//             disagree on `1on1_Dana`, `Budget/Forecast`, `ACME` and `José` (AC-trinnex-workspace.md section 5).
//             The spelling table S-A / S-B is the contract; this file follows the table, not either prototype.
// SUPERSEDES: prototype-only parsers docs/trinnex/prototype/{meetings,library}.html (never shipped).
// SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   scripts/trinnex-names.test.ts (every S-A and S-B row); docs/qc-evidence/BUILD-trinnex-meetings.md.
//
// THIS REPO IS PUBLIC: no real names here. Dependency-free (no pg, no fetch, no React).
// Results are SUGGESTIONS only. Nothing in this file ever adds a person or applies a mapping.

/** Common words, months, weekdays: never offered as a NEW name (whole-token compare, never a prefix: S-A8/S-A9). */
const STOP = new Set(
  (
    "a an and the of for to on in at by with from vs x me my our us we you i it all team teams hands meeting meetings sync call calls chat notes note review reviews update updates standup stand up " +
    "weekly daily monthly quarterly annual yearly planning plan plans budget budgets vendor vendors client clients customer customers project projects roadmap kickoff kick off demo demos " +
    "interview transcript transcripts recording draft final agenda minutes summary report reports leadership leaders staff engineering finance sales marketing product design hr legal ops " +
    "operations board partner partners follow followup retro sprint deck doc docs policy policies contract contracts renewal new old copy version intro catch catchup check checkin onboarding " +
    "offsite workshop session discussion prep debrief audio video zoom meet office hours company group internal external budgeting forecast forecasts lunch dinner breakfast coffee " +
    "everyone speaker " +
    // RT-N5: role words, holidays and product/company names that title-case after "with" but are never a person.
    // Small on purpose: a real name that collides (a person called "Candidate") is still offered from the people
    // list (step 1), which this list never filters.
    "candidate candidates applicant applicants guest guests visitor visitors recruiter recruiters manager managers " +
    "director directors lead leads intern interns contractor contractors consultant consultants founder founders " +
    "ceo cfo cto coo vp svp evp exec execs executive executives investor investors advisor advisors stakeholder stakeholders " +
    "christmas xmas easter thanksgiving halloween hanukkah chanukah diwali eid ramadan passover kwanzaa holiday holidays " +
    "vacation pto birthday anniversary " +
    "microsoft google apple amazon meta fireflies teams slack zoom outlook gmail onedrive sharepoint salesforce jira " +
    "january february march april may june july august september october november december jan feb mar apr jun jul aug sep sept oct nov dec " +
    "monday tuesday wednesday thursday friday saturday sunday mon tue tues wed thu thur thurs fri sat sun today tomorrow yesterday"
  ).split(" "),
);

/** Words after which the next capitalised word(s) may be a person. "/" covers "w/" and "Von / Michael". */
const TRIGGERS = new Set(["with", "and", "&", "/", "1on1", "x", "vs", "vs."]);

/** File extensions stripped before parsing (a title never ends in one of these). */
const EXT = /\.(?:pdf|docx?|pptx?|xlsx?|txt|md|vtt|srt|csv|rtf)$/i;

/** A person-shaped word: Capital + lower-case letters (any script), optional apostrophe, optional ONE inner capital
 *  (McDonald), optional one-letter apostrophe prefix (O'Brien, D'Angelo: RT-N1). All-caps (ACME, S-A14), digits
 *  (Q4, S-A20) and one-letter words are not names. Hyphenated names (Jean-Luc) are joined part by part, see
 *  NAME_HYPHEN. */
const NAME_LIKE = /^(?:\p{Lu}['’](?=\p{Lu}))?\p{Lu}[\p{Ll}'’]*\p{Ll}(?:\p{Lu}[\p{Ll}'’]*\p{Ll})?$/u;

/** A hyphen written INSIDE a word (letter-letter, no spaces) survives tokenizing as this marker token, so a
 *  trigger can rebuild "Jean-Luc" (RT-N1) while every other use of the tokens still sees the hyphen as a
 *  separator ("Priya-budget-notes.docx", S-A6). */
const NAME_HYPHEN = "\u2011";

export interface NameSuggestion {
  /** The people-list spelling when known, else the word(s) as written in the title. */
  name: string;
  /** True when `name` is already on the people list (no "add" needed). */
  known: boolean;
}

export interface NameContext {
  people: readonly string[];
  /** The owner's own name ("Von"): never suggested as a participant (S-A2, S-A12). */
  owner: string;
}

/** Pure: a name -> its comparable form (lower case, periods and _ - read as spaces, whitespace collapsed). */
export function normName(n: unknown): string {
  return String(n ?? "")
    .normalize("NFC")
    .toLowerCase()
    .replace(/[._\-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const firstOf = (n: string) => normName(n).split(" ")[0] ?? "";

/** Pure: strip a possessive and edge punctuation from one raw token ("Michael's" -> "Michael", `Priya"` -> "Priya"). */
function cleanToken(t: string): string {
  return t
    .replace(/^[^\p{L}\p{N}&/]+|[^\p{L}\p{N}&/]+$/gu, "")
    .replace(/['’]s$/u, "");
}

/** Pure: a title or file name -> tokens, with 1:1 / 1-1 / 1 on 1 folded to "1on1" and & / split out. */
export function tokenize(text: unknown): string[] {
  let s = String(text ?? "").normalize("NFC").replace(EXT, "");
  s = s.replace(/_+/g, " ");
  s = s.replace(/(^|[^\p{L}\p{N}])1\s*-?\s*on\s*-?\s*1(?=$|[^\p{L}\p{N}])/giu, "$1 1on1 ");
  s = s.replace(/(^|[^\p{L}\p{N}])1\s*[-:]\s*1(?=$|[^\p{L}\p{N}])/gu, "$1 1on1 ");
  s = s.replace(/(?<=\p{L})-(?=\p{L})/gu, ` ${NAME_HYPHEN} `);
  s = s.replace(/-+/g, " ").replace(/&/g, " & ").replace(/\//g, " / ").replace(/[()[\]{},+<>"“”]/g, " ");
  return s
    .split(/\s+/)
    .map((t) => (t === NAME_HYPHEN ? t : cleanToken(t)))
    .filter(Boolean);
}

/**
 * Pure (S-A): people suggested from a meeting title or a file name, in order of first appearance, no duplicates.
 *  1. Anyone on the people list, by full name or by first name, as whole tokens, case-insensitively (S-A1, S-A16,
 *     S-A19). Two people sharing a first name are BOTH offered, neither picked (S-A21).
 *  2. Up to two person-shaped words right after a trigger (with / and / & / "/" / 1on1 / x / vs) that are not a
 *     common word, month or weekday (S-A5, S-A9, S-A15). A first name that matches the list resolves to the list.
 *  The owner is never offered (S-A2, S-A12).
 */
export function suggestNames(text: unknown, ctx: NameContext): NameSuggestion[] {
  const toks = tokenize(text);
  const low = toks.map((t) => normName(t));
  const ownerFirst = firstOf(ctx.owner);
  const isOwner = (n: string) => normName(n) === normName(ctx.owner);
  const hits: Array<{ pos: number; s: NameSuggestion }> = [];
  const seen = new Set<string>();
  const add = (pos: number, s: NameSuggestion) => {
    const k = normName(s.name);
    if (!k || seen.has(k) || isOwner(s.name)) return;
    seen.add(k);
    hits.push({ pos, s });
  };
  const findSeq = (seq: string[]) => {
    for (let i = 0; i + seq.length <= low.length; i++) if (seq.every((w, j) => low[i + j] === w)) return i;
    return -1;
  };
  const isNameWord = (t: string | undefined) => !!t && NAME_LIKE.test(t) && !STOP.has(t.toLowerCase()) && !TRIGGERS.has(t.toLowerCase());
  const isInitial = (t: string | undefined) => !!t && /^\p{L}$/u.test(t);
  /** RT-N2: the word after a first name names a DIFFERENT person when it is an initial or a surname-shaped word
   *  whose first letter differs from the person's own second part ("Michael T." is not "Michael R."). */
  const conflictsWith = (person: string, next: string | undefined) => {
    const second = normName(person).split(" ")[1];
    if (!second || !(isInitial(next) || isNameWord(next))) return false;
    return normName(next).charAt(0) !== second.charAt(0);
  };

  // 1. Known people. An EXACT full-name match wins its position: a first-name-only match is never offered on top
  //    of it, nor when the next word is a conflicting initial / surname (RT-N2).
  const people = ctx.people.filter((p) => !isOwner(p) && normName(p).split(" ").filter(Boolean).length > 0);
  const exactAt = new Set<number>();
  for (const p of people) {
    const full = normName(p).split(" ").filter(Boolean);
    const pos = findSeq(full);
    if (pos >= 0) {
      exactAt.add(pos);
      add(pos, { name: p, known: true });
    }
  }
  for (const p of people) {
    const full = normName(p).split(" ").filter(Boolean);
    if (findSeq(full) >= 0 || full[0].length <= 1) continue;
    const pos = low.indexOf(full[0]);
    if (pos < 0 || exactAt.has(pos) || conflictsWith(p, toks[pos + 1])) continue;
    add(pos, { name: p, known: true });
  }

  // 2. New names after a trigger.
  const byFirst = (w: string) => ctx.people.filter((p) => !isOwner(p) && firstOf(p) === w);
  for (let i = 0; i < toks.length; i++) {
    if (!TRIGGERS.has(low[i])) continue;
    const parts: string[] = [];
    for (let j = i + 1; j < toks.length && parts.length < 2; j++) {
      const t = toks[j];
      if (!NAME_LIKE.test(t) || STOP.has(t.toLowerCase())) break;
      // "Jean-Luc": a name word, an in-word hyphen, a name word -> ONE part.
      let word = t;
      while (toks[j + 1] === NAME_HYPHEN && toks[j + 2] && NAME_LIKE.test(toks[j + 2]) && !STOP.has(toks[j + 2].toLowerCase())) {
        word = `${word}-${toks[j + 2]}`;
        j += 2;
      }
      parts.push(word);
    }
    if (!parts.length) continue;
    if (normName(parts[0]) === ownerFirst) continue;
    const joined = parts.join(" ");
    const exact = ctx.people.find((p) => normName(p) === normName(joined));
    if (exact) {
      add(i + 1, { name: exact, known: true });
      continue;
    }
    // A known first name was already offered in step 1 (one or several people); never add the raw word too --
    // unless the surname conflicts with EVERY person of that first name (RT-N2): then it is somebody new.
    const sameFirst = byFirst(normName(parts[0]));
    if (sameFirst.length && !(parts.length > 1 && sameFirst.every((p) => conflictsWith(p, parts[1])))) continue;
    add(i + 1, { name: joined, known: false });
  }
  return hits.sort((a, b) => a.pos - b.pos).map((h) => h.s);
}

// ── S-B: Fireflies speaker labels ───────────────────────────────────────────────────────────────────

/** The one bucket for a missing / blank / bare "Speaker" label (S-B3, S-B4). */
export const UNKNOWN_SPEAKER = "Unknown speaker";

export type SpeakerMatch =
  /** No usable label: all such lines share ONE bucket, and the UI warns it may be several people. */
  | { kind: "unknown"; label: typeof UNKNOWN_SPEAKER }
  /** "Speaker 1" / "SPEAKER  4": a numbered voice, kept verbatim, offered for mapping, never auto-mapped. */
  | { kind: "numbered"; label: string }
  /** Matched to exactly one person on the list (pre-mapped, still editable). */
  | { kind: "person"; label: string; person: string }
  /** A first name shared by several people: all offered, none picked. */
  | { kind: "ambiguous"; label: string; candidates: string[] }
  /** A name not on the list (or an email): shown raw, "add" offered, never auto-added. */
  | { kind: "unmatched"; label: string };

/** Pure: the raw label -> the label we store and group by. Blank / bare "Speaker" -> UNKNOWN_SPEAKER (S-B3/S-B4).
 *  Every other label is kept VERBATIM (trimmed), so "Speaker 1" and "Speaker 10" stay separate rows (S-B8). */
export function speakerKey(raw: unknown): string {
  const s = typeof raw === "string" ? raw.trim() : "";
  if (!s || /^speaker$/i.test(s)) return UNKNOWN_SPEAKER;
  return s.slice(0, 120);
}

/** Pure: a label normalised for an EXACT name compare: a trailing "(Guest)"-style note is dropped (S-B9). */
function labelNorm(label: string): string {
  return normName(label.replace(/\s*\([^)]*\)\s*$/, ""));
}

/** Pure (S-B): classify one Fireflies speaker label and match it to the people list. */
export function matchSpeaker(raw: unknown, ctx: NameContext): SpeakerMatch {
  const label = speakerKey(raw);
  if (label === UNKNOWN_SPEAKER) return { kind: "unknown", label: UNKNOWN_SPEAKER };
  if (/^speaker\s*\d+$/i.test(label)) return { kind: "numbered", label };
  if (label.includes("@")) return { kind: "unmatched", label }; // no emails on the people list today (S-B9)
  const n = labelNorm(label);
  const all = [ctx.owner, ...ctx.people.filter((p) => normName(p) !== normName(ctx.owner))];
  const exact = all.find((p) => normName(p) === n);
  if (exact) return { kind: "person", label, person: exact };
  // First name (S-B5 "Von Ellis" -> Von): only when exactly one person has that first name (S-B7).
  // The label's first word split on WHITESPACE only: "Dana-Karina" is not "Dana" (S-B9, no loose match).
  const words = label.replace(/\s*\([^)]*\)\s*$/, "").normalize("NFC").toLowerCase().trim().split(/\s+/);
  const first = words[0].replace(/\.+$/, "");
  // RT-N3: a second word (surname or initial) must agree with the person's own second part, if they have one:
  // "Dana Smith" is not "Dana K.", while "Von Ellis" -> "Von" and "Michael Roberts" -> "Michael R." still match.
  const second = (words[1] ?? "").replace(/[^\p{L}]/gu, "");
  const agrees = (p: string) => {
    const ps = normName(p).split(" ")[1];
    return !second || !ps || ps.charAt(0) === second.charAt(0);
  };
  const byFirst = all.filter((p) => firstOf(p) === first && agrees(p));
  if (byFirst.length === 1) return { kind: "person", label, person: byFirst[0] };
  if (byFirst.length > 1) return { kind: "ambiguous", label, candidates: byFirst };
  return { kind: "unmatched", label };
}
