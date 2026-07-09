import { useEffect, useState } from "react";
import type { AccountInfo } from "@azure/msal-browser";
import { getCurrentUser, getMsal, signIn, signOut } from "@/lib/entra-auth";

export function useAuth() {
  const [user, setUser] = useState<AccountInfo | null>(() => getCurrentUser());

  useEffect(() => {
    const msal = getMsal();
    if (!msal) return;
    // Re-sync in case initMsal populated accounts after this hook mounted.
    setUser(getCurrentUser());
    const callbackId = msal.addEventCallback(() => {
      setUser(getCurrentUser());
    });
    return () => {
      if (callbackId) msal.removeEventCallback(callbackId);
    };
  }, []);

  return {
    user,
    isAuthenticated: user !== null,
    signIn,
    signOut,
  };
}
