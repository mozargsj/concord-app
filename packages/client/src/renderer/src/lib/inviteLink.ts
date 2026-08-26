// Purely a display/copy formatting layer (decisions.md) — the invite itself is still the same
// signed JWT (auth/invite.ts, server-side), no new route, no change to /servers/join. Prefixing
// it with the official domain just makes what gets copied/pasted look like a real link instead of
// a bare token.
const INVITE_DOMAIN = 'concord.undersoft.tec.br';

export function formatInviteLink(code: string): string {
  return `${INVITE_DOMAIN}/${code}`;
}

/** Accepts either the bare JWT or the domain-prefixed form above (with or without a scheme) —
 * the JWT itself is header.payload.signature, base64url, never contains a '/', so slicing off
 * everything up to the last '/' recovers it regardless of which form was pasted. */
export function extractInviteCode(input: string): string {
  const trimmed = input.trim();
  const lastSlash = trimmed.lastIndexOf('/');
  return lastSlash === -1 ? trimmed : trimmed.slice(lastSlash + 1);
}
