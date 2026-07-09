// Entra External ID (CIAM) auth — MSAL browser.
// Ported from Bridge Builder's b2cAuth.ts with SSR-safe lazy init.
import {
  LogLevel,
  PublicClientApplication,
  type AccountInfo,
  type AuthenticationResult,
  type Configuration,
} from "@azure/msal-browser";

const tenantName = import.meta.env.VITE_ENTRA_TENANT_NAME as string | undefined;
const tenantId = import.meta.env.VITE_ENTRA_TENANT_ID as string | undefined;
const clientId = import.meta.env.VITE_ENTRA_CLIENT_ID as string | undefined;

export const loginRequest = {
  scopes: ["openid", "profile", "email"],
  prompt: "select_account",
};

export type AuthTraceEntry = {
  t: string;
  event: string;
  path?: string;
  details?: Record<string, unknown>;
};

const AUTH_TRACE_KEY = "huddle-auth-trace-v1";
const AUTH_TRACE_LIMIT = 150;

let instance: PublicClientApplication | null = null;
let initPromise: Promise<void> | null = null;

function isBrowser() {
  return typeof window !== "undefined";
}

function sanitizeMsalMessage(message: string) {
  return message
    .replace(/([?&](?:code|client_info|id_token|access_token|refresh_token|state|session_state)=)[^&\s]+/gi, "$1[redacted]")
    .replace(/#(?:code|client_info|id_token|access_token|refresh_token|state|session_state)=[^\s]+/gi, "#[redacted]")
    .slice(0, 700);
}

export function getAuthTrace(): AuthTraceEntry[] {
  if (!isBrowser()) return [];
  try {
    const raw = window.localStorage.getItem(AUTH_TRACE_KEY);
    return raw ? (JSON.parse(raw) as AuthTraceEntry[]) : [];
  } catch {
    return [];
  }
}

export function clearAuthTrace() {
  if (!isBrowser()) return;
  window.localStorage.removeItem(AUTH_TRACE_KEY);
  (window as typeof window & { __huddleAuthTrace?: AuthTraceEntry[] }).__huddleAuthTrace = [];
}

export function traceAuth(event: string, details?: Record<string, unknown>) {
  if (!isBrowser()) return;
  const entry: AuthTraceEntry = {
    t: new Date().toISOString(),
    event,
    path: window.location.pathname,
    details,
  };
  try {
    const next = [...getAuthTrace(), entry].slice(-AUTH_TRACE_LIMIT);
    window.localStorage.setItem(AUTH_TRACE_KEY, JSON.stringify(next));
    (window as typeof window & { __huddleAuthTrace?: AuthTraceEntry[] }).__huddleAuthTrace = next;
  } catch {
    // localStorage can be unavailable in strict/private browser modes.
  }
  console.info("[huddle-auth]", entry);
}

export function getMsal(): PublicClientApplication | null {
  if (!isBrowser()) return null;
  if (instance) return instance;
  if (!tenantName || !tenantId || !clientId) {
    console.error(
      "[entra-auth] Missing VITE_ENTRA_TENANT_NAME / VITE_ENTRA_TENANT_ID / VITE_ENTRA_CLIENT_ID env vars",
    );
    traceAuth("msal:missing-env", {
      hasTenantName: Boolean(tenantName),
      hasTenantId: Boolean(tenantId),
      hasClientId: Boolean(clientId),
    });
    return null;
  }
  // Use the tenant-GUID authority so MSAL's issuer validation matches the
  // discovery document (which returns `<tenantId>.ciamlogin.com` as the issuer,
  // not the tenant-name host).
  const authority = `https://${tenantId}.ciamlogin.com/${tenantId}/v2.0`;
  const config: Configuration = {
    auth: {
      clientId,
      authority,
      knownAuthorities: [
        `${tenantId}.ciamlogin.com`,
        `${tenantName}.ciamlogin.com`,
      ],
      redirectUri: window.location.origin,
    },
    cache: {
      cacheLocation: "localStorage",
    },
    system: {
      loggerOptions: {
        logLevel: LogLevel.Info,
        piiLoggingEnabled: false,
        loggerCallback: (level, message, containsPii) => {
          if (containsPii) return;
          traceAuth("msal:logger", {
            level,
            message: sanitizeMsalMessage(message),
          });
        },
      },
    },
  };
  instance = new PublicClientApplication(config);
  traceAuth("msal:create", {
    authorityHost: `${tenantId}.ciamlogin.com`,
    redirectOrigin: window.location.origin,
  });
  return instance;
}

/** Initialize MSAL and resolve any pending redirect. Safe to call multiple times. */
export function initMsal(): Promise<void> {
  if (!isBrowser()) return Promise.resolve();
  if (initPromise) {
    traceAuth("msal:init:reuse");
    return initPromise;
  }
  const msal = getMsal();
  if (!msal) return Promise.resolve();
  initPromise = (async () => {
    traceAuth("msal:init:start");
    await msal.initialize();
    traceAuth("msal:init:initialized");
    try {
      traceAuth("msal:redirect:start");
      const result = await msal.handleRedirectPromise();
      traceAuth("msal:redirect:result", {
        hasResult: Boolean(result),
        hasAccount: Boolean(result?.account),
        accountCount: msal.getAllAccounts().length,
      });
      if (result?.account) {
        msal.setActiveAccount(result.account);
        traceAuth("msal:active-account:set-from-redirect", {
          accountCount: msal.getAllAccounts().length,
        });
        return;
      }

      const activeAccount = msal.getActiveAccount();
      if (!activeAccount) {
        const accounts = msal.getAllAccounts();
        if (accounts[0]) {
          msal.setActiveAccount(accounts[0]);
          traceAuth("msal:active-account:recovered-from-cache", {
            accountCount: accounts.length,
          });
        } else {
          traceAuth("msal:active-account:none", { accountCount: 0 });
        }
      } else {
        traceAuth("msal:active-account:already-set", {
          accountCount: msal.getAllAccounts().length,
        });
      }
    } catch (err) {
      traceAuth("msal:redirect:error", {
        name: err instanceof Error ? err.name : "unknown",
        message: err instanceof Error ? err.message : String(err),
      });
      console.error("[entra-auth] handleRedirectPromise failed", err);
    }
  })();
  return initPromise;
}

export function getCurrentUser(): AccountInfo | null {
  const msal = getMsal();
  if (!msal) return null;
  const activeAccount = msal.getActiveAccount();
  if (activeAccount) return activeAccount;
  const accounts = msal.getAllAccounts();
  if (accounts[0]) msal.setActiveAccount(accounts[0]);
  return accounts[0] ?? null;
}

export async function signIn(): Promise<void> {
  const msal = getMsal();
  if (!msal) return;
  await initMsal();
  traceAuth("signin:start", {
    inIframe: window.self !== window.top,
    accountCount: msal.getAllAccounts().length,
  });
  // In an iframe (Lovable preview), MSAL blocks loginRedirect. Fall back to popup.
  const inIframe = window.self !== window.top;
  if (inIframe) {
    const result = await msal.loginPopup(loginRequest);
    if (result.account) msal.setActiveAccount(result.account);
    traceAuth("signin:popup:complete", {
      hasAccount: Boolean(result.account),
      accountCount: msal.getAllAccounts().length,
    });
    return;
  }
  traceAuth("signin:redirect:start");
  await msal.loginRedirect(loginRequest);
}

export async function signOut(): Promise<void> {
  const msal = getMsal();
  if (!msal) return;
  traceAuth("signout:start", { accountCount: msal.getAllAccounts().length });
  await msal.logoutRedirect();
}

export async function getToken(): Promise<string | null> {
  const msal = getMsal();
  if (!msal) return null;
  const account = getCurrentUser();
  if (!account) return null;
  try {
    traceAuth("token:silent:start");
    const result: AuthenticationResult = await msal.acquireTokenSilent({
      scopes: loginRequest.scopes,
      account,
      forceRefresh: false,
    });
    traceAuth("token:silent:success");
    return result.idToken;
  } catch (e) {
    traceAuth("token:silent:error", {
      name: e instanceof Error ? e.name : "unknown",
      message: e instanceof Error ? e.message : String(e),
    });
    console.error("[entra-auth] acquireTokenSilent failed — redirecting to login:", e);
    await msal.loginRedirect(loginRequest);
    return null;
  }
}
