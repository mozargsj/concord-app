import { SignJWT, jwtVerify } from 'jose';

const SESSION_TTL = '90d';
const INVITE_TTL = '7d';

/**
 * Same HS256 scheme as packages/server/src/auth/session.ts — kept in sync so a token issued by
 * either backend (Node/EC2 or this Worker) verifies against the other, in case both are ever
 * live at once during a migration window. SESSION_SECRET must be the identical value in both
 * places. [Updated 2026-08-29] This Worker now issues tokens too (REST login moved here, see
 * rest.ts) — originally verify-only, back when REST still lived on the Node server.
 */
export async function signSessionToken(userId: string, sessionSecret: string): Promise<string> {
  return new SignJWT({ sub: userId })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(SESSION_TTL)
    .sign(new TextEncoder().encode(sessionSecret));
}

export async function verifySessionToken(token: string, sessionSecret: string): Promise<string | null> {
  if (!sessionSecret) return null;
  try {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(sessionSecret));
    return typeof payload.sub === 'string' ? payload.sub : null;
  } catch {
    return null;
  }
}

/** Mirrors packages/server/src/auth/invite.ts — same secret, distinguished by the `typ` claim. */
export async function signInviteToken(serverId: string, sessionSecret: string): Promise<string> {
  return new SignJWT({ serverId, typ: 'invite' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(INVITE_TTL)
    .sign(new TextEncoder().encode(sessionSecret));
}

export async function verifyInviteToken(token: string, sessionSecret: string): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(sessionSecret));
    if (payload.typ !== 'invite' || typeof payload.serverId !== 'string') return null;
    return payload.serverId;
  } catch {
    return null;
  }
}
