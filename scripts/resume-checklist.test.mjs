// P1 — offline proof of (a) the splitSentences fix and (b) the new resume = repeat-interrupted +
// continue-the-list behavior. Replaces resume-index.test.mjs (which asserted the OLD resume-from-next).
//   Run: node scripts/resume-checklist.test.mjs
// The regex + loop MIRROR useCeremonyVoice.ts (splitSentences ~:101, resumeFromFreeze restart at
// sentenceIdx). Kept inline so the test needs no React import.

// (a) SPLITTER — the real transcript checklist that collapsed into ONE utterance (period inside quote).
const IRIS = "In my lane, nothing's done recently. Up next, I've got 'Prepare for gym' and 'Transfer 40k.' Overdue items include 'Cancel Amex Payment' and 'Scan passport.' Blocked tasks remain like 'Update on consulting.'";
const OLD_RE = /(?<=[.!?;])\s+/;
const NEW_RE = /(?<=[.!?;]["'”’)\]]?)\s+/;
const split = (t, re) => t.split(re).map((s) => s.trim()).filter(Boolean);

// (b) RESUME MODEL — speak items 0..n-1; barge while item `bargeAt` is the current (frozen) item;
// resume RESTARTS at the frozen index (repeat) and continues to the end. Returns the spoken sequence.
function runWithBarge(n, bargeAt) {
  const spoken = [];
  let i = 0;
  let barged = false;
  while (i < n) {
    spoken.push(i);
    if (!barged && i === bargeAt) {
      barged = true;
      i = bargeAt; // NEW resume: restart at the interrupted item (repeat), then continue
    } else {
      i += 1;
    }
  }
  return spoken;
}

let passed = 0, failed = 0;
const ok = (c, m) => { c ? passed++ : failed++; console.log(`  ${c ? "✓" : "✗"} ${m}`); };

console.log("P1 splitter + resume-continue");

const oldParts = split(IRIS, OLD_RE);
const newParts = split(IRIS, NEW_RE);
ok(oldParts.length <= 2, `OLD splitter collapses the checklist → ${oldParts.length} part(s) (the bug: period-inside-quote never split)`);
ok(newParts.length >= 4, `NEW splitter breaks it into ${newParts.length} lines (each checklist line its own utterance)`);
ok(newParts.some((p) => /Overdue/.test(p)) && newParts.some((p) => /Blocked/.test(p)), "NEW: 'Overdue…' and 'Blocked…' are now separate utterances (resume can continue them)");

// Resume: 5-line checklist, user barges while line 1 ("Overdue…") plays. Nothing after the barge may drop.
const seq = runWithBarge(5, 1);
const uniqueAfter = new Set(seq);
ok([0, 1, 2, 3, 4].every((k) => uniqueAfter.has(k)), `every line 0..4 is spoken (none dropped) — sequence ${JSON.stringify(seq)}`);
ok(seq.filter((x) => x === 1).length === 2, "the interrupted line (1) is REPEATED once on resume (user's preference)");
ok(seq.indexOf(2) > seq.lastIndexOf(1), "after repeating the cut line, the list CONTINUES (2,3,4 follow)");

// Contrast: the OLD resume-from-next would have skipped the cut line — prove the models differ.
function runOldSkip(n, bargeAt) {
  const spoken = []; let i = 0; let barged = false;
  while (i < n) { spoken.push(i); if (!barged && i === bargeAt) { barged = true; i = bargeAt + 1; } else i += 1; }
  return spoken;
}
const oldSeq = runOldSkip(5, 1);
ok(oldSeq.filter((x) => x === 1).length === 1, `OLD resume-from-next did NOT repeat the cut line ${JSON.stringify(oldSeq)} (distinguishes the change)`);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
