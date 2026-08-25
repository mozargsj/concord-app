import * as systemLogsRepo from '../db/systemLogsRepo.js';
import * as serverLogsRepo from '../db/serverLogsRepo.js';

export interface ErrorLogContext {
  source: 'http' | 'ws' | 'process' | 'client';
  serverId?: string;
  roomId?: string;
  userId?: string;
  route?: string;
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
  const fullContext = { source: context.source, route: context.route, roomId: context.roomId, userId: context.userId };

  console.error(`[concord-server] ${context.source} error`, error);

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
