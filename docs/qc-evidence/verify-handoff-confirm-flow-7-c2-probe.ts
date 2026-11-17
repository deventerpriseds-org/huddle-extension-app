// WHAT:       loop-7 C2 probe -- re-runs every loop-4 C2 row, plus new hunts, against classifyAsk().urgency
// WHY:        loop 4 REFUTED C2 (8 unsafe / 5 over-match); fix 7f88135f redesigned askIsUrgentNow
// SUPERSEDES: docs/qc-evidence/verify-handoff-confirm-flow-4-c2-probe.ts (branch claude_verify-handoff-confirm-flow-4) -- same rows, plus new ones
// SUPERSEDED-BY: nothing -- current
// EVIDENCE:   docs/qc-evidence/VERIFY-handoff-confirm-flow-7-C2.md
// run: bun docs/qc-evidence/verify-handoff-confirm-flow-7-c2-probe.ts
import { classifyAsk } from "../../src/features/huddle/lib/capabilities.ts";

type W = "now" | "default";
// [text, want, group]. want=default on a deferral/refusal; a "now" there is UNSAFE.
const loop4: [string, W][] = [
  ["Why don't you do it tomorrow instead of right now?", "default"],
  ["I don't care, just not right now", "default"],
  ["Can't you wait? Not right now.", "default"],
  ["Won't you hold off for now.", "default"],
  ["Why not leave it for now.", "default"],
  ["Do it on Friday, right now I'm slammed", "default"],
  ["Right now I'm swamped, get to it Monday", "default"],
  ["Get to it next month; right now there's too much going on", "default"],
  ["Do it after lunch, I'm on a call right now", "default"],
  ["Not urgent right now", "default"],
  ["not now", "default"],
  ["don't do it right away", "default"],
  ["it doesn't need to be done right away", "default"],
  ["leave it for now", "default"],
  ["busy right now, do it later", "default"],
  // loop-4 over-match rows: now accepted BY DESIGN as default when a time word is present (v4-O)
  ["Do it right now so it's ready for tomorrow's meeting", "now"],
  ["I need it now, I'm busy later", "now"],
  ["ASAP please, I'm in a meeting at 3", "now"],
  ["Do it right now before my flight tonight", "now"],
  ["Start it immediately, I don't want to wait until Friday", "now"],
  ["I want it now", "now"],
  ["why don't you do it right now", "now"],
  ["I don't care, just do it now", "now"],
  ["do it now please", "now"],
];
const hunt: [string, W][] = [
  // urgent idiom glued to a deferral / refusal: the idiom is REMOVED, then nothing vetoes
  ["Can't you see I'm driving right now?", "default"],
  ["Can't you see I'm exhausted right now?", "default"],
  ["I don't care right now", "default"],
  ["I don't care if it gets done right now", "default"],
  ["Never mind, I'll do it myself right now", "default"],
  ["Never mind, right now", "default"],
  ["Don't wait for me, I'm handling it myself right now", "default"],
  // owner doing it himself / wants the agent to wait
  ["I'll do it myself right now", "default"],
  ["Let me think, I'll get back to you right away", "default"],
  ["Hang on, I'm checking something right now", "default"],
  ["Hang on right now", "default"],
  // refusal words not in NEGATION_RE
  ["Nah, right now I'm good", "default"],
  ["Nope. Right now I'm good.", "default"],
  ["Do I need it right now? Nah.", "default"],
  ["Is it needed right away? Nope.", "default"],
  // stop / cancel / skip / pause / forget
  ["Stop right now", "default"],
  ["Cancel it right now", "default"],
  ["Skip it right now", "default"],
  ["Pause it right now", "default"],
  ["Just forget it now", "default"],
  ["Scrap that now", "default"],
  ["Drop it now", "default"],
  ["That's enough now", "default"],
  // busy reasons not in the busy list
  ["Right now I'm tied up", "default"],
  ["Right now I'm driving", "default"],
  ["Right now I'm at the gym", "default"],
  ["Right now I'm travelling", "default"],
  // time words missing from DEFERRAL_RE (typos, synonyms)
  ["Do it afterwards, right now just listen", "default"],
  ["Do it someday, right now I'm drained", "default"],
  ["Give me a sec, right now I'm drained", "default"],
  ["In a moment, right now I'm drained", "default"],
  ["Do it tmrw, right now I'm drained", "default"],
  ["Do it tomorow, right now I'm drained", "default"],
  ["Next time, right now just listen", "default"],
  // apostrophe forms: typos, missing, unicode variants
  ["dont do it right now", "default"],
  ["dnt do it right now", "default"],
  ["nto right now", "default"],
  ["don’t do it right now", "default"],
  ["donʼt do it right now", "default"],
  ["don‘t do it right now", "default"],
  ["don`t do it right now", "default"],
  ["don＇t do it right now", "default"],
  ["not yet, right now", "default"],
  // "now" as a noun / non-urgency
  ["Now is a terrible time", "default"],
  ["Now is the worst time", "default"],
  ["I've handled it up to now", "default"],
  ["It's low priority, asap would be overkill", "default"],
  ["Asap is overkill", "default"],
  // plain urgent asks with NO time or negation word (over-match check)
  ["Do it now, please.", "now"],
  ["Can you do it now?", "now"],
  ["Please handle this now, thanks", "now"],
  ["Start now?", "now"],
  ["Do it now 🙏", "now"],
  ["Get on it now", "now"],
  ["Right now please", "now"],
  ["Immediately.", "now"],
  ["ASAP", "now"],
  ["Now, draft the email", "now"],
];
let unsafe = 0, over = 0;
for (const [label, rows] of [["loop4", loop4], ["hunt", hunt]] as const) {
  for (const [text, want] of rows) {
    const got = classifyAsk(text).urgency;
    const tag = got === want ? "ok    " : want === "default" ? "UNSAFE" : "OVER  ";
    if (got !== want) want === "default" ? unsafe++ : over++;
    console.log(`${label} ${tag} got=${got} want=${want} | ${JSON.stringify(text)}`);
  }
}
console.log(`unsafe=${unsafe} over=${over}`);
