import { readFileSync } from 'node:fs';
import { createServer as createHttpServer, type RequestListener } from 'node:http';
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
  // ws only hooks the 'upgrade' event — plain HTTP requests (health checks, sanity curls)
  // would otherwise hang forever with no response, since Node sends nothing by default.
  const requestHandler: RequestListener = (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
  };

  const server = tls
    ? createHttpsServer({ cert: readFileSync(tls.certPath), key: readFileSync(tls.keyPath) }, requestHandler)
    : createHttpServer(requestHandler);

  const wss = new WebSocketServer({ server });
  wss.on('connection', handleConnection);
  server.listen(port);
  return wss;
}
