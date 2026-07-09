import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { getToken } from "@/lib/entra-auth";
import { useAuth } from "@/hooks/useAuth";
import {
  addProfileEmail,
  getMyProfile,
  removeProfileEmail,
  updateDisplayName,
  updateUsername,
} from "@/features/huddle/lib/identity/profile.functions";

async function requireToken(): Promise<string> {
  const t = await getToken();
  if (!t) throw new Error("Not signed in. Please sign in and try again.");
  return t;
}

const PROFILE_KEY = ["identity", "profile"] as const;

export function useProfile() {
  const { isAuthenticated } = useAuth();
  const qc = useQueryClient();

  const query = useQuery({
    queryKey: PROFILE_KEY,
    enabled: isAuthenticated,
    queryFn: async () => {
      const idToken = await requireToken();
      return getMyProfile({ data: { idToken } });
    },
  });

  const setUsername = useMutation({
    mutationFn: async (username: string) => {
      const idToken = await requireToken();
      return updateUsername({ data: { idToken, username } });
    },
    onSuccess: (bundle) => qc.setQueryData(PROFILE_KEY, bundle),
  });

  const setDisplayName = useMutation({
    mutationFn: async (displayName: string | null) => {
      const idToken = await requireToken();
      return updateDisplayName({ data: { idToken, displayName } });
    },
    onSuccess: (bundle) => qc.setQueryData(PROFILE_KEY, bundle),
  });

  const addEmail = useMutation({
    mutationFn: async (email: string) => {
      const idToken = await requireToken();
      return addProfileEmail({ data: { idToken, email } });
    },
    onSuccess: (bundle) => qc.setQueryData(PROFILE_KEY, bundle),
  });

  const removeEmail = useMutation({
    mutationFn: async (emailId: string) => {
      const idToken = await requireToken();
      return removeProfileEmail({ data: { idToken, emailId } });
    },
    onSuccess: (bundle) => qc.setQueryData(PROFILE_KEY, bundle),
  });

  const refetch = useCallback(() => query.refetch(), [query]);

  return { query, setUsername, setDisplayName, addEmail, removeEmail, refetch };
}
