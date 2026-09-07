// WHAT:       The PURE decision core of the recipient-scoped agent email gate (D4b). Given a set of
//             recipients, the caller's own profile_emails rows, a tier-policy map and the OWNER'S OWN
//             turn text, it answers one question: may this message be SENT, or must it become a DRAFT?
// WHY:        D4a's gate is global and decided at TOOL-ASSEMBLY time (`send_email` is in the toolset or
//             it is not), so the owner could not receive his own digest without also enabling mail to
//             third parties. Owner, 2026-09-07: "when I want it to send me a summary or digest or other
//             email it should be able to do so -- it's other recipients that should be draft", refined
//             to "default self send email should be von.ellis@.... tiggapoohtv can be excluded and dev@
//             is typically the send from Emily but I may explicitly ask to send to it."
// SUPERSEDES: nothing. EXTENDS the D4a gate (identity.agent_workflow_config.email_send_enabled), which
//             is untouched and still governs THIRD-PARTY recipients.
// SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   nexus-hub docs/cross-app-agent/AC-email-self-send.md (38 independent criteria) and
//             docs/cross-app-agent/FIX-email-self-send.md (mutation outcomes, verbatim).
//
// WHY THIS FILE IS PURE AND HAS NO IMPORTS. Every criterion above is about a decision, and a decision
// that can only be exercised by standing up a Postgres pool and a Graph token is a decision nobody
// mutation-proves. Splitting the DECISION (here) from the READS that feed it (identity/config) is what
// makes `bun scripts/email-self-send.test.ts` able to run the real code offline, with no network, no
// database and no possibility of mail leaving the tenant.

/** Tier of a single recipient address, from the owner's own three-tier model plus "not yours". */
export type RecipientTier = "auto" | "on-request" | "excluded" | "third-party";

/**
 * Addresses that are NEVER a self-send target, checked BEFORE any profile_emails lookup and not
 * promotable by any data. Owner, 2026-09-07: "tiggapoohtv can be excluded".
 *
 * The asymmetry is deliberate and is the safe direction: the tier map may ADD exclusions (data), but
 * nothing may REMOVE one from this list (code). An address the owner has asked never to be auto-mailed
 * must not become auto-mailable through a mis-typed jsonb value, and the cost of the asymmetry is a
 * one-line code change if he ever reverses the decision. AC-3 requires exactly this: still EXCLUDED
 * even if a profile_emails row for it is inserted later.
 */
export const NEVER_SELF_ADDRESSES: readonly string[] = ["tiggapoohtv@yahoo.com"];

/** A row of the caller's own identity.profile_emails, reduced to what the tier decision needs. */
export interface SelfEmailRow {
  email: string;
  /** identity.profile_emails.source -- 'entra' (the sign-in primary) or 'manual' (an added alias). */
  source: string;
}

/** Explicit per-address policy, read from identity.agent_workflow_config.email_self_tiers. */
export type TierMap = Record<string, string>;

export interface RecipientDecision {
  /** The normalized address, or "" when the entry could not be parsed as one. */
  address: string;
  /** Exactly what the caller passed, for the human-readable explanation. */
  raw: string;
  tier: RecipientTier;
  /** True when this recipient alone permits a send. */
  cleared: boolean;
  /** Why it did not clear -- surfaced verbatim to the agent so the reply can be truthful. */
  reason?: string;
}

export interface SendScopeInput {
  to?: string | string[] | null;
  cc?: string | string[] | null;
  bcc?: string | string[] | null;
  /** The caller's own identity.profile_emails rows. EMPTY on any read failure (fail closed). */
  selfRows: SelfEmailRow[];
  /** identity.agent_workflow_config.email_self_tiers for this caller. */
  tierMap?: TierMap | null;
  /**
   * Whether the tier-policy read SUCCEEDED. False means the config query threw, and per AC-5 that
   * demotes EVERY address to drafting -- an unreadable policy must never leave an address AUTO.
   * Note this is a different case from a policy that is readable and empty (AC-4), which derives
   * tiers from profile_emails.source instead.
   */
  tiersReadable: boolean;
  /**
   * The OWNER'S OWN message text for this turn. NEVER the agent's reply, a system prompt, retrieved
   * memory, or any tool argument the model chose -- admitting model output here would let an agent
   * manufacture its own authorisation (AC-16). A surface that cannot supply it passes null, and
   * on-request addresses then draft (AC-28/32).
   */
  ownerTurnText?: string | null;
}

export interface SendScope {
  /** "send" only when there is at least one recipient AND every one of them cleared. */
  decision: "send" | "draft" | "no-recipients";
  recipients: RecipientDecision[];
  /** The recipients that did NOT clear, in input order. */
  blocked: RecipientDecision[];
}

