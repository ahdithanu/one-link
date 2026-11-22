// A circuit breaker for an upstream dependency. Closed: calls go through, and failures inside a
// rolling window are counted. Open: calls fail fast for `openMs`, so a down dependency isn't
// hammered and callers can serve cached data instead. Half-open: one trial call decides whether
// to close again or reopen.

export type BreakerState = "closed" | "open" | "half-open";

export class BreakerOpenError extends Error {
  constructor(public retryInMs: number) {
    super("circuit open");
  }
}

export type BreakerOptions = {
  failureThreshold?: number;
  windowMs?: number;
  openMs?: number;
  now?: () => number;
  onTransition?: (from: BreakerState, to: BreakerState) => void;
};

export function createBreaker(o: BreakerOptions = {}) {
  const threshold = o.failureThreshold ?? 5;
  const windowMs = o.windowMs ?? 60_000;
  const openMs = o.openMs ?? 30_000;
  const now = o.now ?? Date.now;
  let state: BreakerState = "closed";
  let failures: number[] = [];
  let openedAt = 0;
  let trial = false;
  const totals = { calls: 0, successes: 0, failures: 0, rejected: 0, opens: 0 };

  const move = (to: BreakerState) => {
    if (to === state) return;
    const from = state;
    state = to;
    if (to === "open") {
      openedAt = now();
      totals.opens++;
    }
    if (to === "closed") failures = [];
    o.onTransition?.(from, to);
  };

  return {
    async run<T>(fn: () => Promise<T>): Promise<T> {
      if (state === "open") {
        const waited = now() - openedAt;
        if (waited < openMs) {
          totals.rejected++;
          throw new BreakerOpenError(openMs - waited);
        }
        move("half-open");
      }
      if (state === "half-open") {
        if (trial) {
          totals.rejected++;
          throw new BreakerOpenError(0);
        }
        trial = true;
      }
      totals.calls++;
      try {
        const result = await fn();
        totals.successes++;
        if (state === "half-open") move("closed");
        return result;
      } catch (err) {
        totals.failures++;
        if (state === "half-open") move("open");
        else {
          const t = now();
          failures = [...failures.filter((f) => t - f < windowMs), t];
          if (failures.length >= threshold) move("open");
        }
        throw err;
      } finally {
        trial = false;
      }
    },
    // For tests.
    reset() {
      state = "closed";
      failures = [];
      trial = false;
    },
    snapshot() {
      const t = now();
      return { state, failuresInWindow: failures.filter((f) => t - f < windowMs).length, openedAt: state === "closed" ? null : new Date(openedAt).toISOString(), ...totals };
    },
  };
}
