// Probe: daily / per-pass caps of the Actions classify step, with the SERVER's own cap formula
// (actions.server.ts:129-130: used = count of STORED verdicts with at >= local midnight; left = min(6, cap - used)).
const W = new URL("../../../src/features/huddle/lib", import.meta.url).pathname;
const { runClassify } = await import(`${W}/actions/pipeline.ts`);
const { resolveActionsSettings, localMidnightMs } = await import(`${W}/actions/actions.ts`);

// Ten Teams 1:1 chats, each with one OTHER message, already planned (scan).
const chats = Array.from({ length: 10 }, (_, i) => ({
  chatId: `c${i}`, chatName: null, kind: "one_on_one",
  messages: [{ id: `c${i}:m`, at: "2026-11-16T15:00:00Z", speaker: "OTHER", name: "P", text: "Could you please send the deck today?" }],
  latestOther: { id: `c${i}:m`, at: "2026-11-16T15:00:00Z", speaker: "OTHER", name: "P", text: "Could you please send the deck today?" },
  settled: false, ownerMentioned: null, involvement: { hide: false, kind: "one_on_one", reason: "one_on_one" }, webUrl: null, newestMs: 0,
}));
const assembled: any = {
  ctx: { ownerNames: ["Owner"] }, forwards: new Map(),
  plan: { email: { scan: [] }, teams: { scan: chats, hiddenUninvolved: [] }, meetings: { inWindow: [] } },
};
const s = resolveActionsSettings({ dailyCap: 5 });
const stored = new Map<string, any>();
const used = (dayStart: string) => [...stored.values()].filter((v) => v.at >= dayStart).length;
const PER_PASS = 6;

async function pass(modelFails: boolean, nowIso: string) {
  const day = new Date(localMidnightMs(Date.parse(nowIso), s.timeZone)).toISOString();
  const left = Math.max(0, Math.min(PER_PASS, s.dailyCap - used(day)));
  let modelCalls = 0;
  const judged = new Set([...stored.values()].map((v) => v.key));
  const r = await runClassify(assembled, s, judged, left, {
    model: async () => { modelCalls++; if (modelFails) throw new Error("429"); return { open_item: false, kind: "none", todo: null, due: null, quote: null, confidence: "high", reason: "r", category: "other" }; },
    propose: async () => ({ id: null, onBoard: false }),
    storeVerdict: async (at: any, v: any) => { stored.set(at.sourceItemId, v); },
    addMeetingRows: async () => 0,
    nowIso: () => nowIso,
  });
  return { left, modelCalls, failures: r.failures, storedToday: used(day) };
}

console.log("A. model failing (e.g. 429 / 15s timeout that still bills), dailyCap=5, 10 passes in one day:");
let total = 0;
for (let i = 0; i < 10; i++) { const r = await pass(true, `2026-11-16T15:${String(i * 5).padStart(2, "0")}:00.000Z`); total += r.modelCalls; }
console.log(`   total model calls = ${total} (cap 5); stored verdicts today = ${stored.size}`);

console.log("B. two concurrent passes (two instances: per-process guard only), cap 5, used 3:");
stored.clear();
for (let i = 0; i < 3; i++) stored.set(`pre${i}`, { key: `pre${i}`, at: "2026-11-16T14:00:00.000Z" });
const [x, y] = await Promise.all([pass(false, "2026-11-16T16:00:00.000Z"), pass(false, "2026-11-16T16:00:00.000Z")]);
console.log(`   instance1 left=${x.left} calls=${x.modelCalls}; instance2 left=${y.left} calls=${y.modelCalls}; stored today now ${used("2026-11-16T05:00:00.000Z")} (cap 5)`);

console.log("C. local midnight in several zones / DST days (UTC instant of 00:00 local):");
for (const [tz, at] of [
  ["America/New_York", "2026-03-08T12:00:00Z"], ["America/New_York", "2026-11-01T12:00:00Z"], ["America/New_York", "2026-11-17T04:59:59Z"], ["America/New_York", "2026-11-17T05:00:00Z"],
  ["America/Santiago", "2026-09-06T12:00:00Z"], ["America/Havana", "2026-03-08T12:00:00Z"], ["Australia/Lord_Howe", "2026-10-04T12:00:00Z"], ["Asia/Kolkata", "2026-11-16T20:00:00Z"], ["Pacific/Kiritimati", "2026-11-16T20:00:00Z"],
] as const) {
  const m = localMidnightMs(Date.parse(at), tz);
  const local = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(m));
  const localNow = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(Date.parse(at)));
  console.log(`   ${tz} now=${at} localDay=${localNow} -> ${new Date(m).toISOString()} = local ${local}; contains now: ${m <= Date.parse(at) && Date.parse(at) - m < 25 * 3600e3}`);
}
