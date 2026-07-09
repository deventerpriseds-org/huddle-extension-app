// Entra External ID (CIAM) auth — MSAL browser.
// Ported from Bridge Builder's b2cAuth.ts with SSR-safe lazy init.
import {
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

let instance: PublicClientApplication | null = null;
let initPromise: Promise<void> | null = null;

function isBrowser() {
  return typeof window !== "undefined";
}

export function getMsal(): PublicClientApplication | null {
  if (!isBrowser()) return null;
  if (instance) return instance;
  if (!tenantName || !tenantId || !clientId) {
    console.error(
      "[entra-auth] Missing VITE_ENTRA_TENANT_NAME / VITE_ENTRA_TENANT_ID / VITE_ENTRA_CLIENT_ID env vars",
    );
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
      const result = await msal.handleRedirectPromise();
      if (result?.account) {
        msal.setActiveAccount(result.account);
        return;
      }

      const activeAccount = msal.getActiveAccount();
      if (!activeAccount) {
        const accounts = msal.getAllAccounts();
        if (accounts[0]) msal.setActiveAccount(accounts[0]);
      }
    } catch (err) {
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
  // In an iframe (Lovable preview), MSAL blocks loginRedirect. Fall back to popup.
  const inIframe = window.self !== window.top;
  if (inIframe) {
    const result = await msal.loginPopup(loginRequest);
    if (result.account) msal.setActiveAccount(result.account);
    return;
  }
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
  const account = getCurrentUser();
  if (!account) return null;
  try {
    const result: AuthenticationResult = await msal.acquireTokenSilent({
      scopes: loginRequest.scopes,
      account,
      forceRefresh: false,
    });
    return result.idToken;
  } catch (e) {
    console.error("[entra-auth] acquireTokenSilent failed — redirecting to login:", e);
    await msal.loginRedirect(loginRequest);
    return null;
  }
}
