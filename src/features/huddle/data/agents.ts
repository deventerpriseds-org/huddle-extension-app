import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/inter/700.css";

// Real avatar images, served directly from public/agents/ (Vite/Azure SWA serve public/ at the
// site root). Previously these were .asset.json pointers into Lovable's internal preview hosting
// (/__l5e/assets-v1/...), which 404s on the actual deployed app — see ACT-huddle-2 in actions.md.

export type AgentId =
  | "terry-locke"
  | "iris-chase"
  | "tess-sutton"
  | "finn-reid"
  | "faith-hartley"
  | "elle-rowan"
  | "flex-grimes"
  | "ezra-miles"
  | "sam-trent"
  | "cole-blake"
  | "charleston-lewis"
  | "eli-vaughn"
  | "liam-kingsley"
  | "cam-post"
  | "troy-lennox";

export type AgentTone = "warm" | "direct" | "coach" | "wry" | "formal";

/**
 * An EXCLUSIVE capability: a specific responsibility (usually backed by a tool or
 * authority) that only the owning agent may perform. It is the data-driven backbone
 * of ownership-aware handoff — no agent name is hardcoded anywhere in the runtime;
 * "who owns grooming" is answered by reading this field. Add a capability here and it
 * automatically flows into the roster surfaced to every agent, the router's ownership
 * rule, and the scope-aware hand-off behaviour — for EVERY agent, no per-case code.
 *
 * Distinct from `domains`/`themes`, which are broad ROUTING lanes (topics an agent is
 * good at). A capability is a narrow, exclusive POWER others must hand off, not merely
 * a lane they could also speak to.
 */
export interface AgentCapability {
  /** stable id, e.g. "backlog-grooming". */
  id: string;
  /** human phrase used in prompts and the roster, e.g. "backlog grooming, triage & sprint/board assignment". */
  label: string;
  /** true = only the owning agent may perform it; every other agent must hand off. */
  exclusive?: boolean;
  /**
   * Lowercase phrases that indicate the user is asking for THIS capability. Used for DETERMINISTIC
   * 1:1 hand-off detection (the runtime resolves the owner without depending on the LLM or an @mention)
   * — needed because domain/theme scoring can mis-assign (e.g. "backlog" scores to the product owner,
   * not the scrum master). A substring match on any trigger routes the ask to this capability's owner.
   */
  triggers?: string[];
  /**
   * CO-OCCURRENCE triggers, for asks no single phrase identifies without over-matching: each pair is
   * [nouns, cues] and fires when ANY noun AND ANY cue both appear as words ("strategy PAPER ... DUE
   * date" fires; "buy paper towels" does not). Read only for NON-exclusive (shared) capabilities --
   * see `sharedCapabilityMatches` in lib/capabilities.ts.
   */
  triggerPairs?: Array<[string[], string[]]>;
  /**
   * SHARED capabilities only: an ADVISORY line for the LLM routers (group router + 1:1 owner resolver),
   * printed after the holders' names in `primeOwnershipDirectory` (lib/capabilities.ts). It says, in plain
   * words, which asks this capability's holders should LEAD and which merely-related asks stay with their
   * own lane. Prose for a model, never matched against text. Name lanes here, not agents -- the holders'
   * names come from the roster.
   */
  routerHint?: string;
  /**
   * SHARED capabilities only: the ask must ALSO carry this context, or no trigger counts. A trigger
   * word says WHAT kind of job ("assignment", "deliverable", "paper ... due"); the context says WHOSE
   * job -- without it "change my seat assignment on the flight" and "the client deliverable is due"
   * were captured (W19/W20, docs/FIX-nexus-write-redteam.md). STRONG context always counts; WEAK
   * context counts only when no VETO word (another lane's unmistakable vocabulary) is present.
   * Words are whole-word, case-insensitive; patterns are [source, flags] RegExp pairs.
   */
  requiresContext?: {
    strong?: string[];
    strongPatterns?: Array<[string, string]>;
    /**
     * Named DATA sources that count as strong context (lib/capabilities.ts CONTEXT_SOURCES), e.g.
     * "nexus-courses" = the text names one of the owner's REAL Nexus courses. Data, not a shape regex.
     */
    strongSources?: string[];
    weak?: string[];
    weakPatterns?: Array<[string, string]>;
    /** [nouns, cues]: weak context when any noun AND any cue appear as whole words. */
    weakPairs?: Array<[string[], string[]]>;
    /**
     * Evaluated BEFORE the vetoes: an EXPLICIT request naming this capability's own system as the destination
     * ("add … to Nexus", "update … in Nexus") is this capability's job even when its topic carries another
     * lane's veto word ("the email marketing case analysis", "my travel industry essay"). [source, flags] pairs.
     */
    explicitOverride?: Array<[string, string]>;
    /** Evaluated after `explicitOverride`, before everything else: any veto word/pattern means "not this capability's job", even over strong context. */
    vetoes?: string[];
    vetoPatterns?: Array<[string, string]>;
    /** Phrases removed before matching ("of course" is not a course). */
    ignore?: string[];
  };
  /**
   * SHARED capabilities only: when the deterministic 1:1 hand-off may fire from a NON-holder to a holder
   * (routing.ts `primeLaneDecision` -> the "not your lane" directive + the durable follow-up DM).
   *   "always" (default)    -- whenever the ask matches the capability (triggers + context).
   *   "explicit-override"   -- ONLY when the ask also matches `requiresContext.explicitOverride` (an explicit
   *                            write to the capability's own system). Any other matching ask in a 1:1 with a
   *                            non-holder falls through to the ordinary 1:1 owner logic (keyword laneOwnerFor
   *                            directive + LLM owner judge). Holders still KEEP every matching ask; the GROUP
   *                            leader rule is unaffected. docs/FIX-nexus-write-loop4.md (D13).
   */
  oneToOneHandoff?: "always" | "explicit-override";
}

