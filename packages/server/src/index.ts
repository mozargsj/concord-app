import { env } from './config/env.js';
import { createSignalingServer } from './websocket/server.js';

const hasTls = Boolean(env.tls.certPath && env.tls.keyPath);
createSignalingServer(env.signalingPort, hasTls ? env.tls : undefined);

const scheme = hasTls ? 'wss' : 'ws';
console.log(`[concord-server] signaling server listening on ${scheme}://localhost:${env.signalingPort}`);
