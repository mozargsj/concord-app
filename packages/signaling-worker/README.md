# @concord/signaling-worker

Cloudflare Worker serving Concord's **entire backend** — WebSocket signaling (Durable Object) and
the REST API (D1 + R2) — from one origin, no AWS involved. Written from scratch against
`packages/server` (Node/`ws`/DynamoDB/S3), not ported: see `src/room.ts`'s class doc comment for
why signaling can't share code with a plain Node process (Hibernation API breaks in-memory
`Map`/`setTimeout` state), and `decisions.md` §0.2/§0.3 for the full reasoning behind the pivot
from "revive the EC2 instance" to "migrate everything to Cloudflare."

## Scope

- **Signaling** (`src/room.ts`, one `RoomDurableObject` per room): join-room auth/membership,
  SDP/ICE relay, host migration cascade (DO Alarms, not `setTimeout` — survives hibernation).
- **REST** (`src/rest.ts`): every route `packages/server/src/http/router.ts` has — login/session,
  servers, rooms, roles, invites, soundboard registry, reports, client-error logging,
  `/webrtc/turn-credentials`, avatar/icon upload (presigned R2 URLs), update-artifact hosting.
- **Storage**: D1 (`src/db/*.ts`, one file per table group) instead of DynamoDB, R2 (`src/r2.ts`
  for presigned URLs, native `env.MEDIA` binding for server-side reads/writes) instead of S3.
- **One origin for both**: `index.ts`'s `fetch()` routes a `Upgrade: websocket` request to the
  right Durable Object, everything else to the REST router — same shape as `packages/server`
  today (one process, two concerns), which the client's URL config already assumes
  (`VITE_SIGNALING_URL` doubles as the REST base via a scheme swap, `packages/client/.../lib/api.ts`).

## Status (2026-08-29): this IS production now

`https://signaling.undersoft.tec.br` — the real domain the shipped app talks to — routes here
(via `concord-updates-proxy`, updated to proxy to `https://concord-signaling.mozargsj.workers.dev`
instead of Mozar's desktop tunnel). `SESSION_SECRET` is set. Verified end-to-end against the real
domain: login, `GET /users/me`, create server, create room, list servers/rooms, create invite, and
a real WebSocket `join-room` → `room-joined` → `ping`/`pong` cycle with an authenticated token
(plus a rejected-invalid-token check) — all against real D1 data, cleaned up after. Then
re-verified with Mozar's local DynamoDB Local, local signaling server, and `cloudflared` tunnel
all killed, to confirm the desktop is genuinely no longer required — see decisions.md §0.4 for the
full sequence.

R2 is enabled, the `concord-media` bucket exists, and `R2_ACCESS_KEY_ID`/`R2_SECRET_ACCESS_KEY`
are set — the full upload/download cycle was tested end-to-end against real infrastructure:
presign → `PUT` the file → `PATCH /users/me` with the key → `GET /users/me` returns a working
presigned read URL → `GET` on it returns the exact bytes uploaded. Avatar/server-icon upload is
fully functional.

**No known blockers left.** Everything — REST, signaling, R2 upload/download — is live in
production, independent of any AWS resource or Mozar's desktop.

**Not yet done, not blocking anything**: host migration with multiple real peers in a room (only a
solo join + ping/pong has been exercised so far — the Alarms-based cascade itself is untested
against a live multi-peer scenario). CI (`.github/workflows/release.yml`) still uploads update
artifacts to the old EC2-via-SSM path, not R2 — needs updating so new releases actually reach
`/updates/*` here, but doesn't affect anything already working.

## Local dev

```
npm run dev:signaling-worker
```

`wrangler dev` emulates D1, Durable Objects (hibernation + alarms included), and R2 locally. Copy
`.dev.vars.example` to `.dev.vars` (gitignored) and fill in `SESSION_SECRET` (same value as
`packages/server/.env`) — R2 secrets and `TURN_KEY_ID`/`TURN_API_TOKEN` are optional, those
features just no-op without them, same as in production.

To exercise the signaling protocol without a real session token, set
`ALLOW_UNAUTHENTICATED_ROOMS=true` in `wrangler.jsonc`'s `vars` (dev-only — same escape hatch and
warning as `packages/server/.env.example`, never `true` in production).

## Deploying

```
npm run deploy --workspace=@concord/signaling-worker
```

Requires `wrangler login` once, and the secrets above set via `wrangler secret put <NAME>` (never
in `wrangler.jsonc`, which is committed).

## Not implemented (future work, tracked in decisions.md "Pontos ainda em aberto")

- `host-heartbeat` watchdog (mirrors the Node server's current state — recorded, not acted on).
- Rate limiting beyond the existing per-field size caps (`src/protocol.ts`).
- CI publishing update artifacts to R2 instead of the EC2 instance's disk via SSM — the `/updates/*`
  route here is ready to serve from R2, but `.github/workflows/release.yml` still uploads
  elsewhere; needs updating once R2 is enabled.
