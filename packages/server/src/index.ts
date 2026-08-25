import { env } from './config/env.js';
import { createSignalingServer } from './websocket/server.js';
import { logError } from './logging/errorLog.js';

// Final safety net — anything that slips past the http/ws-level try/catches still gets logged
// before the process goes down (uncaughtException) or is otherwise noted (unhandledRejection).
process.on('uncaughtException', (error) => {
  void logError(error, { source: 'process' }).finally(() => process.exit(1));
});
process.on('unhandledRejection', (reason) => {
  void logError(reason, { source: 'process' });
});

const hasTls = Boolean(env.tls.certPath && env.tls.keyPath);
createSignalingServer(env.signalingPort, hasTls ? env.tls : undefined);

const scheme = hasTls ? 'wss' : 'ws';
console.log(`[concord-server] signaling server listening on ${scheme}://localhost:${env.signalingPort}`);
