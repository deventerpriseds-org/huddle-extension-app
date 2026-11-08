// WHAT:       tests for paged chat history (lib/identity/workspace-window.ts) + source pins on its wiring.
// WHY:        the app downloaded the whole 2.6 MB history on every open (2026-11-07). The dangerous part is the
//             SAVE: a client holding only recent messages must never erase older ones. M1-M5 pin that.
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   run with `npm run test:workspace-window`.
import { readFileSync } from "node:fs";
import { describeLoadFailure, mergeMessages, olderPage, prependOlder, shouldAppendReminder, windowMessages } from "../src/features/huddle/lib/identity/workspace-window";

let fail = 0;
const check = (n: string, ok: boolean, d = "") => { console.log(`${ok ? "PASS" : "FAIL"} ${n}${!ok && d ? ` — ${d}` : ""}`); if (!ok) fail++; };
const DAY = 86_400_000;
const NOW = Date.parse("2026-11-08T12:00:00Z");
const msg = (id: string, huddleId: string, daysAgo: number, text = id) => ({ id, huddleId, ts: NOW - daysAgo * DAY, text });

// a busy 1:1 (100 msgs over 100 days) and a quiet one (5 msgs, all old)
const busy = Array.from({ length: 100 }, (_, i) => msg(`b${i}`, "dm-iris", 100 - i));
const quiet = Array.from({ length: 5 }, (_, i) => msg(`q${i}`, "dm-troy", 200 - i));
const all = [...busy, ...quiet];

// window
const w = windowMessages(all, NOW, 30, 10);
const wIds = new Set(w.messages.map((m) => m.id));
check("W1 keeps every message from the last 30 days", busy.filter((m) => m.ts >= NOW - 30 * DAY).every((m) => wIds.has(m.id)));
check("W2 drops older messages of a busy huddle", !wIds.has("b0") && !wIds.has("b50"));
check("W3 a quiet huddle still gets its newest messages", quiet.every((m) => wIds.has(m.id)));
check("W4 olderCount counts what was left out", w.olderCount === all.length - w.messages.length && w.olderCount > 0);
check("W5 window keeps the stored order", w.messages.map((m) => m.id).join() === all.filter((m) => wIds.has(m.id)).map((m) => m.id).join());

// merge: client holds only the window, edits one message, adds two
const edited = { ...w.messages[w.messages.length - 1], text: "edited" };
const clientMsgs = [...w.messages.slice(0, -1), edited, msg("new1", "dm-iris", 0), msg("new2", "all-members", 0)];
const merged = mergeMessages(all, clientMsgs);
const mIds = merged.map((m) => m.id);
check("M1 nothing the client never loaded is lost", all.every((m) => mIds.includes(m.id)));
check("M2 new client messages are added", mIds.includes("new1") && mIds.includes("new2"));
check("M3 the client's copy replaces the stored copy", merged.find((m) => m.id === edited.id)?.text === "edited");
check("M4 no duplicates", new Set(mIds).size === mIds.length);
check("M5 stored order kept, new messages appended", mIds.slice(0, all.length).join() === all.map((m) => m.id).join() && mIds.slice(-2).join() === "new1,new2");
check("M6 a client with NO messages still erases nothing", mergeMessages(all, []).length === all.length);

// older page
const before = w.messages.filter((m) => m.huddleId === "dm-iris")[0].ts;
const p1 = olderPage(all, "dm-iris", before, 25);
check("P1 page is older than the cursor, this huddle only, oldest first", p1.messages.length === 25 && p1.messages.every((m) => m.ts < before && m.huddleId === "dm-iris") && p1.messages[0].ts < p1.messages[24].ts);
check("P2 page is the NEWEST of the older ones", p1.messages[24].id === busy.filter((m) => m.ts < before).slice(-1)[0].id);
check("P3 hasMore true while older remain, false at the end", p1.hasMore && !olderPage(all, "dm-iris", p1.messages[0].ts, 1000).hasMore);

// prepend
const cur = [msg("x1", "dm-iris", 1), msg("x2", "all-members", 0)];
const pre = prependOlder(cur, [msg("o2", "dm-iris", 40), msg("o1", "dm-iris", 50), msg("x1", "dm-iris", 1)]);
check("R1 older go in front oldest-first, existing order untouched, dupes skipped", pre.map((m) => m.id).join() === "o1,o2,x1,x2");
check("R2 nothing new -> same array (no re-render)", prependOlder(cur, [cur[0]]) === cur);

