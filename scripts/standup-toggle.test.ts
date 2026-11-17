// WHAT:       Proves the "Automatic stand-up" toggle: the scheduler skips a switched-off job and fires a
//             switched-on one, the setting round-trips through the real scheduling-config store code
//             (fake pg pool), a Settings save keeps the flag, and the manual start is untouched.
// WHY:        Owner 2026-11-16: "toggle off the automatic stand-ups from the meetings menu where I can
//             always toggle or kick one off manually, my hope is this will cut down in the usage of cost
//             resources".
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   docs/qc-evidence/BUILD-barge-cap-standup-toggle.md. Run: bun test scripts/standup-toggle.test.ts
// Failing tests also print `FAIL <name>` (bun prints "(fail)"), so scripts/mutate.sh can attribute them.
import { test, expect, mock, beforeEach } from "bun:test";
import { readFileSync } from "node:fs";

const ROOT = `${import.meta.dir}/..`;
const SRC = `${ROOT}/src/features/huddle/lib`;
const P = (rel: string) => require.resolve(`${SRC}/${rel}`);

const t = (name: string, fn: () => Promise<void> | void) =>
  test(name, async () => {
    try {
      await fn();
    } catch (e) {
      console.log(`FAIL ${name}`);
      throw e;
    }
  });

// ---- fake Postgres: just the two statements scheduling-config.server.ts issues ----
const rows = new Map<string, Record<string, unknown>>(); // email -> overrides
const reverseKeys = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(reverseKeys)
    : v && typeof v === "object"
      ? Object.fromEntries(Object.keys(v).reverse().map((k) => [k, reverseKeys((v as Record<string, unknown>)[k])]))
      : v;
