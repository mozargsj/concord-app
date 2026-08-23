import { SignJWT, jwtVerify } from 'jose';
import { env, hasSessionSecret } from '../config/env.js';

const SESSION_TTL = '90d';

/** Shared HMAC key — also used to sign/verify invite tokens (auth/invite.ts), distinguished by the `typ` claim. */
export function secretKey(): Uint8Array {
  if (!hasSessionSecret()) {
    throw new Error('Session token requested but SESSION_SECRET is not configured. Set SESSION_SECRET in packages/server/.env.');
  }
  return new TextEncoder().encode(env.sessionSecret);
}

export async function signSessionToken(userId: string): Promise<string> {
  return new SignJWT({ sub: userId })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(SESSION_TTL)
    .sign(secretKey());
}

export async function verifySessionToken(token: string): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(token, secretKey());
    return typeof payload.sub === 'string' ? payload.sub : null;
  } catch {
    return null;
  }
}
