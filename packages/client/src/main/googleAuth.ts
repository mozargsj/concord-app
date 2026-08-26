import { randomBytes, createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { shell } from 'electron';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { getOAuthCallbackHtml } from './oauthCallbackPage';

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const JWKS_URI = 'https://www.googleapis.com/oauth2/v3/certs';
// Covers the "closed the browser tab instead of finishing login" case — the loopback server never
// gets a request in that scenario (no HTTP round-trip happens at all), so a timeout is the only
// way this ever resolves. Was 5 minutes, then 2 minutes; tightened further to 15s (Mozar's call —
// a real Google consent flow with an account already signed in resolves in a couple seconds, so
// this should only ever fire on an abandoned/closed attempt).
const CALLBACK_TIMEOUT_MS = 15 * 1000;

const jwks = createRemoteJWKSet(new URL(JWKS_URI));

export interface GoogleIdentity {
  email: string;
  displayName: string;
  avatarImageUrl?: string;
}

function base64url(input: Buffer): string {
  return input.toString('base64url');
}

function waitForCallback(server: Server, expectedState: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      server.close();
      reject(new Error('google-oauth-timeout'));
    }, CALLBACK_TIMEOUT_MS);

    server.on('request', (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      const error = url.searchParams.get('error');

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(getOAuthCallbackHtml());

      clearTimeout(timer);
      server.close();

      if (error) return reject(new Error(`google-oauth-denied: ${error}`));
      if (!code || state !== expectedState) return reject(new Error('google-oauth-state-mismatch'));
      resolve(code);
    });
  });
}

export async function loginWithGoogle(): Promise<GoogleIdentity> {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('GOOGLE_OAUTH_CLIENT_ID/GOOGLE_OAUTH_CLIENT_SECRET não configurados em packages/client/.env');
  }

  const codeVerifier = base64url(randomBytes(32));
  const codeChallenge = base64url(createHash('sha256').update(codeVerifier).digest());
  const state = randomBytes(16).toString('hex');

  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('google-oauth-loopback-failed');
  }
  const redirectUri = `http://127.0.0.1:${address.port}`;

  const authUrl = new URL(AUTH_ENDPOINT);
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', 'openid email profile');
  authUrl.searchParams.set('code_challenge', codeChallenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  authUrl.searchParams.set('state', state);

  const callbackPromise = waitForCallback(server, state);
  await shell.openExternal(authUrl.toString());
  const code = await callbackPromise;

  const tokenResponse = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
      code_verifier: codeVerifier
    })
  });
  if (!tokenResponse.ok) throw new Error('google-oauth-token-exchange-failed');
  const tokenBody = (await tokenResponse.json()) as { id_token?: string };
  if (!tokenBody.id_token) throw new Error('google-oauth-missing-id-token');

  const { payload } = await jwtVerify(tokenBody.id_token, jwks, {
    issuer: ['https://accounts.google.com', 'accounts.google.com'],
    audience: clientId
  });

  if (!payload.email || payload.email_verified !== true) {
    throw new Error('google-oauth-email-not-verified');
  }

  return {
    email: String(payload.email),
    displayName: typeof payload.name === 'string' && payload.name.trim() ? payload.name : String(payload.email),
    avatarImageUrl: typeof payload.picture === 'string' ? payload.picture : undefined
  };
}
