// WHAT:       OPT-IN checks module for run-uat.mjs: starts a REAL daily stand-up in the owner's account and drives voice
//             barges into it (FAKE_MIC + ElevenLabs), measuring time to first reply and to completion.
// WHY:        Split out of huddle-checks.mjs on 2026-11-16. As part of the DEFAULT verify-uat suite it started a real
//             stand-up on every full run -- four runs on 2026-11-15 produced four stand-ups in the owner's account
//             (19:07, 19:17, 19:31, 21:02 ET) -- and its long-task barge saved real artifacts and started a real
//             specialist task. The default suite no longer starts a ceremony; run this module ONLY when the
//             ceremony/voice path is what is being verified:
//               verify-uat.yml  checks_file=.claude/skills/test-agent-serverfn/scripts/ceremony-voice-checks.mjs
//             Every phrase that can create or change a task / artifact carries the `Test-` prefix (repo CLAUDE.md
//             "Test-task naming convention"), so what a run leaves behind is cleanly removable.
// SUPERSEDES: the standupCeremonyTiming check that lived in huddle-checks.mjs (moved here unchanged except the phrases).
// SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   docs/qc-evidence/BUILD-correspondence-tuning-fixes.md (fix 4); scripts/uat-suite-safety.test.ts.
//
// AUTH NOTE (same as huddle-checks.mjs): the ?uat_token= bypass is single-use, so nothing here reloads the page.

// A barge answer must be the agent HEARING the user and responding — never one of the old hardcoded
// client deferrals. If any of these phrases come back, the canned path is still firing.
export const CANNED_RE =
  /i'?ll dig into that|take care of it (right )?after we wrap|knock it out as soon as we finish|i'?ll look into that|okay, i'?ll take care of that status|i'?ll get that updated/i;

// The spoken barge lines, in order. Exported so scripts/uat-suite-safety.test.ts can hold every line that could
// create or change a task / artifact to the `Test-` rule. Read-only lines (a hail, a count question) need no prefix.
export const VOICE_BARGES = [
  { label: "1-hail", text: "Hey, Sam." },
  // Parks a task: it targets a Test- task, never one of the owner's real ones.
  { label: "2-park", text: "Sam, put the Test- investor pitch in the parking lot." },
  { label: "3-quick", text: "How many blockers are on the board right now?" },
  // A long task an agent may research and save as an artifact / start as a specialist task: Test- prefixed.
  { label: "4-long-task", text: "Test- research the competitor's premium pricing and write it up for me." },
];