const ADDRESS_CHAR = /[A-Za-z0-9._%+-]/;

/**
 * Reduce one raw recipient entry to a comparable address, or "" when it is not address-shaped.
 *
 * Handles the RFC 5322 display-name forms the tool schemas can produce
 * (`Von Ellis <von.ellis@enterpriseds.io>`, `<von.ellis@...>`, `von.ellis@... (Von Ellis)`), trims,
 * and lower-cases -- stored profile_emails values are already lower-cased (AC-8, AC-9).
 *
 * Returning "" rather than throwing matters: a malformed entry must remain a BLOCKING recipient
 * (AC-12), never be silently dropped, because dropping it would let "self@x, garbage" read as a
 * clean all-self set.
 */
export function normalizeAddress(raw: string): string {
  let s = String(raw ?? "").trim();
  if (!s) return "";
  const angle = s.match(/<([^<>]*)>/);
  if (angle) s = angle[1].trim();
  else s = s.replace(/\s*\([^()]*\)\s*$/, "").trim(); // trailing "(Display Name)"
  s = s.replace(/^mailto:/i, "").trim();
  if (/\s/.test(s)) return "";
  const at = s.indexOf("@");
  if (at <= 0 || at !== s.lastIndexOf("@")) return "";
  const domain = s.slice(at + 1);
  if (!domain.includes(".") || domain.startsWith(".") || domain.endsWith(".")) return "";
  return s.toLowerCase();
}

/**
 * Split one recipient FIELD into individual entries. Every tool schema on every surface types `to`
 * and `cc` as a single comma-separated STRING, and `toRecipients()` in graph-email.server.ts does NOT
 * split them -- so the gate must do its own splitting rather than lean on that function's current
 * behaviour (AC-10, and failure mode #5 in the AC document: reusing `toRecipients()` here happens to
 * fail closed today and would silently stop doing so the day somebody teaches it to split).
 */
export function splitRecipientField(v: string | string[] | null | undefined): string[] {
  if (v === null || v === undefined) return [];
  const arr = Array.isArray(v) ? v : [v];
  const out: string[] = [];
  for (const item of arr) {
    for (const part of String(item ?? "").split(",")) {
      if (part.trim()) out.push(part.trim());
    }
  }
  return out;
}

/**
 * Every recipient across to + cc + bcc, de-duplicated by normalized address (AC-11). Malformed
 * entries are KEPT (each as its own entry) because they must block the send, not vanish.
 */
export function collectRecipients(input: {
  to?: string | string[] | null;
  cc?: string | string[] | null;
  bcc?: string | string[] | null;
}): Array<{ raw: string; address: string }> {
  const raws = [
    ...splitRecipientField(input.to),
    ...splitRecipientField(input.cc),
    ...splitRecipientField(input.bcc),
  ];
  const seen = new Set<string>();
  const out: Array<{ raw: string; address: string }> = [];
  for (const raw of raws) {
    const address = normalizeAddress(raw);
    if (address) {
      if (seen.has(address)) continue;
      seen.add(address);
    }
    out.push({ raw, address });
  }
  return out;
}

/**
 * Does `address` appear in the owner's own text as its own address token?
 *
 * A bare `String.includes` is wrong in both directions and both were specified (AC-17, AC-18):
 * `not.von.ellis@enterpriseds.io.contractor.example` CONTAINS `von.ellis@enterpriseds.io` as a literal
 * substring, and so does `https://dev@enterpriseds.io.tracker.example/click`. Neither is the owner
 * asking for mail to go to that address.
 *
 * So the match is token-bounded: the character before and after must not be part of an address, and
 * the character before must not be `/` or `:` either -- an address inside a URL or a `mailto:` link is
 * DELIBERATELY not counted as an ask. That is the fail-closed choice AC-17 requires be made and
 * asserted rather than left to accidental regex behaviour; the cost of getting it "wrong" in this
 * direction is a draft the owner sends by hand.
 */
export function mentionsAddressVerbatim(
  ownerTurnText: string | null | undefined,
  address: string,
): boolean {
  const hay = String(ownerTurnText ?? "").toLowerCase();
  const needle = String(address ?? "").toLowerCase();
  if (!hay || !needle) return false;
  let from = 0;
  for (;;) {
    const i = hay.indexOf(needle, from);
    if (i < 0) return false;
    const before = i > 0 ? hay[i - 1] : "";
    const after = i + needle.length < hay.length ? hay[i + needle.length] : "";
    const beforeOk = before === "" || (!ADDRESS_CHAR.test(before) && before !== "/" && before !== ":");
    const afterOk = after === "" || !ADDRESS_CHAR.test(after);
    if (beforeOk && afterOk) return true;
    from = i + 1;
  }
}

