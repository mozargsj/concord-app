import { readFileSync } from 'node:fs';
import { createServer as createHttpServer, type RequestListener } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { WebSocketServer } from 'ws';
import { handleConnection } from './connectionHandler.js';
import { handleHttpRequest } from '../http/router.js';

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
  // ws only hooks the 'upgrade' event — plain HTTP requests (health checks, sanity curls,
  // and now the account/server REST API) would otherwise hang forever with no response,
  // since Node sends nothing by default.
  const requestHandler: RequestListener = (req, res) => {
    void handleHttpRequest(req, res);
  };

  const server = tls
    ? createHttpsServer({ cert: readFileSync(tls.certPath), key: readFileSync(tls.keyPath) }, requestHandler)
    : createHttpServer(requestHandler);

  // No maxPayload set otherwise falls back to ws's own default (100MiB) — far above anything a
  // real signaling message needs (SDP offers/answers are a few KB, ICE candidates a few hundred
  // bytes). 128KiB leaves generous headroom for an unusually large multi-track SDP while capping
  // how much a hostile/misbehaving client can force this process to buffer per message.
  const wss = new WebSocketServer({ server, maxPayload: 128 * 1024 });
  wss.on('connection', handleConnection);
  server.listen(port);
  return wss;
}
