import { ApiError } from './errors.ts';

/**
 * Failed-attempt limiter by client IP (logins and first-run setup tokens), in
 * addition to the per-user lockout of /login. After `max` failures within
 * `windowMs` the address gets 429 until the oldest failure leaves the window.
 * One instance per app (createApp), kept in memory.
 */
export class FailureLimiter {
  private failures = new Map<string, number[]>();
  private max: number;
  private windowMs: number;
  constructor(opts: { max: number; windowMs: number }) {
    this.max = opts.max;
    this.windowMs = opts.windowMs;
  }

  private recent(ip: string, now: number) {
    const list = (this.failures.get(ip) ?? []).filter((t) => now - t < this.windowMs);
    if (list.length) this.failures.set(ip, list);
    else this.failures.delete(ip);
    return list;
  }

  /** Throws 429 while the address is over the limit. */
  check(ip: string, now = Date.now()) {
    const list = this.recent(ip, now);
    if (list.length >= this.max) {
      const minutes = Math.max(1, Math.ceil((list[0]! + this.windowMs - now) / 60_000));
      throw new ApiError(429, `Твърде много неуспешни опити от този адрес. Опитайте отново след ${minutes} мин.`, undefined, 'ipLimit');
    }
  }

  fail(ip: string, now = Date.now()) {
    const list = this.recent(ip, now);
    list.push(now);
    this.failures.set(ip, list);
    // Keep memory bounded under a spray from many addresses: drop expired entries, then the oldest.
    if (this.failures.size > 10_000) {
      for (const k of [...this.failures.keys()]) this.recent(k, now);
      for (const k of this.failures.keys()) {
        if (this.failures.size <= 10_000) break;
        this.failures.delete(k);
      }
    }
  }
}
