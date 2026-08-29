import type { ApiErrorResponse } from '@concord/shared';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization'
};

/**
 * [Achado de segurança, 2026-08-29] Auditoria externa apontou `/users`, `/webrtc/turn-credentials`
 * e `/logs/client-error` (mais os upgrades de WebSocket) sem nenhum limite de taxa — brute force
 * de idToken, abuso de credencial TURN e spam de log anônimo, tudo sem custo pro atacante. Chave
 * por IP de propósito aqui (diferente da recomendação padrão do binding de preferir userId — esses
 * quatro pontos são alcançáveis *antes* ou *sem* nunca ter uma sessão válida, então IP é a única
 * característica disponível; o objetivo aqui é conter DDoS/abuso em massa, não rastrear um usuário
 * específico).
 */
export function getClientIp(req: Request): string {
  return req.headers.get('CF-Connecting-IP') ?? 'unknown';
}

export async function checkRateLimit(limiter: RateLimit, key: string): Promise<boolean> {
  const { success } = await limiter.limit({ key });
  return success;
}

export function rateLimitResponse(): Response {
  return new Response(JSON.stringify({ error: 'rate-limited' } satisfies ApiErrorResponse), {
    status: 429,
    headers: { 'Content-Type': 'application/json', 'Retry-After': '60', ...CORS_HEADERS }
  });
}