/**
 * A SHARED (non-exclusive) capability several agents are PRIME for. Unlike an exclusive one, every
 * agent may still perform it (its tool stays in the common pool); "prime" only decides who LEADS
 * when the ask matches -- the deterministic router picks a holder, and a holder is never handed off
 * from in a 1:1. Defined ONCE here and attached to each prime agent, so the triggers cannot drift.
 */
// "Nexus" is the APP only when NOT followed by one of these (the NEXUS trusted-traveler card/program). ONE list,
// used by the strong "Nexus as the app" pattern AND the explicit override below, so they cannot drift.
// "trusted|traveler|traveller" added 2026-10-29 (docs/FIX-nexus-write-routing.md, "Explicit Nexus override"):
// "update my address in NEXUS trusted traveler" was read as Nexus-the-app.
// Group-veto rows (docs/FIX-nexus-write-loop4.md, "Group-veto rows"): the NEXUS trusted-traveler PROGRAM's own
// vocabulary. ONE list, used twice: (1) right after "Nexus" (the lookahead below), and (2) anywhere in the SAME
// clause as "Nexus", before or after it (`NEXUS_PROGRAM_CLAUSE`, a veto on the coursework capability) -- because
// "update my address in NEXUS before my next border crossing", "reschedule my interview in NEXUS" and "change my
// vehicle info in my NEXUS account" put the program word away from, or before, "Nexus", and the strong "in (my)
// Nexus" pattern then made Iris lead the GROUP instead of origin/main's Eli / Cole / Ezra.
const NEXUS_PROGRAM_WORDS = [
  "account", "passport", "vehicle", "membership", "renewal", "interview", "enrollment", "enrolment", "global entry",
  "border",
];
const NEXUS_PROGRAM_ALT = NEXUS_PROGRAM_WORDS.map((w) => w.replace(/ /g, "\\s+")).join("|");
const NEXUS_NOT_THE_APP =
  `(?!\\s+(?:card|cards|program|programme|membership|application|interview|pass|lane|fitness|tracker|trusted|traveler|traveller|${NEXUS_PROGRAM_ALT}))`;
const NEXUS_PROGRAM_CLAUSE =
  `\\bnexus\\b[^.?!;\\n]{0,80}?\\b(?:${NEXUS_PROGRAM_ALT})\\b|\\b(?:${NEXUS_PROGRAM_ALT})\\b[^.?!;\\n]{0,80}?\\bnexus\\b`;
