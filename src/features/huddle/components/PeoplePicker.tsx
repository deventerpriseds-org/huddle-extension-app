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
    getTrinnexPeopleFn({ data: { caller } })
      .then((r) => {
        if (alive && r.ok) {
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
