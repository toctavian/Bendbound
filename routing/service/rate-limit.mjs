// Single-process pilot limits. The global cap also bounds the client map size.
export function createRateLimiter({ perClient = 30, global = 120, windowMs = 60000, now = Date.now } = {}) {
  let windowEnd = now() + windowMs;
  let total = 0;
  const clients = new Map();
  return client => {
    const time = now();
    if (time >= windowEnd) {
      clients.clear(); total = 0; windowEnd = time + windowMs;
    }
    const count = clients.get(client) || 0;
    if (count >= perClient || total >= global) {
      return { allowed: false, retryAfter: Math.max(1, Math.ceil((windowEnd - time) / 1000)) };
    }
    clients.set(client, count + 1); total++;
    return { allowed: true };
  };
}
