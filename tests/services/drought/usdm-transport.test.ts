/**
 * @fileoverview Deterministic Node dispatcher isolation and Bun native-fetch selection.
 * @module tests/services/drought/usdm-transport
 */

import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createUsdmTransport } from '@/services/drought/usdm-transport.js';

afterEach(() => vi.unstubAllGlobals());
describe('owned USDM transport', () => {
  it('preserves native fetch on Bun', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('[]'));
    vi.stubGlobal('fetch', fetcher);
    const transport = createUsdmTransport('bun');
    const signal = new AbortController().signal;
    await transport.fetch('https://usdmdataservices.unl.edu/', { signal });
    await transport.fetch('https://usdmdataservices.unl.edu/', { signal });
    const init = fetcher.mock.calls[0]?.[1];
    expect(init).toBeDefined();
    if (!init) throw new Error('Expected fetch init');
    expect(init.signal).toBe(signal);
    expect(init).not.toHaveProperty('dispatcher');
    await transport.close();
  });
  it('uses one private HTTP/1.1 Agent on real Node and destroys it on shutdown', () => {
    const node = (process.env.PATH ?? '')
      .split(delimiter)
      .map((directory) => join(directory, 'node'))
      .find(
        (candidate) =>
          existsSync(candidate) && /[\\/]node(?:\.exe)?$/.test(realpathSync(candidate)),
      );
    if (!node) throw new Error('A real Node binary is required for the transport regression');
    const source = new URL('../../../src/services/drought/usdm-transport.ts', import.meta.url).href;
    const script = `
      import { getGlobalDispatcher } from 'undici';
      import { createUsdmTransport } from ${JSON.stringify(source)};
      if (process.versions.bun) throw new Error('Expected real Node');
      const original = getGlobalDispatcher();
      const calls = [];
      globalThis.fetch = async (input, init) => { calls.push(init); return new Response('[]'); };
      const transport = createUsdmTransport('node');
      const signal = new AbortController().signal;
      await transport.fetch('https://usdmdataservices.unl.edu/', { signal });
      await transport.fetch('https://usdmdataservices.unl.edu/', { signal });
      const dispatcher = calls[0].dispatcher;
      const options = Object.getOwnPropertySymbols(dispatcher).find(key => key.description === 'options');
      if (!options || dispatcher[options].allowH2 !== false || calls[1].dispatcher !== dispatcher || calls[0].signal !== signal || getGlobalDispatcher() !== original) throw new Error('Transport policy mismatch');
      await transport.close();
      if (!dispatcher.destroyed) throw new Error('Dispatcher leaked');
      console.log('node dispatcher verified');
    `;
    expect(
      execFileSync(node, ['--input-type=module', '-e', script], { encoding: 'utf8' }).trim(),
    ).toBe('node dispatcher verified');
  });
});
