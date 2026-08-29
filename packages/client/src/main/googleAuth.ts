import { randomBytes, createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { shell } from 'electron';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { getOAuthCallbackHtml } from './oauthCallbackPage';

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
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
  /** Raw id_token JWT — verified locally right below (signature/issuer/audience/email_verified),
   * but also handed to the server so it can verify independently instead of trusting whatever
   * `email` the renderer sends (decisions.md, achado de segurança 2026-08-29 — a client can call
   * the REST API directly, bypassing this whole file, so server-side trust in a bare client-sent
   * email was a full authentication bypass). */
  idToken: string;
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

/** Mesma derivação REST-base-a-partir-da-URL-de-sinalização que lib/api.ts usa no renderer
 * (troca wss:/ws: por https:/http:) — process.env aqui porque isto roda no main process, não no
 * renderer, então não passa pelo import.meta.env do Vite (dotenv carrega o `.env` inteiro pros
 * dois lados igual, só o prefixo VITE_ é convenção de exposição no bundle do renderer). */
function restBaseUrl(): string {
  const signalingUrl = process.env.VITE_SIGNALING_URL;
  if (!signalingUrl) throw new Error('VITE_SIGNALING_URL não configurado em packages/client/.env');
  return signalingUrl.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');
}

export async function loginWithGoogle(): Promise<GoogleIdentity> {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  if (!clientId) {
    throw new Error('GOOGLE_OAUTH_CLIENT_ID não configurado em packages/client/.env');
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

  // [2026-08-29, item ALTO da auditoria] Troca de code por tokens não fala mais direto com o
  // Google — client_secret saiu do .env do instalador e virou secret do Worker (rest.ts's
  // handleGoogleExchange). PKCE (code_verifier) continua sendo a prova real dessa troca; o Worker
  // só repassa pro Google com o client_secret que só ele tem.
  const exchangeResponse = await fetch(`${restBaseUrl()}/auth/google/exchange`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, codeVerifier, redirectUri })
  });
  if (!exchangeResponse.ok) throw new Error('google-oauth-token-exchange-failed');
  const exchangeBody = (await exchangeResponse.json()) as { idToken?: string };
  if (!exchangeBody.idToken) throw new Error('google-oauth-missing-id-token');

  const { payload } = await jwtVerify(exchangeBody.idToken, jwks, {
    issuer: ['https://accounts.google.com', 'accounts.google.com'],
    audience: clientId
  });

  if (!payload.email || payload.email_verified !== true) {
    throw new Error('google-oauth-email-not-verified');
  }

  return {
    email: String(payload.email),
    displayName: typeof payload.name === 'string' && payload.name.trim() ? payload.name : String(payload.email),
    avatarImageUrl: typeof payload.picture === 'string' ? payload.picture : undefined,
    idToken: exchangeBody.idToken
  };
}
