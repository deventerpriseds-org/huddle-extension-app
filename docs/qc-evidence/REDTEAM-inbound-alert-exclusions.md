<!--
WHAT:          Red-team pre-pass findings for the inbound email alert subject exclusion list (commit e83dcf59,
               branch claude/modest-brown-2hdt5n). Each finding has an input, the observed verdict, the expected
               verdict, a severity, and a failing bun test snippet.
WHY:           Tier 1 change (decides whether Iris alerts the owner; matches free text). The red-team pre-pass runs
               before the PR (eds verify-work §0b2). Its findings become tests.
SUPERSEDES:    nothing.
SUPERSEDED-BY: nothing -- current.
EVIDENCE:      every snippet below was run on e83dcf59 with `bun test` (scratch copy): 28 tests, 0 pass, 28 fail, which is
               the intended result (each test states the correct answer). Existing suites on the same commit:
               inbound-alert-exclusions.test.ts 61/61, needs-you.test.ts 77/77, inbound-email.test.ts 72/72.
-->

# Red-team pre-pass: inbound alert exclusion list ("meeting minutes")

Commit under test: `e83dcf59`. Source read: `inbound-email.ts` (`subjectExcluded`, `cleanAlertSkipSubjects`,
`screenMessage`), `inbound-email.server.ts` (`loadAlertSkipSubjects`, runner loop), `actions.ts`
(`resolveActionsSettings`, `keepStoredAlertSkipSubjects`), `actions.server.ts` (`saveActionsSettings`,
`correctActionItem`), `ActionsView.tsx` (`actions-alert-skip`, `saveSettings`), `email-replies.server.ts`
(`get/setActionsSettingsRaw`), `onedrive-feed.ts` (`stripReplyPrefixes`), `minutes.ts` (`minutesSubject`).

Common test header for every snippet:

```ts
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { cleanAlertSkipSubjects, screenMessage, subjectExcluded, type InboundMessage } from "../src/features/huddle/lib/email/inbound-email";
import { keepStoredAlertSkipSubjects, resolveActionsSettings } from "../src/features/huddle/lib/actions/actions";
import { stripReplyPrefixes } from "../src/features/huddle/lib/external-feeds/onedrive-feed";
const SEED = ["meeting minutes"];
const MAILBOX = "owner@example.test";
const msg = (subject: string): InboundMessage => ({
  id: "m1", subject, fromAddress: "colleague@example.test", fromName: "A Colleague",
  inferenceClassification: "focused", headerNames: ["from"], bodyText: "Can you fix item 3?",
});
```

## Summary

| # | Finding | Kind | Severity | Covered by the ACs? |
|---|---|---|---|---|
| RT-1 | Replies with prefixes the codebase ALREADY recognises (`AW:` `SV:` `Antw:` `WG:` `TR:` `RV:` `RE[2]:`), plus `Re：` (fullwidth colon) and a zero-width space near `Re:`, are excluded | false exclusion | **HIGH** | Only `AW:` (S-18, accepted). The rest are not in the table |
| RT-2 | A real person's ORIGINAL email whose subject mentions meeting minutes is dropped silently | false exclusion | **HIGH** (owner decision) | Yes, G1/S-33 accepts it |
| RT-3 | `[EXT] Re: Meeting Minutes: ...` (a mail-gateway tag before `Re:`) is excluded | false exclusion | MEDIUM | Yes, S-19 accepts it |
| RT-4 | The edge check reads one UTF-16 unit and ignores combining marks: NFD `Prémeeting minutes`, an astral letter before the phrase, or a combining mark after it all match | false exclusion | LOW | No |
| RT-5 | Zero-width space, soft hyphen, fullwidth letters and Turkish `İ` defeat the match | false pass | LOW (Huddle never emits these) | No |
| RT-6 | A save can overwrite the owner's custom list with the seed: (a) a key-less payload when the stored read fails, (b) a payload with `alertSkipSubjects: null` | list lost | MEDIUM | AC-40 covers only the happy key-less path |
| RT-7 | The field keeps showing a phrase the cleaner dropped (too short, too long, duplicate) when the cleaned list equals the stored one | UI shows a list the runner is not using | LOW | AC-43 (violated) |
| RT-8 | The cleaner accepts phrases with no letter or digit (`...`, `?!?`, three zero-width spaces); a punctuation phrase's edge check is vacuous, so `...` excludes any subject with a spaced ellipsis | false exclusion (owner-typed) | LOW | No |
| RT-9 | A CJK phrase never matches inside unspaced CJK text | false pass | LOW | No |
| OK-1 | Public run log: no subject or phrase leak | no finding | - | AC-30 |
| OK-2 | Other callers unchanged (proposals, needs-you pin, bell.ts) | no finding | - | AC-45, AC-46 |
| OK-3 | Throws / very long input | no finding | - | AC-10, AC-15 |

