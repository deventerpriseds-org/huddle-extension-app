const W = new URL("../../../src/features/huddle/lib", import.meta.url).pathname;
const { quoteIsVerbatim, admitActionVerdict, canonQuote, teamsQuoteHaystack, emailQuoteHaystack } = await import(`${W}/correspondence/action-classify.ts`);
const good = { open_item: true, kind: "reply", todo: "x", due: null, confidence: "high", reason: "r", category: "person_request" };
const adm = (q: string | null, hay: string) => admitActionVerdict({ ...good, quote: q }, hay, { key: "k", settled: false, nowIso: "2026-11-16T00:00:00Z" }).status;
const HAY = "Hi Owen,\nCould you please confirm the venue hold by Friday?\nThanks, Pat";
const rows: [string, string | null, string | null][] = [
  ["Q1 exact span", "Could you please confirm the venue hold by Friday?", HAY],
  ["Q2 newline inside quote vs space in msg", "Could you please\nconfirm the venue hold", HAY],
  ["Q3 tab/NBSP variants", "Could you\tplease confirm", HAY],
  ["Q4 smart quotes in quote, straight in msg", "it’s the venue", "Note: it's the venue we booked"],
  ["Q5 case difference", "COULD YOU PLEASE CONFIRM", HAY],
  ["Q6 empty quote", "", HAY],
  ["Q7 whitespace-only quote", "          ", HAY],
  ["Q8 quote = whole message", HAY, HAY],
  ["Q9 7 chars", "confirm", HAY],
  ["Q10 8 chars with trailing space (trimmed->7)", "confirm ", HAY],
  ["Q11 'ab cd' padded", "  ab cd  ", "xx ab cd yy"],
  ["Q12 NFC quote vs NFD message", "the café meeting tomorrow", "Join the café meeting tomorrow"],
  ["Q13 zero-width space inside msg word", "confirm the venue", "please confirm the ve​nue"],
  ["Q14 ellipsis char vs three dots", "confirm the venue...", "confirm the venue…"],
  ["Q15 quote spans two OTHER messages (Teams join)", "see you there please send the deck", null],
  ["Q16 quote that only matches inside an HTML tag", "class=\"signature\"", "<div class=\"signature\">Pat</div>"],
  ["Q17 quote mid-word substring", "onfirm the venu", HAY],
  ["Q18 non-breaking hyphen U+2011 vs -", "follow-up meeting", "the follow‑up meeting"],
  ["Q19 em dash vs hyphen", "budget - approved", "budget — approved"],
  ["Q20 null quote", null, HAY],
];
for (const [name, q, hay] of rows) {
  let h = hay;
  if (h === null) h = teamsQuoteHaystack({ messages: [{ speaker: "OTHER", text: "ok see you there" }, { speaker: "OWNER", text: "x" }, { speaker: "OTHER", text: "please send the deck" }] } as any);
  console.log(`${name}: verbatim=${quoteIsVerbatim(q, h!)} admit=${adm(q, h!)} canon(q)=${JSON.stringify(canonQuote(q ?? ""))}`);
}
const f: any = { latestOther: { id: "m2", text: "Thanks for this, see below" } };
const fw = new Map([["m2", "please send the signed contract"]]);
console.log("Q21 email: quote spanning latest-OTHER body and its forwarded part:", quoteIsVerbatim("see below please send", emailQuoteHaystack(f, fw)));
