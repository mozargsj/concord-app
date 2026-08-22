export type LatencyBand = 'good' | 'ok' | 'bad';

/** Thresholds match decisions.md's ITU-T G.114 reference for one-way voice latency. */
export function getLatencyBand(latencyMs: number): LatencyBand {
  if (latencyMs <= 150) return 'good';
  if (latencyMs <= 200) return 'ok';
  return 'bad';
}