---

## RT-1 — reply/forward prefixes the codebase already knows are treated as original subjects (HIGH, false exclusion)

**Input:** `AW: Meeting Minutes: X` (German Outlook reply), `SV:` (Nordic), `Antw:` (Dutch), `WG:` (German forward),
`TR:` (French forward), `RV:` (Spanish forward), `RE[2]:` (numbered reply), `Re： Meeting Minutes: X` (U+FF1A fullwidth
colon, CJK clients), `​Re: Meeting Minutes: X` and `Re​: Meeting Minutes: X` (zero-width space, which `\s`
does not match).

**Observed:** `subjectExcluded` returns `true` for all ten, so `screenMessage` returns `excluded-subject` and a colleague's
reply that asks "Can you fix item 3?" never reaches the owner.

**Expected:** the normal screen (the same verdict as with no list), because each is a reply.

**Why this is a defect and not only spec-accepted G4:** the spec's G4 says "if that rule is widened, widen it in ONE shared
helper". That helper already exists: `stripReplyPrefixes` in `external-feeds/onedrive-feed.ts:144` (itself the fix for an
earlier red-team finding, F18) recognises `re|fw|fwd|aw|tr|wg|sv|rv|antw` with an optional `[n]`. The new
`REPLY_OR_FORWARD_SUBJECT` is a second, narrower copy. Mail from the work-mailbox feed goes through the SAME
`screenMessage`, so the feed ingest calls `AW: Meeting Minutes` a reply while the alert screen calls it an original.
The AC table only lists `AW:` (S-18) and none of the others.

**Severity:** HIGH. The failure is silent: the owner never learns the reply arrived.

```ts
describe("RT-1 reply/forward prefixes the codebase already knows are excluded", () => {
  for (const s of ["AW: Meeting Minutes: X", "SV: Meeting Minutes: X", "Antw: Meeting Minutes: X", "RE[2]: Meeting Minutes: X", "WG: Meeting Minutes: X", "TR: Meeting Minutes: X", "RV: Meeting Minutes: X"]) {
    test(`${s} -> normal screen (stripReplyPrefixes says it is a reply)`, () => {
      expect(stripReplyPrefixes(s)).toBe("Meeting Minutes: X"); // the existing helper's own verdict
      expect(screenMessage(msg(s), "needs-reply", MAILBOX, SEED)).toEqual(screenMessage(msg(s), "needs-reply", MAILBOX));
    });
  }
  for (const s of ["Re： Meeting Minutes: X", "​Re: Meeting Minutes: X", "Re​: Meeting Minutes: X"]) {
    test(`${JSON.stringify(s)} (fullwidth colon / zero-width space) -> not excluded`, () => {
      expect(subjectExcluded(s, SEED)).toBe(false);
    });
  }
});
```

Observed: 10/10 fail.

## RT-2 — a real person's original email about minutes is silently dropped (HIGH, owner decision; the spec accepts it)

**Input:** `Can you send me the meeting minutes from Tuesday?`, `Question about the meeting minutes`,
`Missing meeting minutes - urgent`, from a colleague, with a body that asks something.

**Observed:** `excluded-subject` for all three.

**Expected (owner-safe answer):** `keep: true`.

**Note:** AC G1 and row S-33 deliberately accept this ("the owner's rule is by subject"). It is listed because it is the
largest real-world false-exclusion class: the seed matches the phrase ANYWHERE in the subject, not the shape Huddle sends
(`minutesSubject()` always starts the subject with `Meeting Minutes: ` or `Updated Meeting Minutes: `, and the live rows
come from sender "EDS Dev"). Whether to narrow it is the owner's call (G1); the test below encodes the owner-safe answer.

```ts
describe("RT-2 a real person's ORIGINAL email about minutes is silently dropped (spec G1/S-33 accepts this)", () => {
  for (const s of ["Can you send me the meeting minutes from Tuesday?", "Question about the meeting minutes", "Missing meeting minutes - urgent"]) {
    test(`${s} -> kept`, () => {
      expect(screenMessage(msg(s), "needs-reply", MAILBOX, SEED).keep).toBe(true);
    });
  }
});
```