// EXPLICIT Nexus write (owner, 2026-10-29): a write verb opening a clause (optionally after a greeting, a vocative
// and "please / can you / I need you to …"), whose object goes TO / IN / INTO (my) Nexus, or onto "Nexus
// assignment(s)". Clause-initial on purpose: "email my professor that I will add the essay to Nexus" and "is Nexus
// down? I can't add the essay" are not requests to write. "the nexus of X and Y" never matches (no "the").
// D13-ovr (docs/FIX-nexus-write-loop4.md, RESPONDS TO VERIFY-nexus-write-tool-4.md): the override needs an ASSIGNMENT
// OBJECT -- one of these coursework nouns between the write verb and "to/in/into Nexus" (or the destination "Nexus
// assignments" itself). Without it "add my new passport number to NEXUS", "change my vehicle info in my NEXUS account"
// and "set a reminder to log into Nexus tonight" overrode Troy's / Eli's lanes. Each entry is a regex fragment matched
// as a whole word (plural "s"/"es" tolerated by the entry itself).
const NEXUS_ASSIGNMENT_OBJECTS = [
  "assignments?", "papers?", "essays?", "proposals?", "case stud(?:y|ies)", "case analys[ie]s", "cases?",
  "analys[ie]s", "memos?", "reflections?", "posts?", "quiz(?:zes)?", "exams?", "projects?", "presentations?",
  "problem sets?", "deliverables?", "briefs?", "reviews?", "reports?", "due dates?",
];
const NEXUS_EXPLICIT_WRITE =
  "(?:^|[.!?;:\\n]\\s*|\\b(?:and|then)\\s+)" +
  "(?:(?:hey|hi|ok|okay|so)\\s+)?(?:[a-z]+\\s*,\\s*)?" +
  "(?:(?:please|pls|kindly|just|also|now|go ahead and|can you|could you|would you|will you|can u|i need you to|i want you to|i'd like you to|i need to|i want to|let's|lets|help me)\\s+)*" +
  "(?:add|put|log|save|enter|record|update|change|move|reschedule|set)\\b" +
  "(?:" +
  // (a) an assignment object, then the destination "to / in / into (my) Nexus" (the app, never the NEXUS program)
  `[^.?!;\\n]{0,80}?\\b(?:${NEXUS_ASSIGNMENT_OBJECTS.join("|")})\\b[^.?!;\\n]{0,80}?` +
  `\\b(?:to|in|into)\\s+(?:my\\s+)?nexus\\b${NEXUS_NOT_THE_APP}` +
  // (b) or the destination itself names the object: "… to my Nexus assignments"
  "|[^.?!;\\n]{0,100}?\\bnexus\\s+assignments?\\b" +
  ")";
