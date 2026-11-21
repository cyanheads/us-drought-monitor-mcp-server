/**
 * @fileoverview Process-local FIFO admission for one type of analytical work.
 * @module services/drought/analytical-admission
 */
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';

/** A transient admission refusal, distinct from retained canvas capacity. */
export function stagingBusy(): McpError {
  return new McpError(
    JsonRpcErrorCode.RateLimited,
    'Analytical work is busy; retry after active workflows or queries complete.',
    { reason: 'staging_busy', retryable: true },
  );
}

/** Two active operations and eight FIFO waiters, each with its own admission deadline. */
export class AnalyticalAdmission {
  private active = 0;
  private readonly waiters = new Set<() => boolean>();

  get hasActiveWork(): boolean {
    return this.active > 0;
  }

  /** Run work after reserving a slot, releasing it even on cancellation or failure. */
  async run<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
    signal.throwIfAborted();
    if (this.active < 2) this.active++;
    else await this.wait(signal);
    try {
      signal.throwIfAborted();
      return await work();
    } finally {
      this.release();
    }
  }

  private release(): void {
    // Transfer the existing reservation before any newcomer can take it.
    for (const admit of this.waiters) if (admit()) return;
    this.active--;
  }

  private wait(signal: AbortSignal): Promise<void> {
    if (this.waiters.size >= 8) throw stagingBusy();
    return new Promise((resolve, reject) => {
      const deadline = performance.now() + 15_000;
      const timer = setTimeout(expire, 15_000);
      const unlink = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        this.waiters.delete(admit);
      };
      const abort = () => {
        unlink();
        reject(signal.reason);
      };
      function expire() {
        unlink();
        reject(stagingBusy());
      }
      const admit = () => {
        if (performance.now() >= deadline) {
          expire();
          return false;
        }
        unlink();
        resolve();
        return true;
      };
      this.waiters.add(admit);
      signal.addEventListener('abort', abort, { once: true });
    });
  }
}
