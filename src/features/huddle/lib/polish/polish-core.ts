// WHAT:       The Polish tool's shared core — writing-profile types, the built-in profiles, the prompt
//             builder for every Polish action, and the word diff the Changes view renders.
// WHY:        Polish (text cleanup: rough draft in, finished copy out) is Huddle's first "tool" module.
//             One pure, dependency-free file so the server function (which builds the prompt — the
//             client never sends raw prompt text) and the offline test read the SAME rules.
// SUPERSEDES: nothing
// SUPERSEDED-BY: nothing -- current
// EVIDENCE:   approved-design source: claude.ai artifact 283e7883 (Refine screens); Huddle-blended
//             prototype claude.ai/artifact/7MJkFX17io8FHmVWwSZCAn; test scripts/polish-core.test.ts

export const POLISH_TONES = [
  "Professional",
  "Warm",
  "Direct",
  "Confident",
  "Casual",
  "Academic",
  "Persuasive",
  "Empathetic",
] as const;
export type PolishTone = (typeof POLISH_TONES)[number];
export type PolishStrength = "light" | "balanced" | "full";
export type PolishLength = "shorter" | "keep" | "longer";
export type PolishFormat = "auto" | "bullets" | "sections";
export type PolishEngine = "fast" | "best";

export interface PolishSettings {
  tones: PolishTone[];
  formality: number; // 1..5
  strength: PolishStrength;
  length: PolishLength;
  format: PolishFormat;
  audience: string;
  rules: string; // one rule per line
  engine: PolishEngine;
}

export interface PolishProfile extends PolishSettings {
  id: string;
  name: string;
  /** true = the user's own profile (synced across devices); built-ins are seeded in code. */
  custom?: boolean;
}

export const STRENGTH_LABEL: Record<PolishStrength, [string, string]> = {
  light: ["Light touch", "Fix errors and smooth the phrasing; keep your own wording and order."],
  balanced: ["Balanced", "Improve clarity and flow; may reorder and rephrase, keeps every point."],
  full: ["Full rewrite", "Rewrite freely for the audience; keeps every fact, name and date."],
};
export const LENGTH_LABEL: Record<PolishLength, string> = {
  shorter: "Shorter",
  keep: "Keep",
  longer: "Longer",
};
export const FORMAT_LABEL: Record<PolishFormat, string> = {
  auto: "Auto",
  bullets: "Bullets",
  sections: "Sections",
};
export const ENGINE_LABEL: Record<PolishEngine, string> = { fast: "Fast", best: "Best" };

/** Seed values only — every field is changeable in Writing settings and can be saved as the user's own. */
export const BUILTIN_PROFILES: PolishProfile[] = [
  {
    id: "work-email",
    name: "Work email",
    tones: ["Professional", "Direct"],
    formality: 4,
    strength: "balanced",
    length: "keep",
    format: "auto",
    audience: "colleagues and stakeholders",
    rules: "Start with a one-line subject.\nEnd with a clear ask if there is one.",
    engine: "fast",
  },
  {
    id: "broadcast",
    name: "Broadcast",
    tones: ["Professional", "Warm"],
    formality: 3,
    strength: "balanced",
    length: "keep",
    format: "sections",
    audience: "the whole team",
    rules: "Lead with what changed and why it matters.",
    engine: "fast",
  },
  {
    id: "linkedin",
    name: "LinkedIn post",
    tones: ["Warm", "Confident"],
    formality: 2,
    strength: "full",
    length: "keep",
    format: "auto",
    audience: "my professional network",
    rules:
      "Short paragraphs.\nEnd with a question to invite comments.\nNo hashtags unless I wrote them.",
    engine: "best",
  },
  {
    id: "article",
    name: "Article",
    tones: ["Confident"],
    formality: 3,
    strength: "balanced",
    length: "longer",
    format: "sections",
    audience: "general readers",
    rules: "Use descriptive headings.",
    engine: "best",
  },
  {
    id: "school",
    name: "School paper",
    tones: ["Academic"],
    formality: 5,
    strength: "light",
    length: "keep",
    format: "auto",
    audience: "my instructor",
    rules: "No contractions.\nKeep my argument and citations exactly as written.",
    engine: "best",
  },
  {
    id: "slack",
    name: "Slack message",
    tones: ["Casual", "Direct"],
    formality: 1,
    strength: "light",
    length: "shorter",
    format: "auto",
    audience: "teammates",
    rules: "No greeting line.\nKeep it to a few lines.",
    engine: "fast",
  },
];

export const QUICK_ACTIONS = [
  "Shorter",
  "Longer",
  "More formal",
  "Friendlier",
  "More confident",
  "Bullet points",
  "Add a call to action",
  "Simplify",
  "Fix grammar only",
] as const;