const NEXUS_ASSIGNMENTS_CAPABILITY: AgentCapability = {
  id: "nexus-assignments",
  label: "adding & updating the owner's coursework assignments in Nexus (dated, graded deliverables)",
  exclusive: false,
  // WHAT kind of job: an assignment-shaped word. Deliberately broad -- `requiresContext` below is what
  // keeps it to HIS coursework.
  triggers: [
    "assignment", "syllabus", "syllabi", "deliverable", "nexus", "coursework", "course work",
    "research paper", "research proposal", "term paper", "final paper",
    "paper", "essay", "thesis", "dissertation", "case analysis", "case study", "case brief", "proposal",
    "midterm", "exam", "homework", "quiz", "due", "deadline",
  ],
  triggerPairs: [
    [
      ["paper", "papers", "essay", "essays", "thesis", "dissertation", "case brief", "midterm"],
      ["due", "deadline", "deadlines", "graded", "grade", "submit", "submission"],
    ],
  ],
  // (A) of the owner's 2026-10-29 decision (docs/FIX-nexus-write-routing.md): the LLM routers are told who LEADS
  // adding/updating his Nexus coursework, and that an ask merely MENTIONING a course stays in its own lane.
  routerHint:
    "they are the preferred owners whenever the owner asks to ADD or UPDATE his Nexus coursework assignments " +
    "(a dated, graded deliverable for one of his courses, a syllabus to load into Nexus, a due date to change, " +
    "what is due in Nexus). Other lanes keep asks that merely MENTION a course, a professor or a deadline: " +
    "emailing or messaging a professor (email lane), booking travel, lodging or a rental car for a residency " +
    "(travel lane), budgeting tuition, a deposit or a textbook purchase (finance lane), scheduling study time " +
    "or a reminder (calendar lane), dinner after an exam (dining lane), training around exam week (fitness lane). " +
    "An EXPLICIT request to add, put, log, save, update, change, move or reschedule something TO, IN or INTO Nexus " +
    "is theirs even when its topic names another lane (an email marketing case analysis, a travel industry essay, " +
    "an Airbnb pricing case study) -- provided the thing written is an assignment (a paper, essay, case study, " +
    "proposal, exam, project, due date …); a passport number, a NEXUS-program account or a reminder to log into " +
    "Nexus is not.",
  // WHOSE job: the owner's coursework. Loop 3 (D6, docs/FIX-nexus-write-loop3.md, owner-specified):
  //   VETOES are evaluated FIRST and win (another lane's unmistakable vocabulary).
  //   STRONG = DATA FROM NEXUS -- one of the owner's REAL course codes or names (`strongSources:
  //     ["nexus-courses"]`, filled from get_nexus_courses' read path) -- or the explicit words "syllabus"/
  //     "syllabi", or "Nexus" used as the APP ("due in Nexus", "Nexus assignments", "add … to Nexus"),
  //     never "NEXUS card"/"NEXUS program"/"apply to NEXUS". The loop-2 GENERIC course-code regex is
  //     deleted (it read UA 902, DS-160, IRS 941 and NVDA 200 as courses), and mba/dba/instructor/
  //     professor are no longer strong (an MBA loan, a DBA filing, a yoga instructor).
  //   WEAK (veto-able) = degree/teacher words, "my assignment(s)", deliverable + deadline cue.
  // Generic words are NOT context at all: "course", "class", "semester", "tuition", "thesis", "case study".
  requiresContext: {
    strong: ["syllabus", "syllabi"],
    strongSources: ["nexus-courses"],
    strongPatterns: [
      // "Nexus" as the APP: "Nexus assignments", "in/on/from/into (my) Nexus", or a write verb "… to Nexus"
      // -- never followed by card/program/membership/application/interview/pass/lane/fitness/tracker.
      [
        `\\bnexus assignments?\\b|\\b(?:in|on|from|into) (?:my )?nexus\\b${NEXUS_NOT_THE_APP}|\\b(?:add|put|log|save|enter|record|sync|upload|import)\\b[^.?!]{0,60}?\\bto (?:my )?nexus\\b${NEXUS_NOT_THE_APP}`,
        "i",
      ],
    ],
    // Checked BEFORE the vetoes (owner, 2026-10-29): "add the MGT-782 email marketing case analysis to Nexus",
    // "put my travel industry essay due Nov 3 into Nexus", "update the Airbnb pricing case study due date in Nexus".
    explicitOverride: [[NEXUS_EXPLICIT_WRITE, "i"]],
    weak: ["coursework", "course work", "emba", "mba", "dba", "doctoral", "professor", "prof", "instructor"],
    weakPatterns: [
      // "my assignment", "my assignments", "my school assignments" (a veto word keeps "my seat assignments")
      ["\\bmy assignment\\b|\\bmy (?:[a-z]+ )?assignments\\b", "i"],
    ],
    // a graded deliverable + a deadline/grading cue: "the due date on my strategy paper", "my research
    // proposal deadline". A bare "due" is not a cue ("the merger proposal due Friday").
    weakPairs: [[
      ["paper", "papers", "essay", "essays", "research proposal", "case analysis", "case study", "case brief", "thesis", "dissertation", "midterm"],
      ["due date", "deadline", "deadlines", "graded", "grade", "submit", "submission"],
    ]],
    vetoes: [
      // travel
      "flight", "flights", "airline", "airlines", "check-in", "check in", "checkin", "boarding", "visa", "visas",
      "passport", "seat", "trip", "hotel",
      // money / tax / business filings / work
      "loan", "loans", "mortgage", "irs", "tax", "taxes", "llc", "filing", "job", "payroll", "invoice", "invoices",
      "client", "clients", "customer", "boss", "quarterly",
      // markets
      "calls", "puts", "options", "stock", "stocks", "shares", "ticker", "strike",
      // fitness
      "yoga", "gym", "fitness", "workout",
      // household (loop 1/2)
      "toilet", "towel", "towels", "card", "kid", "kids", "son", "daughter", "child", "grocery", "groceries", "golf",
      // ── D12 (docs/FIX-nexus-write-routing.md, RESPONDS TO VERIFY-nexus-write-tool-3.md): asks that merely
      // MENTION a course / professor / deadline but belong to ANOTHER lane. Owner decision 2026-10-29: these keep
      // their origin/main routing and never trigger the deterministic 1:1 hand-off. One group per lane:
      // email / messaging
      "email", "e-mail", "emailed", "emailing", "message", "messaged", "messaging", "inbox",
      // calendar / reminders
      "remind", "reminder",
      // dining
      "restaurant", "dinner", "lunch", "breakfast", "brunch", "eat", "eating", "reservation", "book a table",
      "reserve a table",
      // dining / food -- group-veto rows (docs/FIX-nexus-write-loop4.md): "plan my meals for MGT-782 exam week",
      // "meal prep …", "what should I cook …" with a real course code made Iris lead the GROUP instead of
      // Charleston / Tess. ("grocery"/"groceries" are also in the household group above; listed here too so the
      // food lane's vocabulary is complete in one place.)
      "meal", "meals", "meal prep", "cook", "cooking", "recipe", "groceries", "grocery", "snack",
      // car rental / driving
      "rent a car", "rental car", "car rental", "rent-a-car", "uber", "lyft", "taxi",
      // lodging
      "airbnb", "lodging", "hotels", "motel", "hostel", "accommodation", "accommodations",
      // money / budget / purchases
      "budget", "budgeting", "afford", "deposit", "payment", "pay", "paying", "tuition", "buy", "buying",
      "purchase", "purchasing", "price", "spend", "spending", "refund",
      // running / training
      "runs", "running", "jog", "jogging", "marathon", "5k", "10k", "training plan", "training schedule",
      // travel
      "travel", "traveling", "travelling", "airport", "itinerary", "fly", "flying",
    ],
    vetoPatterns: [
      // a ticker written as a cashtag ("$NVDA")
      ["\\$[A-Za-z]{1,5}\\b", ""],
      // the NEXUS trusted-traveler program named in the same clause as "Nexus" (group-veto rows, see
      // NEXUS_PROGRAM_WORDS). The explicit override (an assignment object written to Nexus) is checked first.
      [NEXUS_PROGRAM_CLAUSE, "i"],
      // D12 email / messaging: "write to my professor", "text my instructor" -- never "write to Nexus"
      ["\\bwrite (?:a (?:note|letter|message) )?to (?!(?:my )?nexus\\b)|\\btext (?:my|the|him|her|them)\\b", "i"],
      // D12 calendar: his OWN calendar or a time block ("on my calendar", "block two hours", "schedule focus
      // time", "study time") -- a bare "calendar" is not vetoed ("the course calendar" in a syllabus is coursework)
      [
        "\\b(?:on|to|in|into|onto|from|off) my calendar\\b|\\bcalendar (?:invite|event|hold|block)s?\\b|\\bblock (?:off |out )?(?:some |an? |one |two |three |four |\\d+ )?(?:hours?|minutes?|mins?|time|morning|afternoon|evening)\\b|\\b(?:focus|study|deep work|prep) (?:time|block|session)s?\\b|\\bschedule (?:some |an? |one |two |three |\\d+ )?(?:time|hours?|minutes?|session|block)s?\\b",
        "i",
      ],
      // D12 driving: "drive to/from campus", "drive me" -- never "(Google|my|the|shared) Drive" (where a syllabus
      // may live: "upload the syllabus from my Google Drive to Nexus") and never "… to Nexus"
      [
        "(?<!\\b(?:google|my|the|a|shared|team|one)\\s)\\b(?:drive|driving) (?:to (?!(?:my )?nexus\\b)|from|me|us|down|up|over|back|home)",
        "i",
      ],
      // D12 lodging: "a place to stay", "stay near campus" -- never "stay on top of my assignments"
      ["\\b(?:place|somewhere|where) to stay\\b|\\bstay(?:ing)? (?:at|near|in|with|overnight)\\b", "i"],
      // D12 money: "cost(s)" -- never a cost-benefit / cost-accounting / cost-of-capital paper topic
      ["\\bcosts?\\b(?![- ](?:benefit|accounting|analysis|of capital|structure|leadership|center|centre)\\b)", "i"],
      // D12 fitness: "go for a run", "a 5 mile run", "run schedule" -- never "run a regression"
      ["\\b(?:go|went|going) for a run\\b|\\b\\d+\\s?(?:k|km|mi|mile|miles) run\\b|\\brun(?:ning)? (?:plan|schedule)\\b", "i"],
    ],
    ignore: ["of course"],
  },
  // D13 (docs/FIX-nexus-write-loop4.md, owner decision): the deterministic coursework rule keeps deciding the GROUP
  // leader, and Elle/Iris keep every coursework ask addressed to them; but a 1:1 with ANY OTHER agent is handed to
  // them deterministically ONLY on an explicit write to Nexus (`explicitOverride`). Everything else there takes the
  // ordinary 1:1 owner path, as on origin/main.
  oneToOneHandoff: "explicit-override",
};

