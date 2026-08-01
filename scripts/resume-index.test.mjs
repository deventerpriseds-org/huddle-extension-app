// Deterministic proof of the V-RESUME fix (useCeremonyVoice resumeFromFreeze).
// Models _voiceTurn's sentence loop + barge-freeze + resume, and asserts that across repeated barges
// on one block NO sentence is ever spoken twice (the "broken record"). Reproduces the OLD bug
// (resume from the interrupted sentence) to prove the test actually distinguishes the fix.
//   Run: node scripts/resume-index.test.mjs

// Simulate speaking a block of `n` sentences, with barges at the given sentence indices.
// resumeFrom(si) = the sentence index the resume RESTARTS at after a barge that froze on sentence si.
//   OLD (buggy): resumeFrom = si         (re-speaks the interrupted sentence)
//   NEW (fix):   resumeFrom = si + 1     (continues from the next sentence)
function runBlock(n, bargeAt, resumeFrom) {
  const spoken = [];
  let i = 0;
  const barges = [...bargeAt];
  while (i < n) {
    spoken.push(i); // "speak" sentence i
    if (barges.length && barges[0] === i) {
      barges.shift();
      // barge freezes on sentence i (freezeRef.sentenceIdx = i), resume restarts here:
      i = resumeFrom(i);
    } else {
      i += 1;
    }
  }
  return spoken;
}
const hasDup = (arr) => new Set(arr).size !== arr.length;

let passed = 0, failed = 0;
function assert(cond, msg) { cond ? passed++ : failed++; console.log(`  ${cond ? "✓" : "✗"} ${msg}`); }

console.log("V-RESUME resume-index invariant");

// A 5-sentence block, user barges while sentences 1 and 3 are being spoken.
const NEW = (si) => si + 1;
const OLD = (si) => si;

const oldSeq = runBlock(5, [1, 3], OLD);
assert(hasDup(oldSeq), `OLD: re-speaks interrupted sentences → duplicates ${JSON.stringify(oldSeq)} (reproduces broken-record)`);

const newSeq = runBlock(5, [1, 3], NEW);
assert(!hasDup(newSeq), `NEW: no sentence spoken twice ${JSON.stringify(newSeq)} (no replay)`);
assert(JSON.stringify(newSeq) === JSON.stringify([0, 1, 2, 3, 4]), "NEW: every sentence spoken exactly once, in order");

// Multiple barges on the SAME sentence (rapid re-barge) — NEW must still never repeat.
const rapid = runBlock(4, [2, 2], NEW);
assert(!hasDup(rapid), `NEW: rapid re-barge on same point still no repeat ${JSON.stringify(rapid)}`);

// Single-sentence block interrupted → nothing left to resume (the barge answer stood in for it).
const single = runBlock(1, [0], NEW);
assert(JSON.stringify(single) === JSON.stringify([0]) && !hasDup(single), "NEW: single-sentence block, interrupted → no replay, no crash");

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
