export const env = {
  signalingPort: Number(process.env.SIGNALING_PORT ?? 8080),
  tls: {
    certPath: process.env.TLS_CERT_PATH ?? '',
    keyPath: process.env.TLS_KEY_PATH ?? ''
  },
  aws: {
    region: process.env.AWS_REGION ?? '',
    dynamodbEndpoint: process.env.DYNAMODB_ENDPOINT ?? ''
  },
  dynamodbTablePrefix: process.env.DYNAMODB_TABLE_PREFIX ?? 'concord_',
  s3ServerIconsBucket: process.env.S3_SERVER_ICONS_BUCKET ?? '',
  sessionSecret: process.env.SESSION_SECRET ?? '',
  // Dev/test-only escape hatch for join-room's session/membership check (roomManager.ts) — lets
  // the client's TEST_MODE (api.ts, fake login/server/room, no real backend account) exercise the
  // real signaling/WebRTC mesh without a real session token. Must never be set to 'true' on the
  // production signaling server — only on a local/test-real instance's own .env.
  allowUnauthenticatedRooms: process.env.ALLOW_UNAUTHENTICATED_ROOMS === 'true',
  // Cloudflare Realtime TURN key (2026-08-27 connectivity investigation) — lets the server mint
  // short-lived TURN credentials for the client (router.ts GET /webrtc/turn-credentials) instead
  // of shipping the permanent TURN_API_TOKEN itself anywhere near the client bundle. Both empty by
  // default: the endpoint just reports "not configured" and the client falls back to STUN-only.
  turnKeyId: process.env.TURN_KEY_ID ?? '',
  turnApiToken: process.env.TURN_API_TOKEN ?? ''
};

export function hasAwsRegion(): boolean {
  return Boolean(env.aws.region);
}

export function hasSessionSecret(): boolean {
  return Boolean(env.sessionSecret);
}
