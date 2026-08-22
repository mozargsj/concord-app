import { readFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { WebSocketServer } from 'ws';
import { handleConnection } from './connectionHandler.js';

export interface TlsOptions {
  certPath: string;
  keyPath: string;
}

/**
 * With tls set, terminates TLS directly on this process (wss) using the given cert/key —
 * used behind Cloudflare's "Full" SSL mode, which only requires the origin to present
 * some certificate, not one issued by a trusted CA. Without it, falls back to plain ws.
 */
export function createSignalingServer(port: number, tls?: TlsOptions): WebSocketServer {
  const server = tls
    ? createHttpsServer({ cert: readFileSync(tls.certPath), key: readFileSync(tls.keyPath) })
    : createHttpServer();

  const wss = new WebSocketServer({ server });
  wss.on('connection', handleConnection);
  server.listen(port);
  return wss;
}