Observed: 3/3 fail.

## RT-3 — gateway tag before `Re:` (MEDIUM, the spec accepts it)

**Input:** `[EXT] Re: Meeting Minutes: X`. **Observed:** `excluded-subject`. **Expected (owner-safe):** the normal screen.
S-19 accepts EXCLUDE "consistent with the existing rule". It is a reply from a person, dropped silently. `stripReplyPrefixes`
does not handle a leading tag either, so a fix would need to be in the shared helper.

```ts
describe("RT-3 gateway tag before Re: (spec S-19 accepts EXCLUDE)", () => {
  test("[EXT] Re: Meeting Minutes: X -> normal screen", () => {
    expect(screenMessage(msg("[EXT] Re: Meeting Minutes: X"), "needs-reply", MAILBOX, SEED)).toEqual(screenMessage(msg("[EXT] Re: Meeting Minutes: X"), "needs-reply", MAILBOX));
  });
});
```

Observed: 1/1 fails.

## RT-4 — the edge check reads one UTF-16 unit and ignores combining marks (LOW, false exclusion)

`subjectExcluded` checks `s[i - 1]` (one code unit) and `s.slice(end, end + 2)` against `[\p{L}\p{N}]`. It misses three things:

| Input | Observed | Expected | Why |
|---|---|---|---|
| `Prémeeting minutes` (NFD `é`, as macOS mail can send it) | excluded | not excluded | the unit before is U+0301, a combining mark (`\p{M}`), not `\p{L}`. The NFC spelling `Prémeeting minutes` is correctly NOT excluded, so the verdict depends on normalisation |
| `\u{1D400}meeting minutes` (an astral letter before) | excluded | not excluded | `s[i-1]` is a lone low surrogate, which is not `\p{L}` |
| `Meeting minuteśx` (combining mark after) | excluded | not excluded | the mark continues the word but is not `\p{L}`/`\p{N}` |

```ts
describe("RT-4 boundary reads one UTF-16 unit and ignores combining marks (false exclusions)", () => {
  test("NFD 'Pre\\u0301meeting minutes' behaves like NFC 'Prémeeting minutes' (not excluded)", () => {
    expect(subjectExcluded("Prémeeting minutes", SEED)).toBe(false);
    expect(subjectExcluded("Prémeeting minutes", SEED)).toBe(false);
  });
  test("astral letter before the phrase is a letter", () => {
    expect(subjectExcluded("\u{1D400}meeting minutes", SEED)).toBe(false);
  });
  test("combining mark after the phrase continues the word", () => {
    expect(subjectExcluded("Meeting minuteśx", SEED)).toBe(false);
  });
});
```

Observed: 3/3 fail.

## RT-5 — invisible and compatibility characters defeat the match (LOW, false pass)

| Input | Observed | Expected |
|---|---|---|
| `Meeting​Minutes: X` (zero-width space) | not excluded | excluded |
| `Meeting ​Minutes: X` | not excluded | excluded |
| `Meeting­Minutes: X` (soft hyphen) | not excluded | excluded |
| `Ｍｅｅｔｉｎｇ Ｍｉｎｕｔｅｓ: X` (fullwidth) | not excluded | excluded |
| `MEETİNG MİNUTES: X` (Turkish U+0130; `toLowerCase` gives `i` + U+0307) | not excluded | excluded |

Severity LOW: `minutesSubject()` never produces these, so Huddle's own minutes still match. A false pass costs one
dismissable alert. Listed for completeness. U+2028/U+2029 and U+FEFF are matched correctly (`\s` covers them).

```ts
describe("RT-5 invisible / compatibility characters (false passes; Huddle itself never emits these)", () => {
  for (const s of ["Meeting​Minutes: X", "Meeting ​Minutes: X", "Meeting­Minutes: X", "Ｍｅｅｔｉｎｇ Ｍｉｎｕｔｅｓ: X", "MEETİNG MİNUTES: X"]) {
    test(`${JSON.stringify(s)} -> excluded`, () => {
      expect(subjectExcluded(s, SEED)).toBe(true);
    });
  }
});
```

Observed: 5/5 fail.

## RT-6 — a save can overwrite the owner's custom list with the seed (MEDIUM, list lost)