mock.module(P("db/shared-pool.server.ts"), () => ({
  SHARED_POOL_MAX: 8,
  getSharedPool: () => ({
    query: async (sql: string, params: unknown[] = []) => {
      if (/CREATE SCHEMA/.test(sql)) return { rows: [], rowCount: 0 };
      if (/^\s*SELECT overrides FROM identity\.scheduling_config/.test(sql)) {
        const email = String(params[0]).toLowerCase();
        const o = rows.get(email);
        // JSONB hands objects back with its own key order: reverse to make sure nothing depends on it.
        return o ? { rows: [{ overrides: reverseKeys(o) }], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      if (/^\s*INSERT INTO identity\.scheduling_config/.test(sql)) {
        rows.set(String(params[0]).toLowerCase(), JSON.parse(String(params[1])));
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`unexpected SQL in test: ${sql.slice(0, 60)}`);
    },
  }),
}));
mock.module(P("identity/identity.server.ts"), () => ({
  resolveScopeByEmail: async (email: string) => ({ userId: null, emails: [email.toLowerCase()] }),
}));

// ---- the scheduler's job store + side passes ----
type Job = { id: string; job_type: string; target_email: string; cadence: unknown };
let due: Job[] = [];
const nextRuns: string[] = [];
mock.module(P("tasks/tasks.server.ts"), () => ({
  claimDueScheduledJobs: async () => due,
  getUsersWithOpenBacklog: async () => [],
  retireDuplicateScheduledJobs: async () => {},
  setScheduledJobNextRun: async (id: string) => {
    nextRuns.push(id);
  },
  upsertScheduledJob: async () => {},
}));
mock.module(P("tasks/autowork.server.ts"), () => ({ fireDueConfirmAsks: async () => {} }));
mock.module(P("fireflies/fireflies.server.ts"), () => ({ processDueFirefliesMeetings: async () => 0 }));
mock.module(P("correspondence/ingest.server.ts"), () => ({ runCorrespondenceIngest: async () => null }));
mock.module(P("proposals/proposals.server.ts"), () => ({ runProposalsPass: async () => undefined }));

process.env.AZURE_PG_URL = "postgres://fake";
process.env.JOURNEY_PROXY_TOKEN = "test-token";
process.env.HUDDLE_APP_URL = "http://test.invalid";
const posts: { path: string; email: string }[] = [];
globalThis.fetch = (async (url: string, init?: { body?: string }) => {
  const body = JSON.parse(init?.body ?? "{}");
  posts.push({ path: new URL(url).pathname, email: body?.caller?.entra_email });
  return new Response("{}");
}) as unknown as typeof fetch;

const cfg = await import(P("identity/scheduling-config.server.ts"));
const { runDueScheduledJobs } = await import(P("tasks/scheduler.server.ts"));

const A = "test-standup-off@example.invalid";
const B = "test-standup-on@example.invalid";
const standupJob = (email: string): Job => ({ id: `standup-${email}`, job_type: "standup-digest", target_email: email, cadence: null });
const groomJob = (email: string): Job => ({ id: `groom-${email}`, job_type: "groom", target_email: email, cadence: null });

async function tick(jobs: Job[]) {
  due = jobs;
  posts.length = 0;
  nextRuns.length = 0;
  const fired = await runDueScheduledJobs();
  await new Promise((r) => setTimeout(r, 0));
  return fired as number;
}

beforeEach(() => {
  rows.clear();
});

t("T1 isJobEnabled: only an explicit false turns a job off", () => {
  expect(cfg.isJobEnabled(undefined)).toBe(true);
  expect(cfg.isJobEnabled({ tz: "UTC", hours: [8] })).toBe(true);
  expect(cfg.isJobEnabled({ tz: "UTC", hours: [8], enabled: true })).toBe(true);
  expect(cfg.isJobEnabled({ tz: "UTC", hours: [8], enabled: false })).toBe(false);
});

t("T2 default (no row): the scheduled stand-up FIRES", async () => {
  const fired = await tick([standupJob(B)]);
  expect(fired).toBe(1);
  expect(posts).toEqual([{ path: "/api/public/run-standup", email: B }]);
});

t("T3 switched off: the scheduled stand-up is SKIPPED, but its next run still advances", async () => {
  await cfg.setJobEnabled(A, "standup", false);
  const fired = await tick([standupJob(A)]);
  expect(posts.filter((p) => p.path === "/api/public/run-standup")).toEqual([]);
  expect(fired).toBe(0);
  expect(nextRuns).toEqual([`standup-${A}`]);
});

t("T4 one user off does not stop another user's stand-up, nor the off user's other jobs", async () => {
  await cfg.setJobEnabled(A, "standup", false);
  await tick([standupJob(A), standupJob(B), groomJob(A)]);
  expect(posts).toEqual([
    { path: "/api/public/run-standup", email: B },
    { path: "/api/public/run-grooming", email: A },
  ]);
});

t("T5 switched back on: fires again, and the stored row returns to exactly what it was (no override)", async () => {
  await cfg.setJobEnabled(A, "standup", false);
  expect((await cfg.getSchedulingConfig(A)).overrides.standup).toEqual({ ...cfg.SCHEDULING_DEFAULTS.standup, enabled: false });
  await cfg.setJobEnabled(A, "standup", true);
  expect((await cfg.getSchedulingConfig(A)).overrides).toEqual({});
  await tick([standupJob(A)]);
  expect(posts).toEqual([{ path: "/api/public/run-standup", email: A }]);
});

t("T6 round-trip keeps the user's own hours and other jobs' overrides", async () => {
  await cfg.setSchedulingConfig(A, { standup: { tz: "America/New_York", hours: [7] }, groom: { tz: "UTC", hours: [9] } });
  await cfg.setJobEnabled(A, "standup", false);
  let o = (await cfg.getSchedulingConfig(A)).overrides;
  expect(o.standup).toEqual({ tz: "America/New_York", hours: [7], enabled: false });
  expect(o.groom).toEqual({ tz: "UTC", hours: [9] });
  expect((await cfg.resolveJobCadence(A, "standup")).enabled).toBe(false);
  await cfg.setJobEnabled(A, "standup", true);
  o = (await cfg.getSchedulingConfig(A)).overrides;
  expect(o.standup).toEqual({ tz: "America/New_York", hours: [7] });
  expect(o.groom).toEqual({ tz: "UTC", hours: [9] });
});

t("T7 a Settings → Scheduling save keeps enabled:false (the validator must not strip it)", async () => {
  const { OverridesInput } = await import(P("identity/scheduling-config.functions.ts"));
  const parsed = OverridesInput.parse({ standup: { tz: "America/New_York", hours: [8], enabled: false } });
  expect(parsed.standup).toEqual({ tz: "America/New_York", hours: [8], enabled: false });
});

t("T8 manual start is unaffected: the Meetings item and the run-standup route never read the toggle", () => {
  const view = readFileSync(`${ROOT}/src/features/huddle/components/HuddleView.tsx`, "utf8");
  expect(view).toMatch(/<DropdownMenuItem onClick=\{\(\) => startVirtualMeeting\("standup"\)\}>\s*Daily stand-up/);
  const route = readFileSync(`${ROOT}/src/routes/api/public/run-standup.ts`, "utf8");
  expect(route).not.toMatch(/isJobEnabled|enabled === false/);
  const standup = readFileSync(`${SRC}/tasks/standup.server.ts`, "utf8");
  expect(standup).not.toMatch(/isJobEnabled/);
});

t("T9 the Meetings menu toggle writes through setMyJobEnabledFn for job 'standup'", () => {
  const view = readFileSync(`${ROOT}/src/features/huddle/components/HuddleView.tsx`, "utf8");
  expect(view).toMatch(/setMyJobEnabledFn\(\{ data: \{ caller: meetingCaller, job: "standup", enabled: next \} \}\)/);
  expect(view).toMatch(/data-testid="auto-standup-toggle"/);
});

t("T10 label shows the effective schedule", async () => {
  const { autoStandupLabel } = await import(P("identity/auto-job-label.ts"));
  expect(autoStandupLabel({ tz: "America/New_York", hours: [8] })).toBe("Automatic stand-up (daily 8:00)");
  expect(autoStandupLabel({ tz: "UTC", hours: [13, 7], daysOfWeek: [4, 1] })).toBe("Automatic stand-up (Mon, Thu 7:00, 13:00)");
  expect(autoStandupLabel(undefined)).toBe("Automatic stand-up");
  const { cadenceLine } = await import(P("identity/auto-job-label.ts"));
  expect(cadenceLine({ tz: "America/New_York", hours: [8] })).toBe("Daily at 8:00");
  expect(cadenceLine({ tz: "UTC", hours: [13, 7], daysOfWeek: [4, 1] })).toBe("Mon, Thu at 7:00, 13:00");
});