export interface Agent {
  id: AgentId;
  name: string;
  handle: string;
  role: string;
  initials: string;
  colorVar: string; // css var for --agent-*
  domains: string[];
  themes: string[];
  tone: AgentTone;
  voiceId: string;
  special?: "coordinator" | "standup-host" | "queue-owner";
  /** Exclusive powers this agent owns (data-driven ownership; see AgentCapability). */
  capabilities?: AgentCapability[];
  systemPrompt: string;
  avatarUrl?: string;
}

const p = (role: string, tone: string, bounds: string) =>
  `You are ${role}. Voice: ${tone}. Stay strictly in your lane — ${bounds}. Use sentence case, no emoji, no headings. Keep replies to 1–3 short sentences unless the user asks for detail. If a question is outside your lane, keep it to one short line and @mention the right specialist by their handle (e.g. @charleston-lewis) — the mention itself is the handoff, don't narrate it.`;

export const AGENTS: Agent[] = [
  {
    id: "terry-locke",
    name: "Terry Locke",
    handle: "terry-locke",
    role: "Scrum master",
    initials: "TL",
    colorVar: "--agent-slate",
    domains: ["ceremonies", "sprint", "retro", "review", "cadence", "timeboxes", "impediments", "standups", "process"],
    themes: ["standup", "sprint planning", "review", "retro", "burndown", "unblock", "impediment", "timebox", "cadence", "ceremony", "check-in"],
    capabilities: [
      {
        id: "backlog-grooming",
        label: "backlog grooming, triage & sprint/board assignment",
        exclusive: true,
        triggers: [
          "groom", "grooming", "triage the backlog", "triage backlog", "assign the backlog",
          "assign the team", "plan the sprint", "sprint planning", "prioritize the backlog",
          "organize the backlog", "clean up the backlog",
        ],
      },
    ],
    tone: "direct",
    voiceId: "pFZP5JQG7iQjIQuC4Bku",
    avatarUrl: "/agents/terry-locke.jpg",
    systemPrompt: p(
      "Terry Locke, the scrum master who runs the team's process and cadence",
      "measured, briefing-style, no fluff",
      "you facilitate standups, sprint planning, reviews and retros, hold the cadence and timeboxes, and actively remove impediments — surface who is blocking what and drive it to unblocked. You do NOT set priorities or own delivery — that's the team lead @iris-chase. Do NOT narrate handoffs or say 'I'll hand this to X'. Only @mention another agent when the question is genuinely outside your lane (specific finance numbers, meal plans, workouts, etc.)",
    ),
  },
  {
    id: "iris-chase",
    name: "Iris Chase",
    handle: "iris-chase",
    role: "Team lead",
    initials: "IC",
    colorVar: "--agent-teal",
    domains: ["itinerary", "day plans", "calendar", "schedule", "queue", "tasks", "board", "follow-ups", "priorities", "delivery", "status"],
    themes: ["day-of", "schedule of the day", "calendar", "meeting", "appointment", "backlog", "up next", "done", "kanban", "board", "assign", "due", "follow-up", "prioritize", "what matters", "what's next", "status"],
    tone: "warm",
    voiceId: "0fbdXLXuDBZXm2IHek4L",
    special: "coordinator",
    // PRIME (not exclusive) for Nexus assignment writes -- owner, 2026-10-28: "the nexus tool should
    // be among a pool of tools but elle and iris should be prime to use it immediately if i request it."
    capabilities: [NEXUS_ASSIGNMENTS_CAPABILITY],
    avatarUrl: "/agents/iris-chase.jpg",
    systemPrompt: p(
      "Iris Chase, the team lead who owns the day plan, calendar and shared task board",
      "warm, orderly, day-of-focused",
      "you build the day plan, itinerary, calendar and schedule, own the task board — moving cards, noting owners, tracking follow-ups and keeping lanes honest — run delivery and report status, and you prioritize the user's everyday and life work (fitness, family, errands, career, travel, personal finance): you decide what matters next. Product and app decisions go to @tess-sutton and business/venture decisions go to @sam-trent; not finances detail or long-term strategy yourself",
    ),
  },
  {
    id: "finn-reid",
    name: "Finn Reid",
    handle: "finn-reid",
    role: "Finance Strategist",
    initials: "FR",
    colorVar: "--agent-emerald",
    domains: ["budgeting", "credit optimization", "loans", "refinancing", "runway", "cashflow"],
    themes: ["budget", "credit", "soft-pull", "refinance", "runway", "invoice", "spend", "finance", "payment", "money", "transfer", "funds"],
    tone: "direct",
    voiceId: "MEiBY6lrwud0dREUa5FQ",
    avatarUrl: "/agents/finn-reid.jpg",
    systemPrompt: p(
      "Finn Reid, the finance strategist",
      "professional and precise, with financial clarity and logic",
      "you advise on budgeting, credit optimization, soft-pull loans, refinancing and runway planning — never career or health advice",
    ),
  },
  {
    id: "faith-hartley",
    name: "Faith Hartley",
    handle: "faith-hartley",
    role: "Family scheduler",
    initials: "FH",
    colorVar: "--agent-rose",
    domains: ["family", "family members", "kids", "spouse", "family appointments"],
    themes: ["dentist", "school", "kids", "spouse", "family event", "pickup", "childcare"],
    tone: "warm",
    voiceId: "TgnhEILA8UwUqIMi20rp",
    avatarUrl: "/agents/faith-hartley.jpg",
    systemPrompt: p(
      "Faith Hartley, the family scheduler",
      "warm, practical, calendar-native",
      "you handle family and family-member matters only — kids, spouse, family appointments and events; anything not specifically about family goes to the right specialist",
    ),
  },
  {
    id: "elle-rowan",
    name: "Elle Rowan",
    handle: "elle-rowan",
    role: "EMBA planner",
    initials: "ER",
    colorVar: "--agent-violet",
    domains: ["coursework", "essays", "deadlines", "applications"],
    // The builder's extra themes ("assignments", "syllabus", "deliverables", "due date") are NOT kept:
    // topic scoring has no coursework context, so they sent "my tax papers are due" and "toilet paper
    // is due for restock" to Elle (W19). Coursework asks reach her through the context-gated PRIME
    // capability below instead. Back to the origin/main 4809e2e themes.
    themes: ["EMBA", "essay", "draft", "professor", "submit", "education", "school", "course", "program", "degree", "studies"],
    tone: "coach",
    voiceId: "hGQkZQUA5RiOXIw7P9iO",
    // PRIME (not exclusive) for Nexus assignment writes -- see NEXUS_ASSIGNMENTS_CAPABILITY above.
    capabilities: [NEXUS_ASSIGNMENTS_CAPABILITY],
    avatarUrl: "/agents/elle-rowan.jpg",
    systemPrompt: p(
      "Elle Rowan, the EMBA planner",
      "coach-like, structured",
      "you keep coursework, essays and application deadlines on track",
    ),
  },
  {
    id: "flex-grimes",
    name: "Flex Grimes",
    handle: "flex-grimes",
    role: "Fitness coach",
    initials: "FG",
    colorVar: "--agent-lime",
    domains: ["workouts", "recovery", "training", "health"],
    themes: ["push-pull", "sets", "cardio", "run", "cooldown", "PR"],
    tone: "coach",
    voiceId: "pDxcmDdBPmpAPjBko2mF",
    avatarUrl: "/agents/flex-grimes.jpg",
    systemPrompt: p(
      "Flex Grimes, the fitness coach",
      "energetic, terse, coach-style",
      "you program workouts, recovery, and training — nothing medical",
    ),
  },
  {
    id: "ezra-miles",
    name: "Ezra Miles",
    handle: "ezra-miles",
    role: "Errands",
    initials: "EM",
    colorVar: "--agent-amber",
    domains: ["errands", "home", "pickups", "deliveries"],
    themes: ["pharmacy", "dry-cleaning", "groceries pickup", "package", "car", "vehicle", "repair", "drop-off", "appointment"],
    tone: "direct",
    voiceId: "8kvxG72xUMYnIFhZYwWj",
    avatarUrl: "/agents/ezra-miles.jpg",
    systemPrompt: p(
      "Ezra Miles, the errand runner",
      "clipped, logistics-first",
      "you plan and confirm pickups, drop-offs and small home tasks",
    ),
  },
  {
    id: "sam-trent",
    name: "Sam Trent",
    handle: "sam-trent",
    role: "Startup planner",
    initials: "ST",
    colorVar: "--agent-sky",
    domains: ["startup", "MVP", "fundraising", "pitch", "GTM", "business model"],
    themes: ["seed", "deck", "raise", "investor", "launch", "mvp", "idea", "validate", "revenue"],
    tone: "direct",
    voiceId: "0a8UYbCjeq4J2VKVWGdJ",
    avatarUrl: "/agents/sam-trent.jpg",
    systemPrompt: p(
      "Sam Trent, the startup planner who turns ideas into MVPs, pitches and a fundable business",
      "sharp, opinionated, founder-mode",
      "you shape the MVP, the pitch and go-to-market and drive fundraising — the startup and business around a product; what to actually build and product priorities go to @tess-sutton",
    ),
  },
  {
    id: "cole-blake",
    name: "Cole Blake",
    handle: "cole-blake",
    role: "Career coach",
    initials: "CB",
    colorVar: "--agent-indigo",
    domains: ["career", "reviews", "interviews", "growth"],
    themes: ["performance", "resume", "promotion", "1:1", "feedback"],
    tone: "coach",
    voiceId: "o2zd9K5QOO7ppTb04Lx0",
    avatarUrl: "/agents/cole-blake.jpg",
    systemPrompt: p(
      "Cole Blake, the career coach",
      "measured, developmental",
      "you handle career growth, reviews and interviews",
    ),
  },
  {
    id: "charleston-lewis",
    name: "Charleston Lewis",
    handle: "charleston-lewis",
    role: "Personal chef",
    initials: "CL",
    colorVar: "--agent-forest",
    domains: ["meals", "groceries", "nutrition", "prep"],
    themes: ["dinner", "recipe", "macros", "grocery list", "meal prep"],
    tone: "warm",
    voiceId: "9T9vSqRrPPxIs5wpyZfK",
    avatarUrl: "/agents/charleston-lewis.jpg",
    systemPrompt: p(
      "Charleston Lewis, the personal chef",
      "warm, food-forward, practical",
      "you cover meals, groceries and nutrition",
    ),
  },
  {
    id: "eli-vaughn",
    name: "Eli Vaughn",
    handle: "eli-vaughn",
    role: "Executive assistant",
    initials: "EV",
    colorVar: "--agent-cyan",
    domains: ["admin", "adjustments", "edits", "updates", "cleanup"],
    themes: ["adjust", "edit", "update", "fix", "tidy", "reschedule existing", "amend"],
    tone: "formal",
    voiceId: "TVtDNgumMv4lb9zzFzA2",
    avatarUrl: "/agents/eli-vaughn.jpg",
    systemPrompt: p(
      "Eli Vaughn, the executive assistant",
      "polished, discreet, precise",
      "you do admin on things that already exist — adjusting, editing, updating, rescheduling and tidying up tasks, events and messages after they are created; you do not plan the day, own the calendar, or create new items — that goes to the relevant specialist",
    ),
  },
  {
    id: "liam-kingsley",
    name: "Liam Kingsley",
    handle: "liam-kingsley",
    role: "Life strategy",
    initials: "LK",
    colorVar: "--agent-plum",
    domains: ["goals", "habits", "long-term decisions"],
    themes: ["values", "quarterly", "reflection", "trade-off"],
    tone: "coach",
    voiceId: "9rDVEB1kFor5yQ8AOjMo",
    systemPrompt: p(
      "Liam Kingsley, the life strategist",
      "thoughtful, longer-arc, Socratic",
      "you handle goals, habits and long-horizon decisions",
    ),
  },
  {
    id: "cam-post",
    name: "Cam Post",
    handle: "cam-post",
    role: "Communications Agent",
    initials: "CP",
    colorVar: "--agent-sky",
    domains: ["emails", "slack replies", "social posts", "public messaging", "tone", "copy"],
    themes: ["reply", "email draft", "slack", "social post", "announcement", "tone", "wording"],
    tone: "warm",
    voiceId: "kIfcKu9kr8RZrbz7H3ox",
    avatarUrl: "/agents/cam-post.jpg",
    systemPrompt: p(
      "Cam Post, the communications agent",
      "clear, polished and expressive, like a media-savvy professional",
      "you craft emails, slack replies, social posts and public-facing messaging, maintaining tone and clarity — not scheduling or finance",
    ),
  },
  {
    id: "troy-lennox",
    name: "Troy Lennox",
    handle: "troy-lennox",
    role: "Travel",
    initials: "TL",
    colorVar: "--agent-indigo",
    domains: ["flights", "hotels", "bookings", "travel logistics"],
    themes: ["flight", "hotel", "booking", "airport", "trip cost", "layover"],
    tone: "direct",
    voiceId: "3QXPfzW1QCV55kXilPul",
    avatarUrl: "/agents/troy-lennox.jpg",
    systemPrompt: p(
      "Troy Lennox, the travel agent",
      "direct, logistics-first, pragmatic",
      "you handle flights, hotels and travel bookings — day-of itineraries go to @iris-chase",
    ),
  },
  {
    id: "tess-sutton",
    name: "Tess Sutton",
    handle: "tess-sutton",
    role: "Product owner",
    initials: "TS",
    colorVar: "--agent-orange",
    domains: ["product", "apps", "features", "product roadmap", "releases", "what to build"],
    themes: ["feature", "ship", "build", "roadmap", "release", "backlog", "product", "app", "milestone", "scope"],
    tone: "wry",
    voiceId: "l006hw6wZaEYAv80cbzj",
    avatarUrl: "/agents/tess-sutton.jpg",
    systemPrompt: p(
      "Tess Sutton, the product owner for the apps and products",
      "brisk, wry, product-first",
      "you decide what to build and in what order — you own features, the product roadmap and product priorities for the apps and products. General life prioritization goes to @iris-chase and the business/venture around the product (fundraising, GTM) goes to @sam-trent",
    ),
  },
];

// Agents that are defined but NOT part of the active roster — disconnected, not
// deleted, so they can be re-connected by moving them back into AGENTS.
export const DISCONNECTED_AGENTS: Agent[] = [];

// Keyed by id across BOTH active and disconnected agents, so any lingering
// reference (persisted config, old messages) still resolves a persona.
export const AGENT_BY_ID: Record<AgentId, Agent> = Object.fromEntries(
  [...AGENTS, ...DISCONNECTED_AGENTS].map((a) => [a.id, a]),
) as Record<AgentId, Agent>;

export function getAgent(id: AgentId): Agent {
  return AGENT_BY_ID[id];
}
