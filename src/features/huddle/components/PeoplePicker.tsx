// WHAT:       THE people picker (owner, participant, speaker): the owner pinned first as "<name> (me)", then the
//             owner's people list, then "Add new name". One component, one server-side list, used by Meetings triage,
//             the chat triage checklist and Actions > Meetings (AC-T12..T14).
// WHY:        Owner-approved prototype (docs/trinnex/prototype/meetings.html): pick owners without retyping a name.
// SUPERSEDES: the typed "For someone" name box as the FIRST step (it remains as the "Add new name" step).
// SUPERSEDED-BY: nothing -- current.
// EVIDENCE:   docs/qc-evidence/BUILD-trinnex-meetings.md.
import { useCallback, useEffect, useMemo, useState } from "react";
import { UserPlus } from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import { DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { addTrinnexPersonFn, getTrinnexPeopleFn } from "../lib/trinnex/meetings.functions";
import { triageForPick, OWNER_FALLBACK_LABEL } from "../lib/trinnex/meeting-triage-core";

type Caller = { entra_object_id?: string; entra_email?: string };
type PeopleResult = Awaited<ReturnType<typeof getTrinnexPeopleFn>>;
// One fetch of the owner's people list per caller, shared by every picker on the page (a checklist with many
// rows mounts one picker per row). Invalidated whenever a name is added.
let peopleCache: { key: string; promise: Promise<PeopleResult | null> } | null = null;
function loadPeople(caller: Caller): Promise<PeopleResult | null> {
  const key = caller.entra_email ?? "";
  if (!peopleCache || peopleCache.key !== key) {
    peopleCache = { key, promise: getTrinnexPeopleFn({ data: { caller } }).catch(() => null) };
  }
  return peopleCache.promise;
}

/** Persist a typed name to the ONE people list (AC-T14) from any surface; resolves to the stored spelling. */
export async function rememberPersonName(caller: Caller | undefined, name: string): Promise<string | null> {
  if (!caller || !name.trim()) return null;
  const r = await addTrinnexPersonFn({ data: { caller, name } }).catch(() => null);
  peopleCache = null;
  return r && r.ok ? r.name : null;
}

export function useCaller() {
  const { user } = useAuth();
  return useMemo(() => (user ? { entra_object_id: user.localAccountId ?? user.homeAccountId, entra_email: user.username } : undefined), [user]);
}

/** The owner's people list (owner first). `add` persists a new name server-side and returns the stored spelling. */
export function usePeople() {
  const caller = useCaller();
  const [owner, setOwner] = useState<string | null>(null);
  const [people, setPeople] = useState<string[]>([]);
  useEffect(() => {
    if (!caller) return;
    let alive = true;
    loadPeople(caller)
      .then((r) => {
        if (alive && r && r.ok) {
          setOwner(r.owner);
          setPeople(r.people);
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [caller]);
  const add = useCallback(
    async (name: string): Promise<string | null> => {
      if (!caller) return null;
      const r = await addTrinnexPersonFn({ data: { caller, name } }).catch(() => null);
      peopleCache = null;
      if (!r || !r.ok) return null;
      setPeople(r.people);
      return r.name;
    },
    [caller],
  );
  return { owner, people, setPeople, add, caller };
}

/** Dropdown items: "<owner> (me)" first, then everyone else, then "Add new name". Render inside a DropdownMenuContent. */
export function PeopleMenuItems({
  owner,
  people,
  onPick,
  onAddNew,
  testId,
}: {
  owner: string | null;
  people: string[];
  onPick: (name: string) => void;
  onAddNew: () => void;
  testId?: string;
}) {
  const others = people.filter((p) => p !== owner);
  return (
    <>
      {owner && (
        <DropdownMenuItem onSelect={() => onPick(owner)} data-testid={testId ? `${testId}-owner` : undefined}>
          {owner} (me)
        </DropdownMenuItem>
      )}
      {others.map((p) => (
        <DropdownMenuItem key={p} onSelect={() => onPick(p)}>
          {p}
        </DropdownMenuItem>
      ))}
      <DropdownMenuSeparator />
      <DropdownMenuItem onSelect={onAddNew}>
        <UserPlus size={12} className="mr-2" /> Add new name
      </DropdownMenuItem>
    </>
  );
}

/**
 * AC-T13: the owner picker on an existing triage row (chat checklist + Actions > Meetings). "<owner> (me)" first,
 * then the people list, then "Add new name" (the surface's existing typed box). `triageForPick` keeps the stored
 * assignee shape exactly as before (decision Q4).
 */
export function OwnerTriageMenuItems({
  onTriage,
  onAddNew,
  testId,
}: {
  onTriage: (t: { choice: "mine" | "someone" | "skip"; name?: string }) => void;
  onAddNew: () => void;
  testId?: string;
}) {
  const { owner, people } = usePeople();
  return (
    <PeopleMenuItems
      owner={owner ?? OWNER_FALLBACK_LABEL}
      people={people}
      onPick={(n) => onTriage(triageForPick(n, owner))}
      onAddNew={onAddNew}
      testId={testId}
    />
  );
}
