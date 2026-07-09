// Entra External ID (CIAM) auth — MSAL browser.
// Ported from Bridge Builder's b2cAuth.ts with SSR-safe lazy init.
import {
  PublicClientApplication,
  type AccountInfo,
  type AuthenticationResult,
  type Configuration,
} from "@azure/msal-browser";

const tenantName = import.meta.env.VITE_ENTRA_TENANT_NAME as string | undefined;
const clientId = import.meta.env.VITE_ENTRA_CLIENT_ID as string | undefined;

export const loginRequest = {
  scopes: ["openid", "profile", "email"],
  prompt: "select_account",
};

let instance: PublicClientApplication | null = null;
let initPromise: Promise<void> | null = null;

function isBrowser() {
  return typeof window !== "undefined";
}

export function getMsal(): PublicClientApplication | null {
  if (!isBrowser()) return null;
  if (instance) return instance;
  if (!tenantName || !clientId) {
    console.error(
      "[entra-auth] Missing VITE_ENTRA_TENANT_NAME or VITE_ENTRA_CLIENT_ID env vars",
    );
    return null;
  }
  const tenantDomain = `${tenantName}.onmicrosoft.com`;
  const authority = `https://${tenantName}.ciamlogin.com/${tenantDomain}/`;
  const config: Configuration = {
    auth: {
      clientId,
      authority,
      knownAuthorities: [`${tenantName}.ciamlogin.com`],
      redirectUri: window.location.origin,
    },
    cache: {
      cacheLocation: "localStorage",
    },
  };
  instance = new PublicClientApplication(config);
  return instance;
}

/** Initialize MSAL and resolve any pending redirect. Safe to call multiple times. */
export function initMsal(): Promise<void> {
  if (!isBrowser()) return Promise.resolve();
  if (initPromise) return initPromise;
  const msal = getMsal();
  if (!msal) return Promise.resolve();
  initPromise = (async () => {
    await msal.initialize();
    try {
      await msal.handleRedirectPromise();
    } catch (err) {
      console.error("[entra-auth] handleRedirectPromise failed", err);
    }
  })();
  return initPromise;
}

export function getCurrentUser(): AccountInfo | null {
  const msal = getMsal();
  if (!msal) return null;
  const accounts = msal.getAllAccounts();
  return accounts[0] ?? null;
}

export async function signIn(): Promise<void> {
  const msal = getMsal();
  if (!msal) return;
  await msal.loginRedirect(loginRequest);
}

export async function signOut(): Promise<void> {
  const msal = getMsal();
  if (!msal) return;
  await msal.logoutRedirect();
}

export async function getToken(): Promise<string | null> {
  const msal = getMsal();
  if (!msal) return null;
  const accounts = msal.getAllAccounts();
  if (accounts.length === 0) return null;
  try {
    const result: AuthenticationResult = await msal.acquireTokenSilent({
      scopes: loginRequest.scopes,
      account: accounts[0],
      forceRefresh: false,
    });
    return result.idToken;
  } catch (e) {
    console.error("[entra-auth] acquireTokenSilent failed — redirecting to login:", e);
    await msal.loginRedirect(loginRequest);
    return null;
  }
}
