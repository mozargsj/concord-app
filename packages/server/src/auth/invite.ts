import { SignJWT, jwtVerify } from 'jose';
import { secretKey } from './session.js';

const INVITE_TTL = '7d';

export async function signInviteToken(serverId: string): Promise<string> {
  return new SignJWT({ serverId, typ: 'invite' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(INVITE_TTL)
    .sign(secretKey());
}

export async function verifyInviteToken(token: string): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(token, secretKey());
    if (payload.typ !== 'invite' || typeof payload.serverId !== 'string') return null;
    return payload.serverId;
  } catch {
    return null;
  }
}
