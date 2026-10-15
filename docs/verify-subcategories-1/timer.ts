// Fast-path call with a 60s ceiling and NO journey env configured: if the ceiling timer were not
// cleared, this process would stay alive ~60s after printing.
const W = await import(`${process.argv[2]}/src/features/huddle/lib/tasks/widgets.server.ts`);
const t0 = Date.now();
const r = await W.fetchTopicPayload({ entra_email: "x" }, 60_000);
console.log(JSON.stringify(r), `resolved in ${Date.now() - t0}ms`);
