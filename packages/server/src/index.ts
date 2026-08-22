import { env } from './config/env.js';
import { createSignalingServer } from './websocket/server.js';

createSignalingServer(env.signalingPort);

console.log(`[concord-server] signaling server listening on ws://localhost:${env.signalingPort}`);
