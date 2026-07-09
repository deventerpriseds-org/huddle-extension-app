import { useEffect, useState, type ReactNode } from "react";
import { initMsal } from "@/lib/entra-auth";

/**
 * Client-only MSAL bootstrap.
 *
 * Renders a placeholder during SSR and until MSAL has finished
 * `initialize()` + `handleRedirectPromise()`. After that, children mount
 * with a fully resolved auth state so route guards can read
 * `getCurrentUser()` synchronously.
 */
export function MsalBootstrap({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    initMsal().finally(() => {
      if (!cancelled) setReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!ready) {
    return (
      <div className="flex h-dvh w-full items-center justify-center bg-background text-sm text-muted-foreground">
        Signing you in…
      </div>
    );
  }

  return <>{children}</>;
}