// ── Real voice barge: synthesize the phrase with ElevenLabs, play it INTO the fake mic (run-uat's
//    FAKE_MIC stub), and let the app's REAL VAD→barge→STT path hear it. Unlike a typed barge, this
//    exercises detection latency, the interrupt, and transcription of real speech.
const EL_KEY = process.env.ELEVENLABS_API_KEY;
const EL_VOICE = process.env.ELEVENLABS_DEFAULT_VOICE_ID || process.env.ELEVENLABS_VOICE_ID;
async function ttsClipBase64(text) {
  if (!EL_KEY || !EL_VOICE) return null;
  try {
    const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${EL_VOICE}`, {
      method: "POST",
      headers: { "xi-api-key": EL_KEY, "content-type": "application/json", accept: "audio/mpeg" },
      body: JSON.stringify({ text, model_id: "eleven_flash_v2_5" }),
    });
    if (!r.ok) return null;
    return Buffer.from(await r.arrayBuffer()).toString("base64");
  } catch {
    return null;
  }
}
async function voiceBarge({ page, check, screenshot }, { label, text }) {
  const turnSel = '[data-testid="transcript-turn"]';
  const b64 = await ttsClipBase64(text);
  if (!b64) {
    check(`Voice barge (${label}) — ElevenLabs clip ready`, false, "no clip (missing EL key/voice or API error)");
    return "";
  }
  // Read the barge ANSWER by its own marker, never by position. The ceremony keeps speaking while a
  // barge is answered, so "the row after mine" is often the next scripted line or the "…" placeholder
  // of the spoken turn itself (verify-uat 42483232750 / 42486645869). MeetingBar marks the spoken turn
  // data-turn-user + data-turn-kind="barge" and every barge answer/ack data-turn-kind="answer".
  const userSel = `${turnSel}[data-turn-user="true"][data-turn-kind="barge"]`;
  const answerSel = `${turnSel}[data-turn-agent="true"][data-turn-kind="answer"]`;
  const userBefore = await page.locator(userSel).count();
  const answersBefore = await page.locator(answerSel).count();
  await page.evaluate((b) => (window.__playBarge ? window.__playBarge(b) : Promise.reject("no fake mic")), b64).catch(() => {});
  let got = false;
  try {
    await page.waitForFunction(
      ([u, a, us, as]) => document.querySelectorAll(us).length > u && document.querySelectorAll(as).length > a,
      [userBefore, answersBefore, userSel, answerSel],
      { timeout: 45000 },
    );
    got = true;
  } catch { /* capture whatever rendered */ }
  await page.waitForTimeout(1200); // let the answer's first sentence finish rendering
  const answers = await page.locator(answerSel).allInnerTexts();
  const reply = (answers[answersBefore] || "").replace(/\s+/g, " ").trim();
  await page.locator('[data-testid="tab-transcript"]').click().catch(() => {});
  await screenshot(`vbarge-${label}`);
  check(`Voice barge (${label}) HEARD through the mic and answered`, got && reply.length > 0 && !CANNED_RE.test(reply), `reply="${reply.slice(0, 160)}"`);
  await page.waitForTimeout(2500);
  return reply;
}

const barge = (label) => VOICE_BARGES.find((b) => b.label === label);

export const checks = [
  // The user's reported standup-ceremony gap (~93s hang before any reply appears). Drive the real
  // "Meeting -> Daily stand-up -> Start" flow and measure actual wall-clock time to (a) first
  // transcript message, (b) ceremony completion — the exact experience being reported.
  async function standupCeremonyTiming({ page, check, screenshot }) {
    // HuddleView renders `null` when activeHuddleId points at a huddle not in the visible list
    // (e.g. the default "daily" demo huddle, filtered out for a real non-demo account) — which
    // hides the whole header including the Meeting button. Select a REAL visible huddle from the
    // sidebar first so the check reflects the actual user experience, not a stale demo default.
    const groupSection = page.locator("div.mb-2", { has: page.locator("span", { hasText: "Group huddles" }) });
    const firstGroupHuddle = groupSection.locator("div.flex.flex-col > button").first();
    const gotGroupHuddle = await firstGroupHuddle
      .waitFor({ state: "visible", timeout: 8000 })
      .then(() => true)
      .catch(() => false);
    if (gotGroupHuddle) {
      await firstGroupHuddle.click();
      await page.waitForTimeout(300);
    }

    const meetingBtn = page.locator("button", { hasText: /^Meeting$/ }).first();
    const meetingBtnVisible = await meetingBtn
      .waitFor({ state: "visible", timeout: 8000 })
      .then(() => true)
      .catch(() => false);

    let detail = gotGroupHuddle ? "selected a real group huddle first" : "no group huddle found to select — tried Meeting button directly";
    if (!meetingBtnVisible) {
      // Diagnostic dump so a failure here tells us WHY instead of needing another blind guess-and-check round.
      const groupHeadingCount = await page.locator("span", { hasText: "Group huddles" }).count();
      const groupButtonCount = await groupSection.locator("button").count();
      const dmHeadingCount = await page.locator("span", { hasText: "Agent channels" }).count();
      const allButtonTexts = await page.locator("aside button, nav button").allInnerTexts();
      detail = `groupHeading=${groupHeadingCount} groupButtons=${groupButtonCount} dmHeading=${dmHeadingCount} sidebarButtonTexts=${JSON.stringify(allButtonTexts.slice(0, 30))}`;
    }
    check("Meeting button visible after selecting a real huddle", meetingBtnVisible, detail);
    if (!meetingBtnVisible) return;

    await meetingBtn.click();
    await page.waitForTimeout(300);
    await page.locator("text=Daily stand-up").first().click();
    await page.waitForTimeout(500);
    await screenshot("standup-ready");

    const startBtn = page.locator("button", { hasText: /^Start$/ }).first();
    const startVisible = await startBtn.count();
    check("Standup ceremony room opens with a Start button", startVisible === 1);
    if (!startVisible) return;

    // Baseline: turns.length===0 renders NO [data-testid="transcript-turn"] elements (just a
    // placeholder div), so any count > 0 after Start is a genuine new turn — not a false positive
    // from loose keyword matching against the whole page (the previous version of this check
    // matched task-board text like "Priority"/"Blocked" that's on screen regardless of the
    // ceremony, producing a bogus "51ms" first-reply reading that wasn't real evidence).
    const turnRow = page.locator('[data-testid="transcript-turn"]');
    const baselineTurns = await turnRow.count();

    const t0 = Date.now();
    await startBtn.click();

    // Time to first visible transcript reply.
    let firstReplyMs = null;
    let firstReplyError = null;
    try {
      await page.waitForFunction(
        (baseline) => document.querySelectorAll('[data-testid="transcript-turn"]').length > baseline,
        baselineTurns,
        { timeout: 150000 },
      );
      firstReplyMs = Date.now() - t0;
    } catch (err) {
      firstReplyError = err.message;
    }
    check(
      "First standup reply appears within 15s (the user's expected/fixed latency)",
      firstReplyMs !== null && firstReplyMs <= 15000,
      firstReplyMs !== null
        ? `first real transcript turn observed after ${firstReplyMs}ms`
        : `no new transcript turn within 150s — ${firstReplyError ?? "unknown error"}`,
    );
    await screenshot("standup-in-progress");

    // ── BARGE demonstration (ACT-huddle-26) ── the ceremony is now LIVE (first reply rendered), so
    // inject the barge types and prove each gets a real, HEARD answer — not the old canned "I'll dig into
    // that". Mutating barges use Test- titles (VOICE_BARGES above).
    await page.waitForTimeout(1200); // let a scripted speaker be mid-turn so the barge truly cuts in
    // ── Two-stage VOICE-barge scenario (the user's exact flow) via real synthesized speech through the
    //    mic (FAKE_MIC + ElevenLabs), so the REAL VAD→barge→STT path runs. Screenshots + ceremony_transcript
    //    (spoken rows + kind='tool' rows) + journey DB then tell us, per AC: did Sam ACK the hail (stage 1)?
    //    did the park NAME the pitch + actually persist (stage 2)? quick query answered live? long task
    //    deferred or does it freeze the room?
    const micReady = await page.evaluate(() => !!window.__fakeMicReady);
    const micErr = micReady ? "" : await page.evaluate(() => window.__fakeMicError || "unknown");
    check("Fake mic installed (getUserMedia stub ready for voice barge)", micReady, micErr);

    // NOISE GUARD (the user's report: mic noise → "Mhm."/"어?" → agents answered nothing): a filler barge
    // must be IGNORED — no agent reply, ceremony just continues. Typed here per the user's "type mhm".
    {
      const turnSel = '[data-testid="transcript-turn"]';
      await page.locator('[data-testid="tab-chat"]').click().catch(() => {});
      await page.waitForTimeout(300);
      const noiseBox = page.locator('textarea[placeholder="Message the room…"]').first();
      if (await noiseBox.count()) {
        // Count only barge ANSWER rows: the ceremony's own scripted lines keep arriving meanwhile.
        const answerSel = `${turnSel}[data-turn-agent="true"][data-turn-kind="answer"]`;
        const beforeNoise = await page.locator(answerSel).count();
        await noiseBox.fill("mhm");
        await noiseBox.press("Enter");
        await page.waitForTimeout(6000); // give it ample time to (wrongly) wake an agent
        const afterNoise = await page.locator(answerSel).count();
        await page.locator('[data-testid="tab-transcript"]').click().catch(() => {});
        await screenshot("noise-mhm-ignored");
        check("Typed 'mhm' noise barge is IGNORED (no agent reply)", afterNoise - beforeNoise === 0, `answer rows added=${afterNoise - beforeNoise} (>0 ⇒ an agent wrongly answered the noise)`);
      }
    }
    // UNMUTE FIRST. Since 2026-10-19 the ceremony starts with the barge mic MUTED by design
    // (MeetingBar.tsx: "Muted (the default at ceremony start)"). Without this tap the fake-mic clips
    // played below never reach the app: verify-uat runs 42452437543 / 42483232750 showed NO spoken turn
    // in the transcript ("mic muted — tap the mic to talk" on screen), and voiceBarge then read the next
    // scripted line as the "answer" -- a false HEARD pass and false hail/park failures.
    {
      // RoomControl renders an icon-only button (aria-label) with the word beside it in a span.
      const unmute = page.locator('button[aria-label="Unmute"]').first();
      if (await unmute.count()) await unmute.click().catch(() => {});
      const live = await page
        .locator("text=/mic — (listening|hearing you)/")
        .first()
        .waitFor({ state: "visible", timeout: 8000 })
        .then(() => true)
        .catch(() => false);
      const shown = live ? "" : await page.locator("text=/mic muted|mic —/").first().innerText().catch(() => "no mic indicator");
      check("Ceremony barge mic unmuted and listening before voice barges", live, shown);
    }
    // Stage 1 — bare hail: expect a brief ack ("yes?"), NOT a lane update, NOT a park.
    const hailReply = await voiceBarge({ page, check, screenshot }, barge("1-hail"));
    check("Hail 'Hey Sam' gets a short ready-ack, not a lane update", /\b(yes|go ahead|what'?s up|listening|sir)\b/i.test(hailReply) && hailReply.length < 90, `hailReply="${hailReply.slice(0, 120)}"`);
    // Stage 2 — the real command: expect an ack that NAMES the pitch + a real persisted park.
    const parkReply = await voiceBarge({ page, check, screenshot }, barge("2-park"));
    check("Park ack NAMES the investor pitch (not a generic 'got it')", /investor pitch|pitch/i.test(parkReply), `parkReply="${parkReply.slice(0, 160)}"`);
    // Quick query — expect a live answer during the ceremony.
    await voiceBarge({ page, check, screenshot }, barge("3-quick"));
    // Long task — does it defer with a specific ack, or freeze the room? (baseline: expected to freeze today)
    await voiceBarge({ page, check, screenshot }, barge("4-long-task"));

    // Time to full ceremony completion (button reverts to "Run again").
    let doneMs = null;
    let doneError = null;
    try {
      // waitForFunction(fn, ARG, OPTIONS): the options object used to sit in the ARG slot, so the
      // intended 180s never applied and every run gave up at Playwright's 30s default.
      await page.waitForFunction(
        () => Array.from(document.querySelectorAll("button")).some((b) => b.textContent?.trim() === "Run again"),
        undefined,
        // 8 min: a full voiced round of every agent's update ran past 4 minutes and was still healthy
        // (run 42487020520: Iris mid-update at 04:12, 36 rows). The job allows 15 min in total.
        { timeout: 480000 },
      );
      doneMs = Date.now() - t0;
    } catch (err) {
      doneError = err.message;
    }
    const finalTurnCount = await turnRow.count();
    check(
      "Standup ceremony reaches completion (Run again shown)",
      doneMs !== null,
      doneMs !== null
        ? `completed after ${doneMs}ms total, ${finalTurnCount} turns rendered`
        : `did not reach completion — ${doneError ?? "unknown error"} (${finalTurnCount} turns rendered when this check gave up)`,
    );
    await screenshot("standup-final-state");
  },
];