// wiring pins
const fns = readFileSync("src/features/huddle/lib/identity/workspace.functions.ts", "utf8");
const sync = readFileSync("src/features/huddle/hooks/useWorkspaceSync.ts", "utf8");
const view = readFileSync("src/features/huddle/components/HuddleView.tsx", "utf8");
check("S1 load windows ONLY when the client asks (old cached clients get everything)", /if \(recentDays && Array\.isArray\(state\.messages\)\)/.test(fns));
check("S2 save merges ONLY when the client asks (old clients replace as before)", /if \(mergeMessages\) return saveMergedImpl\(/.test(fns) && /data\.mergeMessages === true/.test(fns));
check("S3 merge happens under a row lock", /FOR UPDATE/.test(fns) && /mergeMessages\(stored, incoming\)/.test(fns));
check("S4 the app asks for the window AND merges its saves", /recentDays: RECENT_DAYS/.test(sync) && /mergeMessages: true/.test(sync));
check("S5 scrolling to the top fetches older pages", /else if \(start <= 0 && m\.scrollTop < LOAD_OLDER_PX\) void fetchOlder\(\);/.test(view) && /loadOlderMessages\(\{/.test(view));
check("S6 fetched pages pass the same filter as hydrate", /\.filter\(isRenderableMessage\)/.test(view));

// alarms/reminders (owner 2026-11-08: Aug/Sep alarms appeared at the bottom of today's thread)
const loaded = [msg("l1", "dm-iris", 10), msg("l2", "dm-iris", 2)];
check("A1 an alarm older than the oldest loaded message is NOT appended (it comes with older pages)", !shouldAppendReminder(NOW - 90 * DAY, loaded));
check("A2 an alarm that fired after the window start IS appended", shouldAppendReminder(NOW - 1 * DAY, loaded));
check("A3 boundary: same instant as the oldest loaded counts as loaded range", shouldAppendReminder(NOW - 10 * DAY, loaded));
check("A4 a thread with nothing loaded takes every alarm", shouldAppendReminder(NOW - 300 * DAY, []));
check("A5 messages without a usable ts don't define the window", shouldAppendReminder(NOW - 90 * DAY, [{ id: "z" }, { id: "y", ts: NaN }]));
const pollStart = view.indexOf("// Reminder delivery:");
const pollSrc = view.slice(pollStart, view.indexOf("}, [huddle.id]);", pollStart));
check("A6 the reminder poll applies the rule before appending", /const inThread = all\.filter\(\(m\) => m\.huddleId === huddle\.id\);\s*\n\s*if \(!shouldAppendReminder\(r\.firedMs, inThread\)\) return;/.test(pollSrc));
check("A7 the reminder poll waits for the history to load (hydrate replaces the list)", /if \(!isWorkspaceHydrated\(\)\) \{/.test(pollSrc) && pollSrc.indexOf("isWorkspaceHydrated()") < pollSrc.indexOf("getReminderDeliveries({"));

// load-failure reason (owner option A, 2026-11-08)
const jose = (code: string, message: string) => Object.assign(new Error(message), { code });
check("E1 expired sign-in", describeLoadFailure(jose("ERR_JWT_EXPIRED", '"exp" claim timestamp check failed')).startsWith("sign-in expired: "));
check("E2 rejected sign-in (audience)", describeLoadFailure(jose("ERR_JWT_CLAIM_VALIDATION_FAILED", 'unexpected "aud" claim value')).startsWith("sign-in rejected: "));
check("E3 rejected sign-in (signature)", describeLoadFailure(jose("ERR_JWS_SIGNATURE_VERIFICATION_FAILED", "signature verification failed")).startsWith("sign-in rejected: "));
check("E4 network", describeLoadFailure(new TypeError("Failed to fetch")).startsWith("couldn't reach the server: "));
check("E5 unknown error keeps the raw text", describeLoadFailure(new Error("relation \"identity.workspace_state\" does not exist")) === 'server error: relation "identity.workspace_state" does not exist');
check("E6 empty error -> bare label, long text is cut", describeLoadFailure({}) === "server error" && describeLoadFailure(new Error("x".repeat(300))).length < 120);
check("E7 the loader shows the described reason, not a fixed 'server error'", /failed\(attempt, describeLoadFailure\(e\)\);/.test(sync) && !/failed\(attempt, "server error"\)/.test(sync));
check("E8 the retry toast says why it is retrying", /Loading your message history… \(retrying: \$\{why\}\)/.test(sync));
console.log(fail ? `${fail} failed` : "all passed");
process.exit(fail ? 1 : 0);
