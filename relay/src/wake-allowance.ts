/** Two immediate authenticated requests, then one replenished request per 30 s.
 * Shared by the Node relay and the durable Cloudflare pairing object. */
export type WakeAllowance = { tokens: number; at: number };
export function takeWake(
  now: number,
  previous?: WakeAllowance,
  refillMs = 30000,
  capacity: 1 | 2 = 2,
) {
  const tokens = Math.min(
    capacity,
    (previous?.tokens ?? capacity) +
      Math.max(0, now - (previous?.at ?? now)) / refillMs,
  );
  const retryAfterMs = tokens >= 1 ? 0 : Math.ceil((1 - tokens) * refillMs);
  return {
    retryAfterMs,
    state: {
      tokens: tokens - (retryAfterMs === 0 ? 1 : 0),
      at: Math.max(now, previous?.at ?? now),
    },
  };
}
