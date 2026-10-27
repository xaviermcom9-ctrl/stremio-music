// Ported from Resonance (~/resonance/server/src/protocol/limiter.ts).
/**
 * Per-addon outbound limits: a token bucket (`ratePerSecond` with `burst`) and a cap on
 * concurrent requests. Requests wait their turn rather than fail; a request that would
 * wait longer than `maxWaitMs` fails fast instead, so a hammered addon can't stall pages.
 */
export class RateLimiter {
  private tokens: number;
  private last: number;
  private active = 0;
  private waiting: (() => void)[] = [];

  constructor(
    private opts: { ratePerSecond: number; burst: number; maxConcurrent: number; maxWaitMs: number },
    private now: () => number = Date.now,
  ) {
    this.tokens = opts.burst;
    this.last = now();
  }

  /** Waits for a slot; resolves with a release function. */
  async acquire(): Promise<() => void> {
    const started = this.now();
    // Concurrency slot first.
    if (this.active >= this.opts.maxConcurrent) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.waiting = this.waiting.filter((w) => w !== go);
          reject(new RateLimitError(`more than ${this.opts.maxConcurrent} requests in flight`));
        }, this.opts.maxWaitMs);
        const go = () => {
          clearTimeout(timer);
          resolve();
        };
        this.waiting.push(go);
      });
    } else this.active++;
    // Then a token.
    for (;;) {
      this.refill();
      if (this.tokens >= 1) {
        this.tokens--;
        break;
      }
      const wait = Math.ceil(((1 - this.tokens) / this.opts.ratePerSecond) * 1000);
      if (this.now() - started + wait > this.opts.maxWaitMs) {
        this.release();
        throw new RateLimitError(`over ${this.opts.ratePerSecond} requests/s`);
      }
      await new Promise((r) => setTimeout(r, wait));
    }
    let released = false;
    return () => {
      if (!released) {
        released = true;
        this.release();
      }
    };
  }

  private refill() {
    const t = this.now();
    this.tokens = Math.min(this.opts.burst, this.tokens + ((t - this.last) / 1000) * this.opts.ratePerSecond);
    this.last = t;
  }

  private release() {
    const next = this.waiting.shift();
    if (next) next(); // hand the slot over
    else this.active--;
  }
}

export class RateLimitError extends Error {}
