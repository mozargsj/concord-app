import type { DbEnv } from './db/context';
import * as logs from './db/logs';

export interface ErrorLogContext {
  source: 'http' | 'ws' | 'do' | 'client';
  serverId?: string;
  roomId?: string;
  userId?: string;
  route?: string;
  peerId?: string;
  kind?: string;
}

/**
 * Single choke point for error capture, same role as packages/server/src/logging/errorLog.ts
 * (decisions.md §7) — a serverId in context routes to server_logs, otherwise system_logs. Never
 * lets a logging failure mask or crash the original error path.
 */
export async function logError(env: DbEnv, error: unknown, context: ErrorLogContext): Promise<void> {
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

  console.error(
    `[concord-signaling] ${context.source} error${context.kind ? ` kind=${context.kind}` : ''}${context.peerId ? ` peer=${context.peerId}` : ''}`,
    error
  );

  try {
    if (context.serverId) {
      await logs.createServerLog(env, context.serverId, { errorType, message, stack, context: fullContext });
    } else {
      await logs.createSystemLog(env, { errorType, message, stack, context: fullContext });
    }
  } catch (loggingError) {
    console.error('[concord-signaling] failed to write error log', loggingError);
  }
}
