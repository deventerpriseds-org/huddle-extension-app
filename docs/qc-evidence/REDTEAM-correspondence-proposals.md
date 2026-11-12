# REDTEAM -- correspondence data layer + task proposals (Tier 1 pre-pass)

- WHAT:       Adversarial pre-pass findings against branch `claude_task-proposals` (head `8475140c`).
- WHY:        Tier 1 (model output -> stored claim; the bell names who owes a reply). The coordinator asked for a
              red-team pass before the PR. Every finding below has a repro in
              `scripts/redteam-correspondence.test.ts` (asserts the CORRECT answer, so FAIL = confirmed).
- SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
- EVIDENCE:   `bun scripts/redteam-correspondence.test.ts` -> 16 passed, 33 failed at `8475140c`
              (the failures are the findings; the PASS lines are probes the change survived).
              Existing suites still green at that head: task-proposals.test.ts 131/0, correspondence-ingest.test.ts 148/0.
              Postgres 16 check: `SELECT '2026-02-30'::date` -> `ERROR: date/time field value out of range`.

No production code was changed. Tests only.

## Findings table

Severity: blocker = must fix before merge; major = wrong stored claim / wrong bell state / flag contract broken;
minor = wrong but low impact, recall loss, or only in synthetic mode.

### CONFIRMED (a test demonstrates the wrong answer)