`saveActionsSettings` (actions.server.ts:447-450):

```ts
const stored = raw && typeof raw === "object" && !("alertSkipSubjects" in raw) ? await getActionsSettingsRaw(cfg.owner).catch(() => null) : null;
const s = resolveActionsSettings(keepStoredAlertSkipSubjects(raw, stored), ownNamesSeed(cfg));
await setActionsSettingsRaw(cfg.owner, s);
```

- **(a)** A key-less payload (the stale-tab case AC-40 exists for) when the stored read fails: `.catch(() => null)` turns the
  failure into "nothing stored", `keepStoredAlertSkipSubjects` returns the payload unchanged, the resolver seeds
  `["meeting minutes"]`, and the write then REPLACES the owner's saved list. The failure is turned into a silent reset,
  where it should refuse the save. (It needs the read to fail and the write to succeed. Both use the same pool, so this
  is a transient-error case, not the common one.)
- **(b)** A payload with the key present but `alertSkipSubjects: null` (or any non-array) skips the stored read because
  `"alertSkipSubjects" in raw` is true, and the resolver seeds. The current client always sends an array, so this needs a
  bad client.
- Also observed (existing behaviour, not new): an ARRAY payload (`[]`) passes the `typeof === "object"` check, and
  `keepStoredAlertSkipSubjects` returns it unchanged, so EVERY setting resets to defaults, this list included.

`correctActionItem` (`{ ...s, hiddenSenders }` with `s` already resolved) keeps the list: no finding (AC-41 holds).

```ts
describe("RT-6 a save can reseed the owner's list", () => {
  test("key-less payload + stored read FAILED (saveActionsSettings .catch(() => null)) -> must not persist the seed", () => {
    // saveActionsSettings: stored = await getActionsSettingsRaw(owner).catch(() => null); s = resolve(keepStored(raw, stored)); write s.
    const s = resolveActionsSettings(keepStoredAlertSkipSubjects({ ownNames: [] }, null));
    expect(s.alertSkipSubjects).not.toEqual(["meeting minutes"]); // today: the seed is written over the stored custom list
  });
  test("payload with alertSkipSubjects: null (key present) keeps the stored list", () => {
    const s = resolveActionsSettings(keepStoredAlertSkipSubjects({ alertSkipSubjects: null }, { alertSkipSubjects: ["weekly digest"] }));
    expect(s.alertSkipSubjects).toEqual(["weekly digest"]);
  });
});
```

Observed: 2/2 fail. Test (a) is a pure-level reproduction of what the server function writes. A full test would mock
`getActionsSettingsRaw` to reject and assert that `setActionsSettingsRaw` is not called with the seed.

## RT-7 — the field can show a phrase the runner is not using (LOW; violates AC-43)

`ActionsView.tsx`, `actions-alert-skip` `onBlur`: `next = cleanAlertSkipSubjects(lines)`, and `onChange` fires only when
`next` differs from the stored list. The textarea is uncontrolled (`defaultValue`, `key = stored.join("\n")`).

**Input:** stored `["meeting minutes"]`. The owner adds a line `re` (2 characters), or a duplicate `Meeting Minutes`, or a
121-character line, then blurs.
**Observed:** `next` equals the stored list, so no save and no remount. The textarea still shows the dropped line until
the page reloads. The owner believes `re` is on the list, and gets no message saying it was rejected.
**Expected:** the field is reset to the cleaned list (or the drop is reported to him).

The same pattern is in the existing "Names that are you" field. Not new, but copied.

```ts
describe("RT-7 the field can show a phrase the runner is not using", () => {
  test("onBlur resets the textarea when cleaning dropped or changed a line", () => {
    const src = readFileSync("src/features/huddle/components/ActionsView.tsx", "utf8");
    const block = src.slice(src.indexOf('data-testid="actions-alert-skip-field"'), src.indexOf('data-testid="actions-alert-skip"'));
    // Condition: ["meeting minutes", "re"] cleans to ["meeting minutes"] == stored -> no onChange, no remount, "re" stays visible.
    expect(cleanAlertSkipSubjects(["meeting minutes", "re"])).toEqual(["meeting minutes"]);
    expect(block).toMatch(/e\.target\.value\s*=/);
  });
});
```

