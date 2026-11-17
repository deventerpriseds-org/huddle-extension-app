// WHAT: loop-6 C2 probe -- loop-4 rows re-run verbatim + new UNSAFE hunts against classifyAsk().urgency
// WHY:  fix 7f88135f claims no deferral/refusal reads "now"
// SUPERSEDES: docs/qc-evidence/verify-handoff-confirm-flow-4-c2-probe.ts (rows copied verbatim below)
// SUPERSEDED-BY: nothing -- current
// EVIDENCE: run with `bun docs/qc-evidence/verify-handoff-confirm-flow-6-c2-probe.ts`
import { classifyAsk } from "../../src/features/huddle/lib/capabilities.ts";
type U = "now" | "default";
const loop4: [string, U][] = [
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
  // over-match rows: loop-4 wanted "now"; v4-O accepted-by-design safe misses (time word present)
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
// NEW loop-6 hunts. want = what the owner means.
const hunt: [string, U][] = [
  // idiom removal hides the meaning of the idiom itself
  ["Never mind doing it right now", "default"],
  ["Nevermind, right now", "default"],
  ["I don't care about doing it right now", "default"],
  ["Can't you see I'm drowning right now", "default"],
  // typo / apostrophe forms of negation
  ["Do'nt do it right now", "default"],
  ["Don;t do it right now", "default"],
  ["Donʼt do it right now", "default"], // modifier-letter apostrophe
  ["Don′t do it right now", "default"], // prime
  ["Don`t do it right now", "default"],
  ["Dnt do it right now", "default"],
  ["Right now? Nope.", "default"],
  ["Right now? Nah.", "default"],
  ["Nah, right now", "default"],
  ["Hard pass right now", "default"],
  // refusals / pauses
  ["Hang on, right now I need to think", "default"],
  ["Pause, right now", "default"],
  ["Hold off right now", "default"],
  ["Not yet, right now", "default"],
  ["Skip it right now", "default"],
  ["Stop. Not now.", "default"],
  ["Cancel that right now", "now"], // urgent cancel: arguably genuinely urgent, informational only
  // bad-moment statements with no listed word
  ["I'm driving right now", "default"],
  ["I'm at the gym right now", "default"],
  ["I'm out of office right now", "default"],
  ["I'm traveling right now, remind me", "default"],
  ["I'm exhausted right now", "default"],
  ["I'm with a client right now", "default"],
  ["In five minutes. Right now I'm finishing a call", "default"],
  ["Give me a sec right now", "default"],
  ["Do it in a few, right now I'm tied up", "default"],
  ["Do it tmrw, right now I'm out", "default"],
  ["Do it on the 15th, right now is too early", "default"],
  ["Do it next Jan, right now", "default"],
  // "now" as a noun / time-anchor instruction that asks FOR confirmation
  ["Always ask me first as of now", "default"],
  ["Check with me first, starting now", "default"],
  ["Ask me before acting, effective now", "default"],
  ["From now on, confirm with me first", "default"],
  ["Live in the now", "default"],
  // control: plain urgent asks with NO time/negation word must be "now"
  ["Do it right now", "now"],
  ["Send it immediately", "now"],
  ["ASAP", "now"],
  ["Book it right away", "now"],
  ["Now, draft the email", "now"],
  ["Draft the email now!", "now"],
  ["Please handle this straight away", "now"],
  ["Do it this instant", "now"],
  ["Don't wait, do it right now", "now"],
  ["Don’t forget, do it right away", "now"],
  ["Can you do it right now?", "now"],
  ["Could you do it right now", "now"],
  ["Right now, please call the vendor", "now"],
  ["Email the client right now", "now"],
  ["Do it right now, it's urgent", "now"],
  ["I need this done immediately, no excuses", "now"],
];
function run(name: string, cases: [string, U][]) {
  let unsafe = 0, over = 0;
  for (const [text, want] of cases) {
    const got = classifyAsk(text).urgency;
    const tag = got === want ? "ok    " : want === "default" ? "UNSAFE" : "OVER  ";
    if (got !== want) (want === "default" ? unsafe++ : over++);
    console.log(`${name} ${tag} got=${got} want=${want} | ${JSON.stringify(text)}`);
  }
  console.log(`${name} unsafe=${unsafe} over=${over}`);
}
run("L4", loop4);
run("L6", hunt);