export const SETTING_KEYS = [
  "tones",
  "formality",
  "strength",
  "length",
  "format",
  "audience",
  "rules",
  "engine",
] as const;

export function settingsDiffer(a: PolishSettings, b: PolishSettings): boolean {
  return SETTING_KEYS.some((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
}

/** Coerce untrusted input (synced blob, request body) into valid settings, falling back to `base`. */
export function normalizeSettings(
  raw: unknown,
  base: PolishSettings = BUILTIN_PROFILES[0],
): PolishSettings {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const pick = <T extends string>(v: unknown, ok: readonly T[], d: T): T =>
    ok.includes(v as T) ? (v as T) : d;
  const tones = Array.isArray(r.tones)
    ? (
        r.tones.filter((t) =>
          (POLISH_TONES as readonly string[]).includes(t as string),
        ) as PolishTone[]
      ).slice(0, 2)
    : base.tones;
  const f = Number(r.formality);
  return {
    tones,
    formality: Number.isFinite(f) ? Math.min(5, Math.max(1, Math.round(f))) : base.formality,
    strength: pick(r.strength, ["light", "balanced", "full"] as const, base.strength),
    length: pick(r.length, ["shorter", "keep", "longer"] as const, base.length),
    format: pick(r.format, ["auto", "bullets", "sections"] as const, base.format),
    audience: typeof r.audience === "string" ? r.audience.slice(0, 200) : base.audience,
    rules: typeof r.rules === "string" ? r.rules.slice(0, 2000) : base.rules,
    engine: pick(r.engine, ["fast", "best"] as const, base.engine),
  };
}

export function settingsSummary(name: string, s: PolishSettings, dirty: boolean): string {
  const p = [
    name,
    s.tones.join(" + ") || "No tone",
    `Formality ${s.formality}/5`,
    STRENGTH_LABEL[s.strength][0],
  ];
  p.push(s.length === "keep" ? "Keep length" : LENGTH_LABEL[s.length]);
  if (s.format !== "auto") p.push(FORMAT_LABEL[s.format]);
  if (s.audience.trim()) p.push("for " + s.audience.trim());
  if (dirty) p.push("unsaved");
  return p.join(" · ");
}

// ---------------------------------------------------------------- prompts

export type PolishRequest =
  | { mode: "polish"; draft: string }
  | { mode: "revise"; text: string; instruction: string }
  | { mode: "span"; text: string; start: number; end: number; instruction: string }
  | { mode: "merge"; draft: string; edited: string };

export const SPAN_OPEN = "⟦";
export const SPAN_CLOSE = "⟧";

export function rulesBlock(name: string, s: PolishSettings): string {
  const fmt = {
    auto: "Choose the format that suits the purpose.",
    bullets: "Use bullet points for lists of items or actions.",
    sections: "Organise into short sections with headings where it helps.",
  }[s.format];
  const len = {
    shorter: "Make it noticeably shorter than the source.",
    keep: "Keep it about the same length as the source.",
    longer: "Expand it somewhat where detail helps; never invent facts.",
  }[s.length];
  const rules = s.rules
    .split("\n")
    .map((r) => r.trim())
    .filter(Boolean);
  return [
    `Purpose: ${name}.`,
    s.audience.trim() ? `Audience: ${s.audience.trim()}.` : "",
    `Tone: ${s.tones.join(" and ") || "neutral"}.`,
    `Formality: ${s.formality} on a 1-5 scale (1 casual, 5 formal).`,
    `Edit strength: ${STRENGTH_LABEL[s.strength][0]}. ${STRENGTH_LABEL[s.strength][1]}`,
    `Length: ${len}`,
    `Format: ${fmt}`,
    rules.length
      ? "The writer's own rules (always follow):\n" + rules.map((r) => "- " + r).join("\n")
      : "",
    "Keep every fact, name, number, date and commitment from the source. Never invent details. Write in the writer's voice.",
    "Use plain text that pastes cleanly anywhere: no Markdown headings with #, no **bold**. Bullets may use •.",
    "Reply with ONLY the finished text. No preamble, no explanation, no quotes around it.",
  ]
    .filter(Boolean)
    .join("\n");
}

/** System instructions + user input for one Polish call. Pure; the server sends exactly this. */
export function buildPolishPrompt(
  name: string,
  s: PolishSettings,
  req: PolishRequest,
): { system: string; input: string } {
  const system = `You are Polish, a writing assistant inside Huddle. You turn the writer's rough text into finished copy they will copy and paste somewhere else.\n\n${rulesBlock(name, s)}`;
  switch (req.mode) {
    case "polish":
      return {
        system,
        input: `Polish this DRAFT into finished copy.\n\nDRAFT:\n<<<\n${req.draft}\n>>>`,
      };
    case "revise":
      return {
        system,
        input: `Revise the TEXT following the INSTRUCTION. Change only what the instruction calls for.\n\nINSTRUCTION: ${req.instruction}\n\nTEXT:\n<<<\n${req.text}\n>>>`,
      };
    case "span": {
      const marked =
        req.text.slice(0, req.start) +
        SPAN_OPEN +
        req.text.slice(req.start, req.end) +
        SPAN_CLOSE +
        req.text.slice(req.end);
      return {
        system,
        input: `In the TEXT, one passage is marked between ${SPAN_OPEN} and ${SPAN_CLOSE}. Rewrite ONLY that passage following the INSTRUCTION so it still fits the text around it.\n\nINSTRUCTION: ${req.instruction}\n\nTEXT:\n<<<\n${marked}\n>>>\n\nReply with ONLY the replacement for the marked passage, without the ${SPAN_OPEN} ${SPAN_CLOSE} marks.`,
      };
    }
    case "merge":
      return {
        system,
        input: `The writer changed their DRAFT after hand-editing an earlier polished version (EDITED). Produce an updated polished version that reflects the new DRAFT while keeping the writer's hand edits wherever they still apply.\n\nDRAFT:\n<<<\n${req.draft}\n>>>\n\nEDITED:\n<<<\n${req.edited}\n>>>`,
      };
  }
}

/** Strip wrappers a model sometimes echoes back (the <<< >>> fences, span marks, surrounding quotes). */
export function cleanModelText(t: string, mode: PolishRequest["mode"]): string {
  let s = t
    .replace(/^\s*<<<\s*/, "")
    .replace(/\s*>>>\s*$/, "")
    .trim();
  if (mode === "span") s = s.split(SPAN_OPEN).join("").split(SPAN_CLOSE).join("");
  if (/^".*"$/s.test(s) && !s.slice(1, -1).includes('"')) s = s.slice(1, -1);
  return s;
}

/** Final full text after a call: a span replacement is spliced back; every character outside it is kept. */
export function applyResult(req: PolishRequest, modelText: string): string {
  const t = cleanModelText(modelText, req.mode);
  if (req.mode === "span") return req.text.slice(0, req.start) + t + req.text.slice(req.end);
  return t;
}

// ---------------------------------------------------------------- word diff

export type DiffPart = { kind: "same" | "add" | "del"; text: string };

/** Word-level diff (LCS over words + whitespace). Falls back to "all added" when inputs are huge. */
export function wordDiff(a: string, b: string): DiffPart[] {
  const A = a.split(/(\s+)/).filter(Boolean);
  const B = b.split(/(\s+)/).filter(Boolean);
  const n = A.length;
  const m = B.length;
  if (n * m > 1_600_000) return [{ kind: "add", text: b }];
  const dp: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  // 1. Raw token ops from the LCS.
  type Op = { kind: DiffPart["kind"]; tok: string };
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) {
      ops.push({ kind: "same", tok: A[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ kind: "del", tok: A[i] });
      i++;
    } else {
      ops.push({ kind: "add", tok: B[j] });
      j++;
    }
  }
  while (i < n) ops.push({ kind: "del", tok: A[i++] });
  while (j < m) ops.push({ kind: "add", tok: B[j++] });

  // 2. Group into readable chunks. A run of unchanged words only counts as an anchor when it holds at
  //    least two words; a lone shared "the"/"to" between two edits is folded into the edit, so a
  //    rewritten sentence reads as "old phrase → new phrase" instead of a confetti of tiny marks.
  const out: DiffPart[] = [];
  const push = (kind: DiffPart["kind"], text: string) => {
    if (!text) return;
    const last = out[out.length - 1];
    if (last && last.kind === kind) last.text += text;
    else out.push({ kind, text });
  };
  const isWs = (t: string) => /^\s+$/.test(t);
  let del = "";
  let add = "";
  const flush = () => {
    const d = del.trim();
    if (d) push("del", d + " ");
    push("add", add);
    del = "";
    add = "";
  };
  let k = 0;
  while (k < ops.length) {
    if (ops[k].kind !== "same") {
      const o = ops[k++];
      if (o.kind === "del") del += isWs(o.tok) ? " " : o.tok;
      else add += o.tok;
      continue;
    }
    let e = k;
    while (e < ops.length && ops[e].kind === "same") e++;
    const run = ops
      .slice(k, e)
      .map((o) => o.tok)
      .join("");
    const words = run.split(/\s+/).filter(Boolean).length;
    const between = (del || add) && e < ops.length;
    if (between && words < 2) {
      del += run;
      add += run;
    } else {
      flush();
      push("same", run);
    }
    k = e;
  }
  flush();
  return out;
}

export function wordCount(t: string): number {
  const s = t.trim();
  return s ? s.split(/\s+/).length : 0;
}
