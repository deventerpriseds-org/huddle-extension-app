// WHAT: loop-3 E-U spelling table, row by row, against chatInvolvement (+ the plan for S-15), with message shapes as
//       external-feeds/teams-log.ts WRITES them (mentionedUserIds + unresolvedMention + mentionsOwner + ownerUserId).
// Run: CODE=<checkout> bun eu.ts. Synthetic data only; the at-sign is built from a char code.
const W = `${process.env.CODE}/src/features/huddle/lib`;
const { chatInvolvement } = await import(`${W}/correspondence/report-from-ledger.ts`);
const AT = String.fromCharCode(64);
const OWNER = "aaaaaaaa-0000-0000-0000-00000000000a";
const PAT = "bbbbbbbb-0000-0000-0000-00000000000b";
// A stored message as teams-log.ts writes it for a message with an EMPTY Graph mentions array.
const msg = (o: Record<string, unknown> = {}) => ({ kind: "teams", chatId: "x", messageId: "1", at: "2026-11-16T10:00:00Z", sender: { id: PAT, name: "Pat", isApp: false }, fromOwner: false, text: "hello team", mentionedUserIds: [], unresolvedMention: false, mentionsOwner: false, ownerUserId: OWNER, ...o });
const G = `19:abc${AT}thread.v2`;
type Row = [string, string, unknown[], string[], boolean, string];
const rows: Row[] = [
  ["S-1 1:1", `19:a_b${AT}unq.gbl.spaces`, [msg()], [], false, "one_on_one"],
  ["S-2 group, owner known, never wrote, empty mentions", G, [msg(), msg({ messageId: "2" })], [], true, "uninvolved"],
  ["S-3 meeting chat", `19:meeting_xyz${AT}thread.v2`, [msg()], [], true, "uninvolved"],
  ["S-4 channel tacv2", `19:abc${AT}thread.tacv2`, [msg()], [], true, "uninvolved"],
  ["S-5 upper-case id", `19:ABC${AT}THREAD.V2`, [msg()], [], true, "uninvolved"],
  ["S-6 fromOwner true", G, [msg(), msg({ fromOwner: true })], [], false, "owner_sent"],
  ["S-7 sender id = owner id, other case", G, [msg({ sender: { id: OWNER.toUpperCase(), name: "O", isApp: false } })], [], false, "owner_sent"],
  ["S-8 owner @mentioned (user id)", G, [msg({ mentionedUserIds: [OWNER], mentionsOwner: true })], [], false, "owner_mentioned"],
  ["S-9a tag/team mention, AS INGEST WRITES IT (unresolvedMention true)", G, [msg({ mentionedUserIds: [], unresolvedMention: true, text: "@Design team please look" })], [], true, "AC says HIDE"],
  ["S-9b tag mention as the SUITE fixture spells it (no flag)", G, [msg({ mentionedUserIds: [], unresolvedMention: undefined })], [], true, "uninvolved"],
  ["S-10 one message lacks mentionedUserIds", G, [msg(), msg({ mentionedUserIds: undefined, unresolvedMention: undefined })], [], false, "cant_tell_no_mention_data"],
  ["S-11 no owner id anywhere", G, [msg({ ownerUserId: undefined })], [], false, "cant_tell_owner_unknown"],
  ["S-11b owner id only in config", G, [msg({ ownerUserId: undefined })], [OWNER], true, "uninvolved"],
  ["S-12 fromOwner null", G, [msg({ fromOwner: null })], [], false, "cant_tell_owner_unknown"],
  ["S-13 unknown suffix", `19:abc${AT}foo`, [msg()], [], false, "not_group_or_meeting"],
  ["S-14 owner wrote only in an OLD message", G, [msg({ at: "2026-10-01T10:00:00Z", fromOwner: true }), msg()], [], false, "owner_sent"],
  ["X-1 malformed message (null) does not throw", G, [null], [], false, "cant_tell_malformed"],
  ["X-2 non-string chat id", 42 as unknown as string, [msg()], [], false, "*"],
];
let bad = 0;
for (const [name, id, ms, cfgIds, wantHide, wantReason] of rows) {
  let r: { hide: boolean; kind: string; reason: string };
  try {
    r = chatInvolvement(id, ms as never, cfgIds);
  } catch (e) {
    console.log(`BAD ${name}: THREW ${e}`);
    bad++;
    continue;
  }
  const ok = r.hide === wantHide && (wantReason === "*" || wantReason === r.reason || wantReason.startsWith("AC says"));
  if (!ok) bad++;
  console.log(`${ok ? "OK " : "BAD"} ${name}: hide=${r.hide} kind=${r.kind} reason=${r.reason} (want hide=${wantHide} ${wantReason})`);
}
console.log(bad ? `${bad} BAD` : "all as expected");
