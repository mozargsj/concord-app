import { createRemoteJWKSet, jwtVerify } from 'jose';

const JWKS_URI = 'https://www.googleapis.com/oauth2/v3/certs';
// Module-level — jose caches the fetched keys internally, so this is created once per Worker
// isolate and reused across requests instead of re-fetching Google's JWKS every login.
const jwks = createRemoteJWKSet(new URL(JWKS_URI));

/**
 * [Achado de segurança, 2026-08-29] `POST /users` used to trust whatever `email` the client sent
 * verbatim — main/googleAuth.ts (Electron) already verified the id_token's signature/issuer/
 * audience/email_verified, but only *locally*, and only ever sent the extracted email/displayName
 * on to the server, never the token itself. Anyone calling the REST API directly (bypassing the
 * Electron client entirely) could mint a session for any email with zero Google involvement. This
 * mirrors the exact same verification main/googleAuth.ts already does client-side, just for real
 * this time — the client-side check was never a security boundary, only ever a UX nicety.
 */
export async function verifyGoogleIdToken(idToken: string, clientId: string): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(idToken, jwks, {
      issuer: ['https://accounts.google.com', 'accounts.google.com'],
      audience: clientId
    });
    if (!payload.email || payload.email_verified !== true) return null;
    return String(payload.email);
  } catch {
    return null;
  }
}
