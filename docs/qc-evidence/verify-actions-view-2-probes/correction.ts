// Probe: one proposal backing two threads (same to-do title -> upsert attaches). Wrong? on thread B overwrites the
// single owner_correction, so thread A (already corrected) is no longer hidden.
const W = new URL("../../../src/features/huddle/lib", import.meta.url).pathname;
const { makeCorrection, correctionHides } = await import(`${W}/actions/actions.ts`);
const A = "teams:chatA|msgA1", B = "teams:chatB|msgB1";
const c1 = makeCorrection({ reason: "not_mine", itemKey: A }, null, "2026-11-16T10:00:00Z");
console.log("after Wrong? on A: hides A =", correctionHides(c1.correction, A), " hides B =", correctionHides(c1.correction, B));
const c2 = makeCorrection({ reason: "not_mine", itemKey: B }, c1.correction, "2026-11-16T10:05:00Z");
console.log("after Wrong? on B: hides A =", correctionHides(c2.correction, A), " hides B =", correctionHides(c2.correction, B));
const undo = { ...c2.correction, withdrawnAt: "2026-11-16T10:06:00Z" };
console.log("Undo (on B): hides A =", correctionHides(undo, A), " hides B =", correctionHides(undo, B));
console.log("newer message on A (new key): hides =", correctionHides(c1.correction, "teams:chatA|msgA2"));
