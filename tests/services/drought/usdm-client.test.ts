/**
 * @fileoverview Fixed-origin HTTP transport and canonical observation regressions.
 * @module tests/services/drought/usdm-client
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type MetricQuery, RequestBudget, UsdmClient } from '@/services/drought/usdm-client.js';

const query: MetricQuery = {
  areaType: 'county',
  aoi: '01001',
  areas: [{ areaType: 'county', id: '01001', name: 'Autauga County', state: 'AL' }],
  startDate: '2024-02-27',
  endDate: '2024-03-05',
  metric: 'area_percent',
  statisticsType: 'cumulative',
};
const row = {
  fips: '01001',
  county: 'Autauga County',
  state: 'AL',
  mapDate: '2024-02-27T00:00:00',
  none: 20,
  d0: 80,
  d1: 50,
  d2: 10,
  d3: null,
  d4: 0,
};
const budget = () => new RequestBudget(new AbortController().signal);
const json = (value: unknown) =>
  new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
afterEach(() => vi.useRealTimers());

describe('USDM HTTP boundary', () => {
  it('sends only documented endpoint/query/header fields and normalizes nullable buckets', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json([row]));
    const rows = await new UsdmClient(fetcher).metric(query, budget());
    const [url, init] = fetcher.mock.calls[0] ?? [];
    const actual = new URL(String(url));
    expect(actual.origin).toBe('https://usdmdataservices.unl.edu');
    expect(actual.pathname).toBe('/api/CountyStatistics/GetDroughtSeverityStatisticsByAreaPercent');
    expect(Object.fromEntries(actual.searchParams)).toEqual({
      aoi: '01001',
      startdate: '2/27/2024',
      enddate: '3/5/2024',
      statisticsType: '1',
    });
    expect(init).toMatchObject({
      headers: { Accept: 'application/json' },
      redirect: 'error',
      signal: expect.any(AbortSignal),
    });
    expect(rows).toEqual([
      {
        ...query.areas[0],
        mapDate: '2024-02-27',
        validStart: '2024-02-27',
        validEnd: '2024-03-04',
        metric: 'area_percent',
        statisticsType: 'cumulative',
        unit: 'percent',
        buckets: { none: 20, d0_d4: 80, d1_d4: 50, d2_d4: 10, d3_d4: null, d4: 0 },
      },
    ]);
  });
  it.each([
    ['area_sq_miles', 'GetDroughtSeverityStatisticsByArea', 'square miles'],
    ['population_percent', 'GetDroughtSeverityStatisticsByPopulationPercent', 'percent'],
    ['population_count', 'GetDroughtSeverityStatisticsByPopulation', 'people'],
  ] as const)('selects %s and exclusive category names', async (metric, endpoint, unit) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json([row]));
    const rows = await new UsdmClient(fetcher).metric(
      { ...query, metric, statisticsType: 'categorical' },
      budget(),
    );
    expect(String(fetcher.mock.calls[0]?.[0])).toContain(`/CountyStatistics/${endpoint}?`);
    expect(String(fetcher.mock.calls[0]?.[0])).toContain('statisticsType=2');
    expect(rows[0]).toMatchObject({ unit, buckets: { d0_only: 80, d3_only: null, d4_only: 0 } });
  });
  it('preserves unavailable DSCI without deriving it from measurements', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json([{ fips: '01001', mapDate: row.mapDate }]))
      .mockResolvedValueOnce(json([{ ...row, dsci: 137 }]));
    const client = new UsdmClient(fetcher);
    expect((await client.dsci(query, budget()))[0]?.dsci).toBeNull();
    expect((await client.dsci(query, budget()))[0]?.dsci).toBe(137);
    expect(String(fetcher.mock.calls[0]?.[0])).toContain('/CountyStatistics/GetDSCI?');
    expect(String(fetcher.mock.calls[0]?.[0])).not.toContain('statisticsType');
  });
  it.each([
    { rows: [{ ...row, fips: '99999' }] },
    { rows: [row, row] },
    { rows: [{ ...row, mapDate: '2024-02-28' }] },
    { rows: [{ ...row, mapDate: '2024-03-12' }] },
    { rows: [{ ...row, d0: 101 }] },
    { rows: [{ ...row, d1: -1 }] },
  ])('rejects incompatible scope, duplicate, date or bucket rows %#', async ({ rows }) => {
    const client = new UsdmClient(vi.fn<typeof fetch>().mockResolvedValue(json(rows)));
    await expect(client.metric(query, budget())).rejects.toMatchObject({
      data: { reason: 'upstream_shape_invalid' },
    });
  });
  it('rejects malformed and non-array successful bodies without retry', async () => {
    for (const body of ['{', '{}']) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(body));
      await expect(new UsdmClient(fetcher).dsci(query, budget())).rejects.toMatchObject({
        data: { reason: 'upstream_shape_invalid' },
      });
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });
  it.each(['consecutive', 'non_consecutive'] as const)(
    'normalizes authoritative %s county duration rows',
    async (mode) => {
      const duration =
        mode === 'consecutive'
          ? {
              startDate: '2024-02-27T00:00:00',
              endDate: '2024-03-04T00:00:00',
              consecutiveWeeks: 1,
            }
          : { nonConsecutiveWeeks: 2 };
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          json([{ fips: '01001', county: 'Autauga County', state: 'AL', ...duration }]),
        );
      const result = await new UsdmClient(fetcher).weeks(
        {
          states: ['AL'],
          startDate: query.startDate,
          endDate: query.endDate,
          minCategory: 'D2',
          minWeeks: 1,
          mode,
        },
        budget(),
      );
      expect(result[0]).toMatchObject({
        fips: '01001',
        state: 'AL',
        ...(mode === 'consecutive'
          ? { startDate: '2024-02-27', endDate: '2024-03-04', consecutiveWeeks: 1 }
          : { nonConsecutiveWeeks: 2 }),
      });
      const url = new URL(String(fetcher.mock.calls[0]?.[0]));
      expect(url.pathname).toBe(
        `/api/ConsecutiveNonConsecutiveStatistics/${mode === 'consecutive' ? 'GetConsecutiveWeeksCounty' : 'GetNonConsecutiveStatisticsCounty'}`,
      );
      expect(Object.fromEntries(url.searchParams)).toEqual({
        aoi: 'AL',
        startdate: '2/27/2024',
        enddate: '3/5/2024',
        dx: '2',
        minimumweeks: '1',
      });
    },
  );
  it('rejects duplicate and out-of-scope duration rows', async () => {
    const duration = {
      fips: '01001',
      county: 'Autauga County',
      state: 'AL',
      nonConsecutiveWeeks: 2,
    };
    for (const rows of [[duration, duration], [{ ...duration, state: 'TX' }]]) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(rows));
      await expect(
        new UsdmClient(fetcher).weeks(
          {
            states: ['AL'],
            startDate: query.startDate,
            endDate: query.endDate,
            minCategory: 'D2',
            minWeeks: 1,
            mode: 'non_consecutive',
          },
          budget(),
        ),
      ).rejects.toMatchObject({ data: { reason: 'upstream_shape_invalid' } });
    }
  });
  it('retries transient failures once, counting one logical request', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('private upstream details', { status: 503 }))
      .mockResolvedValueOnce(json([]));
    const ledger = budget();
    expect(await new UsdmClient(fetcher).metric(query, ledger)).toEqual([]);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(ledger.requests).toBe(1);
    expect(ledger.bytes).toBeGreaterThan(2);
  });
  it('does not retry input rejection or expose upstream bodies', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('SECRET upstream body', { status: 400 }));
    await expect(new UsdmClient(fetcher).metric(query, budget())).rejects.toThrow('USDM rejected');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('propagates cancellation before network activity', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetcher = vi.fn<typeof fetch>();
    await expect(
      new UsdmClient(fetcher).metric(query, new RequestBudget(controller.signal)),
    ).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('stops a pending HTTP attempt when the caller cancels, without retrying', async () => {
    const controller = new AbortController();
    let started: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      started = resolve;
    });
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      started?.();
      return new Promise<Response>((_resolve, reject) =>
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true }),
      );
    });
    const result = new UsdmClient(fetcher).metric(query, new RequestBudget(controller.signal));
    await pending;
    controller.abort(new Error('Caller cancelled'));
    await expect(result).rejects.toThrow('Caller cancelled');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('cancels a streamed response at the per-response byte ceiling without draining or retry', async () => {
    const cancelled = vi.fn();
    let reads = 0;
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          reads++;
          controller.enqueue(new Uint8Array(17 * 1024 * 1024));
        },
        cancel: cancelled,
      },
      { highWaterMark: 0 },
    );
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(stream));
    await expect(new UsdmClient(fetcher).metric(query, budget())).rejects.toMatchObject({
      data: { reason: 'dataset_too_large' },
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(reads).toBe(1);
    expect(cancelled).toHaveBeenCalledTimes(1);
  });
  it('rejects request plans before network activity and enforces the actual claim ceiling', () => {
    expect(() => new RequestBudget(new AbortController().signal, 65)).toThrow();
    const ledger = budget();
    for (let i = 0; i < 64; i++) ledger.claim('https://usdmdataservices.unl.edu/api/test');
    expect(() => ledger.claim('https://usdmdataservices.unl.edu/api/test')).toThrow();
  });
  it('preserves dataset_too_large when a streamed chunk crosses the workflow byte budget', async () => {
    const ledger = budget();
    ledger.consume(64 * 1024 * 1024);
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('[]'));
    await expect(new UsdmClient(fetcher).metric(query, ledger)).rejects.toMatchObject({
      data: { reason: 'dataset_too_large' },
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