/**
 * The tier of one address for one caller.
 *
 * Order is load-bearing:
 *   1. NEVER_SELF_ADDRESSES  -- absolute, before any lookup, not overridable (AC-3).
 *   2. an explicit "excluded" in the tier map -- data may ADD an exclusion.
 *   3. tiers unreadable       -- everything drafts, nothing is AUTO (AC-5).
 *   4. not in profile_emails  -- third party (AC-2). Checked BEFORE the tier map can promote it, so a
 *                               stray map entry cannot make a stranger's address self.
 *   5. an explicit tier map entry for a KNOWN self address.
 *   6. derived from source    -- 'entra' => auto, anything else => on-request (AC-1, AC-4).
 */
export function resolveTier(
  address: string,
  opts: { selfRows: SelfEmailRow[]; tierMap?: TierMap | null; tiersReadable: boolean },
): RecipientTier {
  const a = String(address ?? "").trim().toLowerCase();
  if (!a) return "third-party";
  if (NEVER_SELF_ADDRESSES.some((x) => x.toLowerCase() === a)) return "excluded";

  const map = opts.tierMap ?? {};
  const explicit = String(
    Object.entries(map).find(([k]) => k.trim().toLowerCase() === a)?.[1] ?? "",
  )
    .trim()
    .toLowerCase();
  if (explicit === "excluded") return "excluded";

  // AC-5: a config read that THREW must not leave any address AUTO. Distinct from a readable-but-empty
  // map (AC-4), which falls through to the source-derived default below.
  if (!opts.tiersReadable) return "third-party";

  const row = opts.selfRows.find((r) => String(r.email ?? "").trim().toLowerCase() === a);
  if (!row) return "third-party";

  if (explicit === "auto") return "auto";
  if (explicit === "on-request" || explicit === "on_request") return "on-request";

  return String(row.source ?? "").trim().toLowerCase() === "entra" ? "auto" : "on-request";
}

/**
 * The whole decision: may this message be sent, or must it become a draft?
 *
 * THE EMPTY-RECIPIENT GUARD IS THE POINT OF THIS FUNCTION'S SHAPE. `[].every(...)` is `true` in
 * JavaScript, so "every recipient is self" is VACUOUSLY true for a message addressed to nobody, and a
 * gate written as a bare `.every()` would open on a `to`-less call. That is failure mode #1 in the AC
 * document and AC-7 names it "the single most likely bug". Hence `decision: "no-recipients"` as a
 * THIRD state rather than a boolean -- there is no way to spell the bug in this return type.
 */
export function classifySendScope(input: SendScopeInput): SendScope {
  const collected = collectRecipients(input);
  const recipients: RecipientDecision[] = collected.map(({ raw, address }) => {
    if (!address) {
      return {
        address: "",
        raw,
        tier: "third-party" as const,
        cleared: false,
        reason: `"${raw}" is not a valid email address`,
      };
    }
    const tier = resolveTier(address, {
      selfRows: input.selfRows,
      tierMap: input.tierMap,
      tiersReadable: input.tiersReadable,
    });
    if (tier === "auto") return { address, raw, tier, cleared: true };
    if (tier === "excluded") {
      return { address, raw, tier, cleared: false, reason: `${address} is never a self-send address` };
    }
    if (tier === "on-request") {
      const named = mentionsAddressVerbatim(input.ownerTurnText, address);
      return named
        ? { address, raw, tier, cleared: true }
        : {
            address,
            raw,
            tier,
            cleared: false,
            reason: `${address} only sends when you name that address yourself in your message`,
          };
    }
    return {
      address,
      raw,
      tier,
      cleared: false,
      reason: `${address} is not one of your own addresses`,
    };
  });

  if (recipients.length === 0) {
    return { decision: "no-recipients", recipients, blocked: [] };
  }
  const blocked = recipients.filter((r) => !r.cleared);
  return { decision: blocked.length === 0 ? "send" : "draft", recipients, blocked };
}

/** The sentence the agent reads back to the owner when a send became a draft. */
export function draftReasonSentence(blocked: RecipientDecision[]): string {
  const reasons = blocked.map((b) => b.reason).filter(Boolean) as string[];
  const detail = reasons.length ? reasons.join("; ") : "a recipient is not one of your own addresses";
  return `Saved to drafts instead of sending: ${detail}.`;
}
