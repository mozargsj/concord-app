import type { Env } from './env';

// Cloudflare Realtime SFU HTTPS API (https://developers.cloudflare.com/realtime/sfu/api/). Only the
// room's Durable Object calls it: the app secret never leaves the Worker, and clients only send
// their SDP through the signaling socket (messages.ts, "SFU mode").
const API_BASE = 'https://rtc.live.cloudflare.com/v1/apps';

export class SfuApiError extends Error {
  readonly code: string;
  constructor(code: string, description?: string) {
    super(description ? `${code}: ${description}` : code);
    this.name = 'SfuApiError';
    this.code = code;
  }
}

interface SessionDescription {
  type: 'offer' | 'answer';
  sdp: string;
}

export interface SfuTrackResult {
  mid?: string;
  trackName?: string;
  sessionId?: string;
  errorCode?: string;
  errorDescription?: string;
}

export interface TracksResponse {
  sessionDescription?: SessionDescription;
  tracks?: SfuTrackResult[];
  requiresImmediateRenegotiation?: boolean;
}

/** Blank secrets mean "SFU unavailable": every room falls back to mesh. */
export function sfuConfigured(env: Env): boolean {
  return Boolean(env.REALTIME_SFU_APP_ID && env.REALTIME_SFU_APP_SECRET);
}

async function call<T>(env: Env, method: 'POST' | 'PUT', path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${API_BASE}/${encodeURIComponent(env.REALTIME_SFU_APP_ID)}${path}`, {
    method,
    headers: { Authorization: `Bearer ${env.REALTIME_SFU_APP_SECRET}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const json = (await response.json().catch(() => ({}))) as T & { errorCode?: string; errorDescription?: string };
  // Request-level failures only; per-track failures come back as HTTP 200 inside tracks[].
  if (!response.ok || json.errorCode) throw new SfuApiError(json.errorCode ?? `http_${response.status}`, json.errorDescription);
  return json;
}

const sessionPath = (sessionId: string) => `/sessions/${encodeURIComponent(sessionId)}`;

export async function createSession(env: Env): Promise<string> {
  const result = await call<{ sessionId?: string }>(env, 'POST', '/sessions/new');
  if (!result.sessionId) throw new SfuApiError('missing_session_id');
  return result.sessionId;
}

/** Publishes local tracks: the client's offer in, the SFU's answer out. */
export function pushTracks(
  env: Env,
  sessionId: string,
  offerSdp: string,
  tracks: { mid: string; trackName: string }[]
): Promise<TracksResponse> {
  return call(env, 'POST', `${sessionPath(sessionId)}/tracks/new`, {
    sessionDescription: { type: 'offer', sdp: offerSdp },
    tracks: tracks.map((t) => ({ location: 'local', mid: t.mid, trackName: t.trackName }))
  });
}

/** Pulls remote tracks: no SDP in, the SFU's offer out (the client answers via renegotiate). */
export function pullTracks(env: Env, sessionId: string, tracks: { sessionId: string; trackName: string }[]): Promise<TracksResponse> {
  return call(env, 'POST', `${sessionPath(sessionId)}/tracks/new`, {
    tracks: tracks.map((t) => ({ location: 'remote', sessionId: t.sessionId, trackName: t.trackName }))
  });
}

export function renegotiate(env: Env, sessionId: string, answerSdp: string): Promise<unknown> {
  return call(env, 'PUT', `${sessionPath(sessionId)}/renegotiate`, {
    sessionDescription: { type: 'answer', sdp: answerSdp }
  });
}

/** With an offer: negotiated close (publisher side, returns an answer). Without: forced close, no
 * SDP round-trip (subscriber side). A track already closed is a per-track error, not a failure. */
export function closeTracks(env: Env, sessionId: string, mids: string[], offerSdp?: string): Promise<TracksResponse> {
  return call(env, 'PUT', `${sessionPath(sessionId)}/tracks/close`, {
    tracks: mids.map((mid) => ({ mid })),
    force: offerSdp === undefined,
    ...(offerSdp !== undefined && { sessionDescription: { type: 'offer', sdp: offerSdp } })
  });
}

export interface SfuPeerView {
  peerId: string;
  sfu?: { pub?: string; tracks?: { name: string }[] };
}

/** Authorization for 'sfu-subscribe': a requested track resolves to its publisher's session only if
 * a live peer of this room (never the requester) announced it. Same order as `requests`; null = refused. */
export function resolvePulls(
  requests: { peerId: string; trackName: string }[],
  peers: SfuPeerView[],
  selfPeerId: string
): ({ peerId: string; trackName: string; sessionId: string } | null)[] {
  const byPeer = new Map(peers.filter((p) => p.peerId !== selfPeerId).map((p) => [p.peerId, p]));
  return requests.map((request) => {
    const owner = byPeer.get(request.peerId);
    const sessionId = owner?.sfu?.pub;
    if (!sessionId || !owner.sfu?.tracks?.some((t) => t.name === request.trackName)) return null;
    return { ...request, sessionId };
  });
}
