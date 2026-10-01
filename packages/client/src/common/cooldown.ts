// Refusal cooldown for remote-control requests/offers (spec 13.2). Pure logic, no imports, so it
// runs both in the Electron main process and under plain `node cooldown.test.ts`.
//
// The recipient keeps one record per SENDER userId. The block length is a formula, never a fixed
// value: BASE_MS * FACTOR^(n - 1), n = refusals inside the last WINDOW_MS (sliding window). The
// LIMIT-th refusal inside that window turns into a permanent block, lifted only by an explicit
// unblock in the profile.

export interface CooldownConfig {
  baseMs: number;
  factor: number;
  limit: number;
  windowMs: number;
}

export const COOLDOWN: CooldownConfig = { baseMs: 60_000, factor: 2, limit: 5, windowMs: 3_600_000 };

export interface BlockRecord {
  /** Timestamps of this sender's refusals still inside the window. */
  refusals: number[];
  blockedUntil: number;
  permanent: boolean;
}

export type BlockStatus = { blocked: false } | { blocked: true; permanent: true } | { blocked: true; permanent: false; retryInMs: number };

export function blockDurationMs(n: number, cfg: CooldownConfig = COOLDOWN): number {
  return cfg.baseMs * cfg.factor ** (n - 1);
}

export function blockStatus(record: BlockRecord | undefined, now: number): BlockStatus {
  if (!record) return { blocked: false };
  if (record.permanent) return { blocked: true, permanent: true };
  if (record.blockedUntil > now) return { blocked: true, permanent: false, retryInMs: record.blockedUntil - now };
  return { blocked: false };
}

/** Registers one refusal and returns the sender's updated record. */
export function recordRefusal(record: BlockRecord | undefined, now: number, cfg: CooldownConfig = COOLDOWN): BlockRecord {
  const refusals = [...(record?.refusals ?? []).filter((t) => now - t < cfg.windowMs), now];
  if (record?.permanent || refusals.length >= cfg.limit) return { refusals, blockedUntil: 0, permanent: true };
  return { refusals, blockedUntil: now + blockDurationMs(refusals.length, cfg), permanent: false };
}
