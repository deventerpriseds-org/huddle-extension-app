// WHAT: loop-3 adversarial probe for D1 (quote stitched across pieces). Synthetic data only.
// Run from a checkout of the code: CODE=<dir> bun d1.ts
const W = `${process.env.CODE}/src/features/huddle/lib`;
const { quoteIsVerbatim, admitActionVerdict, teamsQuoteHaystack, emailQuoteHaystack } = await import(`${W}/correspondence/action-classify.ts`);
const good = { open_item: true, kind: "action", todo: "x", due: null, confidence: "high", reason: "r", category: "person_request" };
const adm = (q: string, hay: readonly string[] | string) => admitActionVerdict({ ...good, quote: q }, hay, { key: "k", settled: false, nowIso: "2026-11-17T00:00:00Z" }).status;
const msg = (speaker: "OTHER" | "OWNER", text: string | null, id = Math.random().toString(36)) => ({ id, speaker, name: speaker === "OTHER" ? "Pat" : "Owen", at: "2026-11-17T00:00:00Z", text });
const teams = (...m: ReturnType<typeof msg>[]) => ({ messages: m });
const rows: [string, string, readonly string[] | string, string][] = [
  ["P1 Teams stitch OTHER|OWNER|OTHER (owner text in middle)", "deck by friday ok will do send the budget", teamsQuoteHaystack(teams(msg("OTHER", "please send the deck by friday"), msg("OWNER", "ok will do"), msg("OTHER", "send the budget too"))), "not_checked"],
  ["P2 quote only in OWNER message", "I will send the budget", teamsQuoteHaystack(teams(msg("OTHER", "hi there"), msg("OWNER", "I will send the budget"))), "not_checked"],
  ["P3 three-OTHER stitch", "one two three four", teamsQuoteHaystack(teams(msg("OTHER", "one two"), msg("OTHER", "three"), msg("OTHER", "four"))), "not_checked"],
  ["P4 OTHER message with null text does not throw", "please send the deck", teamsQuoteHaystack(teams(msg("OTHER", null), msg("OTHER", "please send the deck now"))), "open"],
  ["P5 quote inside the 2nd OTHER message alone", "send the budget too", teamsQuoteHaystack(teams(msg("OTHER", "please send the deck by friday"), msg("OTHER", "send the budget too"))), "open"],
  ["P6 email body+forward stitch, newline boundary", "end of body start of forward", emailQuoteHaystack({ latestOther: { id: "L1", text: "here is the end of body" } } as never, new Map([["L1", "start of forward text"]])), "not_checked"],
  ["P7 email quote in forward only", "start of forward", emailQuoteHaystack({ latestOther: { id: "L1", text: "body" } } as never, new Map([["L1", "start of forward text"]])), "open"],
  ["P8 email: forward of a DIFFERENT message is not a piece", "other forward text", emailQuoteHaystack({ latestOther: { id: "L1", text: "body" } } as never, new Map([["L0", "other forward text"]])), "not_checked"],
  ["P9 email with no latestOther -> empty list", "anything at all here", emailQuoteHaystack({ latestOther: null } as never, new Map()), "not_checked"],
  ["P10 a joined string passed by a caller is still ONE piece (documents the string path)", "a b c d e f g h", "a b c d e f g h", "open"],
];
let bad = 0;
for (const [name, q, hay, want] of rows) {
  const got = adm(q, hay);
  if (got !== want) bad++;
  console.log(`${got === want ? "OK " : "BAD"} ${name}: got=${got} want=${want} pieces=${JSON.stringify(hay)}`);
}
console.log(bad ? `${bad} BAD` : "all as expected");