| # | finding | severity | repro test | cause file:line |
|---|---|---|---|---|
| F1 | `"teams": false` (also `"teams": "off"`) **enables** the Teams log; with `correspondence.ingest:true` the pass reads Teams. Violates AC-6.1 ("teams absent/disabled -> ZERO Graph calls for Teams"). | **blocker** (flag contract) | RT-22, RT-22b, RT-22d | `onedrive-feed.ts:113` (`file()` treats any non-object as `{}` -> `enabled: o.enabled !== false` = true), reached from `teamsFile` `onedrive-feed.ts:141` |
| F2 | `"sent": false` **enables** Sent Items settlement in the LIVE owed-work-email path (`reconcileRepliedFromSentItems`), which is not gated by any `correspondence` flag. An owner who writes `sent:false` to be safe turns it on. | major | RT-22c | `onedrive-feed.ts:132` + `:113`; consumer `email-replies.server.ts:294` (`!cfg.sent.enabled`) |
| F3 | Impossible ISO due date (`2026-02-30`, `2026-13-45`) passes `resolveDueDate`; the store's `$8::date` cast then throws (`date/time field value out of range`), so the WHOLE source item fails, retries to terminal, and every later to-do in that item is never stored. One bad date poisons the item. | major | RT-8, RT-8b (+ psql check above) | `proposals.ts:324` (`Number.isNaN(ymdToUtc(...))` is never NaN for numeric parts; no round-trip check like the month-day branch has at `:335`); `proposals-store.server.ts` upsertOnce `$8::date` |
| F4 | Title grounding = ONE shared 5-letter stem. An invented amount/account rides along: evidence "Please send the invoice to Dana by Friday" grounds task "Send $40,000 wire to account 99-1234". The title is what Approve writes to the board. | major | RT-1 | `proposals.ts:269-272` |
| F5 | Evidence minimum is 8 chars, so a pleasantry fragment grounds an invented task: source "We loved the deck you sent last week, thanks!", evidence "the deck", task "Redo the deck" -> accepted. This is the AC's own "Thanks -> Book flights" class with one shared noun. | major | RT-2 | `proposals.ts:36` (`EVIDENCE_MIN = 8`) + `:269-272` |
| F6 | Stem truncation to 5 letters makes unrelated words match ("presentation" ~ "preserve"). | minor | RT-3 | `proposals.ts:193` (`w.slice(0, 5)`) |
| F7 | Negation dropped: a verbatim FRAGMENT of "Please do NOT send the contract to the client until legal signs off" ("send the contract to the client") is accepted as evidence, and the checklist shows only that fragment, so the owner cannot see the "do NOT". Substring-only grounding cannot tell a quote from a cherry-picked clause. | major | RT-4 | `proposals.ts:263` (substring anywhere; no sentence/clause boundary) |
| F8 | Hidden HTML text (`display:none` span) becomes source text; a task from text the owner never saw in Outlook is accepted end to end. Known phishing/injection vector. | major | RT-13, RT-13b | `onedrive-feed.ts:350-369` `htmlToText` (strips tags, keeps hidden element text) |
| F9 | Quoted history not cut for non-English headers (`De :/Envoyé :`, `Von:/Gesendet:`) or a Gmail attribution wrapped over two lines with unprefixed history -> history is "new text", violating AC-5.19 / S-13. | minor (English-only org) / major if any non-English correspondent | RT-12, RT-12b, RT-12c | `inbound-email.ts:80-85` `newTextOnly` |
| F10 | `due_text` is accepted when it is ANY substring of the evidence (e.g. the whole sentence), not date words; and the resolver then scans that text. Combined with F11 the stored due date can come from non-date words. | minor | RT-10 | `proposals.ts:285` |
| F11 | Month regex matches word prefixes: "marketing 2" -> Mar 2 (2027-03-02), "decide 3 vendors" -> Dec 3. First-keyword-wins: "by tomorrow, not today" -> today. | minor | RT-9, RT-9b, RT-9c | `proposals.ts:325-327` (`(${MONTHS})[a-z]*` and keyword order) |
| F12 | Assignee kept whenever the word appears in the evidence, person or not ("Friday"), and regardless of role ("Bob asked me to ..." -> assignee Bob). AC-5.20 says the person the evidence names as DOING it. Display-only. | minor | RT-11, RT-11b | `proposals.ts:201-207` |
| F13 | Zero-width / homoglyph characters in the model's TITLE survive `canonicalSpan` and `normalizeTaskTitle`, so (a) a to-do already open on the board is still proposed, and (b) Approve's dedup misses and creates a SECOND board task. | minor (model-induced) | RT-7, RT-7b, RT-25, RT-25b | `proposals.ts:175-183` (no ZW/NFKC fold on title), `scoring.ts:45-56` |
| F14 | A dismissed to-do REAPPEARS when the same source item is re-extracted (edited message -> new content hash -> ledger re-pends it; or a transcript re-processed) and the model words it slightly differently ("Send the Q3 deck" -> "Send Q3 deck"): dedup key includes the exact normalized title. AC-5.12 / AC-5.21 ("same to-do stated on two runs"). | major | RT-24 | `proposals.ts:354-356` (`proposalId` / refs keyed on `normTitle`); `proposals-store.server.ts` upsertOnce step 1 |
| F15 | Cross-source: after the email proposal is dismissed, the same to-do from Teams creates a new proposal (only ACTIVE rows attach). Possibly intended under OQ-9; flagging so it is a decision, not an accident. | minor / design | RT-24b | `proposals-store.server.ts` upsertOnce step 2 (`state = 'proposed'` only) |
| F16 | A Teams message with NO sender id is `fromOwner=false` (not "can't tell") when owner ids are configured. A sender-less message (possibly the owner's own reply) that asks something becomes the open ask -> bell shows OWED, not "Can't tell". AC-4.6 says never "unanswered" when it can't be established. | major | RT-16, RT-16b | `teams-log.ts:208` (`owners.has(who.id)` with `who.id === ""`) ; `bell.ts:48` (`configured` only checks `!== null`) |
| F17 | Plain-text (or string) Teams bodies keep URLs, so a link's `?` makes the message an "ask" -> owed bell row. The HTML path replaces URLs with `[link]`; the text path does not. | minor | RT-17 | `teams-log.ts:85,91` (`content.trim()` for non-html) ; `bell.ts:29` |
| F18 | Synthetic mode: Sent Items records must START with the subject prefix, but a reply subject is `RE: <prefix>...`, so in the sandbox an answered synthetic email can never settle (false "owed" during UAT of option A). | minor | RT-23 | `onedrive-feed.ts:289` |
| F19 | HTML numeric/named entities other than the 6 handled (`&#8217;`, `&rsquo;`, `&#160;`) are left literal; a correct verbatim quote with a real apostrophe is refused (recall loss, safe direction). | minor | RT-14, RT-14b | `onedrive-feed.ts:359-364` |

### PASSED probes (the change held)

RT-5 mid-word fragment without a shared stem refused; RT-6/6b injected task with no verbatim span, empty/1-char/whitespace evidence refused;
RT-7c/7d evidence-side ZW char refused, NBSP/curly normalised; RT-12d English From:/Sent: block cut; RT-15 Teams reply blockquote dropped;
RT-19/19b truncated last JSONL line skipped+counted, owner id case-insensitive; RT-20/20b live config + missing or string `synthetic` skipped;
RT-21/21b/21c `correspondence` flags "true"/1/missing all OFF, malformed JSON -> null, existing config with no new keys -> teams/sent/correspondence all off.

### SUSPECTED (reasoned from code, not demonstrated by a test)

| # | suspicion | severity | where |
|---|---|---|---|
| S1 | Timestamps without an offset (`2026-11-10T10:00:00`) pass `isIso` and are parsed in the PROCESS time zone, so Sent-Items settle and Teams ordering depend on the host TZ. Harmless on a UTC host; wrong anywhere else. | minor | `onedrive-feed.ts:89`, `teams-log.ts:63` |
| S2 | `ownerMessagesExported` = "the owner appears in ANY chat of the log". A chat whose owner messages are not exported (e.g. a channel or a chat the flow skips) is then decided OWED instead of can't-tell. | minor | `bell.ts:93` |
| S3 | Ties (owner message at the same instant as the ask) resolve to "answered" (RT-18, RT-19c PASS as notes). Defensible, but it is a silent choice. | note | `bell.ts:46`, `email-replies.server.ts` settleChatAttention `received_at <= $3` |
| S4 | Approve: if `createTask` succeeds and `finishApprove` fails, the lease is NOT released and the row stays `proposed`; after the 90s lease, a second Approve with a failed open-task read (fail-open) creates a duplicate task. Needs two independent failures. | minor | `engine.ts:249-250` |
| S5 | Privacy: new code paths log counts/categories only (grep of console.* in proposals/, correspondence/, teams-log). One line logs a raw pg `err.message` (`[onedrive-feed] teams state write failed`); pg messages rarely carry values (details are in `err.detail`), so likely safe. | note | `onedrive-feed.server.ts:245` |
