// WHAT:       The zod schema for one Polish request (polish / revise / span / merge), shared by the
//             in-app server function and the cross-app route /api/public/polish so both accept the
//             exact same shapes.
// WHY:        Option A of the Polish ecosystem (docs/polish/CONTRACT-polish-ecosystem.md): Huddle hosts
//             the one engine; two doors onto it must not drift apart in what they accept.
// SUPERSEDES: the inline `Req` schema that lived in polish.functions.ts (moved, not changed).
// SUPERSEDED-BY: nothing -- current
// EVIDENCE:   scripts/polish-core.test.ts
import { z } from "zod";

export const MAX = 40_000;
export const POLISH_MAX = MAX;

export const PolishRequestSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("polish"), draft: z.string().min(1).max(MAX) }),
  z.object({
    mode: z.literal("revise"),
    text: z.string().min(1).max(MAX),
    instruction: z.string().min(1).max(500),
  }),
  z.object({
    mode: z.literal("span"),
    text: z.string().min(1).max(MAX),
    start: z.number().int().min(0),
    end: z.number().int().min(0),
    instruction: z.string().min(1).max(500),
  }),
  z.object({
    mode: z.literal("merge"),
    draft: z.string().min(1).max(MAX),
    edited: z.string().min(1).max(MAX),
  }),
]);

/** Body of POST /api/public/polish (docs/polish/CONTRACT-polish-ecosystem.md §1). No identity field:
 *  the acting subject is server-held (cross-app/turn-gate.ts resolveActingSubject). */
export const PolishPublicBodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("profiles") }),
  z.object({
    action: z.literal("polish"),
    profileId: z.string().min(1).max(80).optional(),
    settings: z.unknown().optional(),
    request: PolishRequestSchema,
  }),
]);
export type PolishPublicBody = z.infer<typeof PolishPublicBodySchema>;
