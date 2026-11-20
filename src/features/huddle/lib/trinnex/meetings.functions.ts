// WHAT:       Client-callable server functions behind the Trinnex Meetings module and the shared people picker.
// WHY:        AC-trinnex-workspace.md section 1. Owner picks still go through the EXISTING triage (actOnProposal).
// SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   docs/qc-evidence/BUILD-trinnex-meetings.md.
//
// Server modules are imported dynamically so pg / server-only deps never reach the client bundle.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const Caller = z.object({ entra_object_id: z.string().optional(), entra_email: z.string().optional() }).optional();
const MeetingId = z.string().regex(/^[A-Za-z0-9_-]{1,120}$/);
const Name = z.string().max(200);
const fail = (tag: string) => (e: unknown) => {
  console.error(`[trinnex-meetings] ${tag} failed`, e instanceof Error ? e.name : "error");
  return { ok: false as const, error: "Something went wrong. Try again." };
};

export const listTrinnexMeetingsFn = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => z.object({ caller: Caller }).parse(raw))
  .handler(async ({ data }) => (await import("./meetings.server")).listMeetings(data.caller).catch(fail("list")));

export const getTrinnexMeetingFn = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => z.object({ caller: Caller, meetingId: MeetingId }).parse(raw))
  .handler(async ({ data }) => (await import("./meetings.server")).getMeeting(data.caller, data.meetingId).catch(fail("open")));

const Pick = z.union([z.object({ kind: z.literal("person"), name: Name }), z.object({ kind: z.literal("skip") })]);

export const saveTrinnexMeetingFn = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) =>
    z
      .object({
        caller: Caller,
        meetingId: MeetingId,
        title: z.string().max(1000),
        series: z.string().max(1000).nullable(),
        participants: z.array(Name).max(50),
        withParticipants: z.boolean(),
        renameFile: z.boolean(),
        speakerMap: z.record(z.string().max(200), Name),
        owners: z.record(z.string().max(40), Pick),
        addToMemory: z.boolean(),
      })
      .parse(raw),
  )
  .handler(async ({ data }) => {
    const { caller, ...input } = data;
    return (await import("./meetings.server")).saveMeeting(caller, input).catch(fail("save"));
  });

export const getTrinnexPeopleFn = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => z.object({ caller: Caller }).parse(raw))
  .handler(async ({ data }) => (await import("./meetings.server")).getPeople(data.caller).catch(fail("people")));

export const addTrinnexPersonFn = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => z.object({ caller: Caller, name: Name }).parse(raw))
  .handler(async ({ data }) => (await import("./meetings.server")).addPerson(data.caller, data.name).catch(fail("add person")));

export const removeTrinnexPersonFn = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => z.object({ caller: Caller, name: Name }).parse(raw))
  .handler(async ({ data }) => (await import("./meetings.server")).removePerson(data.caller, data.name).catch(fail("remove person")));
