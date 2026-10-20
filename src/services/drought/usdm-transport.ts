/**
 * @fileoverview Server-owned HTTP/1.1 dispatcher on Node; native fetch on Bun.
 * @module services/drought/usdm-transport
 */
import { Agent } from 'undici';

/** Lazy reusable dispatcher with explicit shutdown, isolated from global fetch policy. */
export function createUsdmTransport(
  runtime: 'bun' | 'node' = process.versions.bun ? 'bun' : 'node',
) {
  let dispatcher: Agent | undefined;
  const fetcher: typeof fetch = (input, init) => {
    if (runtime === 'bun') return fetch(input, init);
    dispatcher ??= new Agent({ allowH2: false });
    return fetch(input, { ...init, dispatcher } as RequestInit & { dispatcher: Agent });
  };
  return {
    fetch: fetcher,
    async close(): Promise<void> {
      if (dispatcher) await dispatcher.destroy();
    },
  };
}
/** Process-shared transport; teardown releases its Node sockets after intake stops. */
export const usdmTransport = createUsdmTransport();
