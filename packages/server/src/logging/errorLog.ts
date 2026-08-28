import * as systemLogsRepo from '../db/systemLogsRepo.js';
import * as serverLogsRepo from '../db/serverLogsRepo.js';

export interface ErrorLogContext {
  source: 'http' | 'ws' | 'process' | 'client';
  serverId?: string;
  roomId?: string;
  userId?: string;
  route?: string;
  // [Diagnóstico, adicionado 2026-08-27] Client-side WebRTC diagnostics (webrtcMesh.ts
  // onConnectionError) always carry these two — before this they were silently dropped by
  // handleClientErrorReport (router.ts) despite the client sending them, so the console/DynamoDB
  // log lost exactly the fields needed to tell which peer and which kind of event a given line
  // was about, forcing a re-read of the raw message text every time.
  peerId?: string;
  kind?: string;
}

/**
 * Single choke point for the "todo try/catch grava log" decision (decisions.md §7) — every
 * caller funnels through here instead of each wiring its own DynamoDB write. A serverId in
 * context routes to server_logs (failure tied to one server); otherwise system_logs (general
 * infra failure), matching the split already documented for those two tables.
 *
 * Never lets a logging failure mask or crash the original error path — falls back to console.
 */
export async function logError(error: unknown, context: ErrorLogContext): Promise<void> {
  const errorType = error instanceof Error ? error.name : 'UnknownError';
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? (error.stack ?? null) : null;
  const fullContext = {
    source: context.source,
    route: context.route,
    roomId: context.roomId,
    userId: context.userId,
    peerId: context.peerId,
    kind: context.kind
  };

  // peerId/kind inline no texto (não só no objeto `error`) — é o que dá pra grepar/filtrar direto
  // no tail do console sem precisar consultar o DynamoDB pra descobrir de qual peer/tipo de evento
  // cada linha é.
  console.error(
    `[concord-server] ${context.source} error${context.kind ? ` kind=${context.kind}` : ''}${context.peerId ? ` peer=${context.peerId}` : ''}`,
    error
  );

  try {
    if (context.serverId) {
      await serverLogsRepo.create({ serverId: context.serverId, errorType, message, stack, context: fullContext });
    } else {
      await systemLogsRepo.create({ errorType, message, stack, context: fullContext });
    }
  } catch (loggingError) {
    console.error('[concord-server] failed to write error log', loggingError);
  }
}
