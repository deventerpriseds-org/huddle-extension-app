import { classifyAsk } from "/home/user/huddle-extension-app/.claude/worktrees/agent-a18bc1bbede361072/src/features/huddle/lib/capabilities.ts";
// want: "now" only when the owner really asks to start now.
const cases: [string, "now" | "default"][] = [
  // UNSAFE candidates (deferral classified as now)
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
  // earlier-loop probes (must stay default)
  ["not now", "default"],
  ["don't do it right away", "default"],
  ["it doesn't need to be done right away", "default"],
  ["leave it for now", "default"],
  ["busy right now, do it later", "default"],
  // OVER-MATCH candidates (real urgent asks classified default)
  ["Do it right now so it's ready for tomorrow's meeting", "now"],
  ["I need it now, I'm busy later", "now"],
  ["ASAP please, I'm in a meeting at 3", "now"],
  ["Do it right now before my flight tonight", "now"],
  ["Start it immediately, I don't want to wait until Friday", "now"],
  // positives that must stay now
  ["I want it now", "now"],
  ["why don't you do it right now", "now"],
  ["I don't care, just do it now", "now"],
  ["do it now please", "now"],
];
let unsafe = 0, over = 0;
for (const [text, want] of cases) {
  const got = classifyAsk(text).urgency;
  const tag = got === want ? "ok    " : want === "default" ? "UNSAFE" : "OVER  ";
  if (got !== want) (want === "default" ? unsafe++ : over++);
  console.log(`${tag} got=${got} want=${want} | ${JSON.stringify(text)}`);
}
console.log(`unsafe=${unsafe} over=${over}`);