Observed: 1/1 fails (a source assertion; a Playwright check per AC-43 is the live form). Related: the textarea's
`maxLength` (50 x 121 = 6050) truncates a long paste mid-line. A truncated last line becomes a SHORTER phrase, the
over-exclusion that AC-19 avoids by dropping rather than cutting. Only reachable by pasting more than 6,050 characters.

## RT-8 — phrases with no letter or digit are accepted (LOW, owner-typed over-exclusion)

**Input:** `cleanAlertSkipSubjects(["​​​", "...", "?!?"])`.
**Observed:** `["​​​", "...", "?!?"]`. The 3-character minimum counts invisible and punctuation characters.
With the phrase `...`, the edge check is vacuous: `Hmm ... can you check the budget?` is excluded.
**Expected:** phrases with no `\p{L}`/`\p{N}` are dropped, like phrases under 3 characters (the same "a wrong exclusion is
invisible" reasoning as `ALERT_SKIP_MIN_CHARS`).

```ts
describe("RT-8 the cleaner accepts phrases with no letters or digits", () => {
  test("invisible-only and punctuation-only phrases are dropped", () => {
    expect(cleanAlertSkipSubjects(["​​​", "...", "?!?"])).toEqual([]);
  });
  test("a punctuation-only phrase does not swallow a real ask", () => {
    expect(subjectExcluded("Hmm ... can you check the budget?", ["..."])).toBe(false);
  });
});
```

Observed: 2/2 fail.

## RT-9 — a CJK phrase never matches inside unspaced CJK text (LOW, false pass)

**Input:** phrase `会议纪要` ("meeting minutes"), subject `本周会议纪要`. **Observed:** not excluded, because CJK characters are
`\p{L}`, and CJK subjects have no spaces, so the letter-edge rule never holds. **Expected:** excluded. LOW: an
English-language owner and Huddle's English subjects.

```ts
describe("RT-9 CJK phrase inside unspaced CJK text never matches", () => {
  test("会议纪要 inside 本周会议纪要", () => {
    expect(subjectExcluded("本周会议纪要", ["会议纪要"])).toBe(true);
  });
});
```

Observed: 1/1 fails.

---

## Checked and held (no finding)

- **OK-1, public run log (`run-inbound-email.yml`).** An excluded `decisions` row is `{ received, fromDomain, verdict: { keep:
  false, reason: "excluded-subject" } }` with no subject and no `turnId`. `loadAlertSkipSubjects` logs only `err.name`. The
  list is never put in the result. `fromDomain` was already there before this change, for every screened row.
- **OK-2, other callers.** `git diff --stat HEAD~1 HEAD` shows no change to `proposals/`, `correspondence/bell.ts` or
  `scripts/fixtures/`. `proposals.ts:80` and `scripts/onedrive-feed-dryrun.ts:47` call `screenMessage` with 3 arguments,
  which skips the new branch. `asksSomething` is unchanged. Suites: `needs-you.test.ts` 77/77 (the pin holds),
  `inbound-email.test.ts` 72/72, `inbound-alert-exclusions.test.ts` 61/61.
- **OK-3, throws and size.** Metacharacter phrases are literal (`indexOf`, no `RegExp` built from input). `null`/non-string
  subjects and phrases are wrapped in `String(...)`. Worst case measured: a 10,000-character `aaaa...` subject against 50
  overlapping `aaa...` phrases took **17 ms**. Graph caps subjects far below that.
- **Order.** The resend path (`resendOwed`) and the `MAX_PER_RUN` cap come after the screen, so an excluded message
  never reaches either.
- **Huddle's own subjects.** `minutesSubject()` always emits the ASCII prefix `Meeting Minutes: ` / `Updated Meeting
  Minutes: `. No false pass was found for any theme, with or without a date label.
- **Observation, not scored:** `loadAlertSkipSubjects` ignores the runner's `caller` and always reads the configured
  owner's row (`actionsConfig().owner`). If a second user ever runs inbound alerts, that user gets the owner's list. This
  is the design per C1, and it is harmless while there is only one user.

## Verdict

**NOT CLEAN: 2 HIGH, 2 MEDIUM, 5 LOW.** The serious defect that is not a spec decision is RT-1: replies with
`AW:`/`SV:`/`Antw:`/`WG:`/`TR:`/`RV:`/`RE[n]:` prefixes (which the codebase's own `stripReplyPrefixes` already
recognises) are silently excluded. RT-2 and RT-3 are spec-accepted false exclusions for the owner to decide. RT-6 can
reset the owner's list on a failed read.
