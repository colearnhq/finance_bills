import "server-only";

export const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
export const STATE_COOKIE = "gmail_oauth_state";

export const redirectUri = (origin: string) => `${origin}/api/gmail/callback`;

export function authUrl(origin: string, state: string) {
  const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  u.search = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID!,
    redirect_uri: redirectUri(origin),
    response_type: "code",
    scope: GMAIL_SCOPE,
    access_type: "offline", // needed to receive a refresh token
    prompt: "consent",
    state,
  }).toString();
  return u.toString();
}

async function tokenRequest(params: Record<string, string>) {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      ...params,
    }),
    cache: "no-store",
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(`OAuth: ${j.error ?? res.status}`), { oauthError: j.error as string | undefined });
  return j as { access_token: string; refresh_token?: string; scope?: string; expires_in: number };
}

export const exchangeCode = (code: string, origin: string) =>
  tokenRequest({ grant_type: "authorization_code", code, redirect_uri: redirectUri(origin) });

export const refreshAccessToken = (refreshToken: string) =>
  tokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken });
