/**
 * @fileoverview Real drought workflows exercised at the injected HTTP boundary.
 * @module tests/services/drought/workflows
 */
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DataframeService } from '@/services/drought/dataframe-service.js';
import { addDays } from '@/services/drought/dates.js';
import { DroughtService, type StageRequest } from '@/services/drought/drought-service.js';
import { referenceBundle } from '@/services/drought/reference-data.js';
import { UsdmClient } from '@/services/drought/usdm-client.js';

const signal = () => new AbortController().signal;
const latest = '2024-03-05';
const state = { areaType: 'state', aoi: 'AL' } as const;
const raw = (mapDate = latest, extra: Record<string, unknown> = {}) => ({
  mapDate,
  name: 'Alabama',
  none: 10,
  d0: 90,
  d1: 60,
  d2: 30,
  d3: 12,
  d4: 3,
  dsci: 195,
  ...extra,
});
const json = (value: unknown) => new Response(JSON.stringify(value));
function fixture(reply: (url: URL) => unknown[] = () => []) {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) => {
    const url = new URL(String(input));
    return json(
      url.pathname === '/api/USStatistics/GetDSCI'
        ? [{ mapDate: latest, name: 'CONUS', dsci: 1 }]
        : reply(url),
    );
  });
  let now = new Date('2024-03-12T08:00:00Z');
  const service = new DroughtService(new UsdmClient(fetcher), undefined, () => now);
  return {
    service,
    fetcher,
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
  };
}
afterEach(() => vi.useRealTimers());

describe('terminal acquisition lifecycle', () => {
  it.each(['timeseries', 'current', 'comparison'] as const)(
    'aborts and settles sibling HTTP requests before %s rejects',
    async (workflow) => {
      const caller = new AbortController();
      const siblingSignals: AbortSignal[] = [];
      let active = 0;
      let settled = 0;
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname === '/api/USStatistics/GetDSCI')
          return json([{ mapDate: latest, name: 'CONUS', dsci: 1 }]);
        const failing =
          workflow === 'comparison'
            ? url.searchParams.get('startdate') === '3/5/2024'
            : url.pathname.endsWith('ByAreaPercent');
        if (failing) return json({ invalid: 'not an array' });
        const requestSignal = init?.signal;
        if (!requestSignal) throw new Error('Expected an HTTP abort signal');
        siblingSignals.push(requestSignal);
        active++;
        try {
          return await new Promise<Response>((_resolve, reject) => {
            requestSignal.addEventListener(
              'abort',
              () => {
                // Actual cleanup can finish after cancellation has been delivered.
                setTimeout(() => reject(requestSignal.reason), 5);
              },
              { once: true },
            );
          });
        } finally {
          active--;
          settled++;
        }
      });
      const service = new DroughtService(
        new UsdmClient(fetcher),
        undefined,
        () => new Date('2024-03-12T08:00:00Z'),
      );
      try {
        const admission = new DataframeService();
        const result = admission.withAdmission<unknown>(
          createMockContext({ signal: caller.signal }),
          () =>
            workflow === 'timeseries'
              ? service.timeseries(
                  { areas: [state], startDate: latest, endDate: latest },
                  caller.signal,
                )
              : workflow === 'current'
                ? service.current({ area: state }, caller.signal)
                : service.compare(
                    { scope: 'states', date: latest, baselineDate: '2024-02-27' },
                    caller.signal,
                  ),
        );
        await expect(result).rejects.toMatchObject({
          data: { reason: 'upstream_shape_invalid', retryable: false },
        });
        expect(siblingSignals.length).toBeGreaterThan(0);
        expect(siblingSignals.every((item) => item.aborted)).toBe(true);
        expect(active).toBe(0);
        expect(settled).toBe(siblingSignals.length);
        expect(caller.signal.aborted).toBe(false);
      } finally {
        caller.abort();
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    },
  );
});

describe('published snapshot workflow', () => {
  it('uses actual publication on Tuesday, single-flights discovery and expires it after five minutes', async () => {
    const { service, fetcher, advance } = fixture(() => [raw()]);
    const results = await Promise.all([
      service.current({ area: state }, signal()),
      service.current({ area: state }, signal()),
    ]);
    expect(results.map((result) => result.effectiveMapDate)).toEqual([latest, latest]);
    const discoveries = () =>
      fetcher.mock.calls.filter(([url]) => String(url).includes('/USStatistics/GetDSCI'));
    expect(discoveries()).toHaveLength(1);
    expect(new URL(String(discoveries()[0]?.[0])).searchParams.get('startdate')).toBe('2/27/2024');
    expect(new URL(String(discoveries()[0]?.[0])).searchParams.get('enddate')).toBe('3/12/2024');
    await service.current({ area: state, date: '2024-03-11' }, signal());
    expect(discoveries()).toHaveLength(1);
    advance(300_000);
    await service.current({ area: state }, signal());
    expect(discoveries()).toHaveLength(2);
  });
  it('uses exact 28/364-day DSCI baselines and preserves missing supported population', async () => {
    const { service } = fixture((url) =>
      url.pathname.endsWith('/GetDSCI')
        ? [
            raw(latest, { dsci: 200 }),
            raw(addDays(latest, -28), { dsci: 155 }),
            raw(addDays(latest, -364), { dsci: 80 }),
          ]
        : url.pathname.endsWith('ByPopulation')
          ? []
          : [raw()],
    );
    const result = await service.current({ area: state, date: '2024-03-10' }, signal());
    expect(result.snapshots[0]).toMatchObject({
      mapDate: latest,
      validEnd: '2024-03-11',
      populationStatus: 'missing',
      populationCountCumulative: null,
      dsciChange4Weeks: {
        baselineMapDate: '2024-02-06',
        baselineDsci: 155,
        delta: 45,
        status: 'available',
      },
      dsciChange52Weeks: {
        baselineMapDate: '2023-03-07',
        baselineDsci: 80,
        delta: 120,
        status: 'available',
      },
    });
  });
  it('does not substitute nearby DSCI rows or fabricate missing observations', async () => {
    const { service } = fixture((url) =>
      url.pathname.endsWith('/GetDSCI')
        ? [raw(latest, { dsci: null }), raw('2024-02-13', { dsci: 100 })]
        : [raw()],
    );
    const result = await service.current({ area: state }, signal());
    expect(result.snapshots[0]).toMatchObject({
      dsci: null,
      dsciStatus: 'missing',
      dsciChange4Weeks: { baselineDsci: null, delta: null, status: 'missing' },
    });
  });
  it('makes no population request for HUC and reports unsupported rather than missing', async () => {
    const { service, fetcher } = fixture(() => [raw(latest, { hucid: '01' })]);
    const result = await service.current(
      { area: { areaType: 'huc', aoi: '01', hucLevel: 2 } },
      signal(),
    );
    expect(result.snapshots[0]).toMatchObject({
      populationCountCumulative: null,
      populationStatus: 'unsupported',
    });
    expect(fetcher.mock.calls.some(([url]) => String(url).includes('Population'))).toBe(false);
  });
  it.each(['1999-12-31', '2024-03-12'])(
    'returns coverage guidance for unpublished %s',
    async (date) => {
      const { service, fetcher } = fixture();
      expect(await service.current({ area: state, date }, signal())).toMatchObject({
        found: false,
        snapshots: [],
        guidance: expect.stringContaining('Published maps span'),
      });
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );
  it('never assembles a snapshot from incomplete required metric components', async () => {
    const { service } = fixture((url) => (url.pathname.endsWith('ByArea') ? [] : [raw()]));
    expect(await service.current({ area: state }, signal())).toMatchObject({
      found: false,
      snapshots: [],
      guidance: expect.stringContaining('areaSqMilesCumulative'),
    });
  });
  it('rejects unknown names before network I/O', async () => {
    const { service, fetcher } = fixture();
    await expect(
      service.current({ area: { areaType: 'state', aoi: 'Atlantis' } }, signal()),
    ).rejects.toMatchObject({ data: { reason: 'unknown_area' } });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('returns an empty snapshot for an unbundled numeric county with no upstream observations', async () => {
    const { service } = fixture();
    expect(
      await service.current({ area: { areaType: 'county', aoi: '01999' } }, signal()),
    ).toMatchObject({
      found: false,
      snapshots: [],
      guidance: expect.stringContaining('drought_list_reference'),
    });
  });
  it('does not let the first cancelled discovery caller fail a surviving joiner', async () => {
    let started: (() => void) | undefined;
    let finish: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      if (String(input).includes('/USStatistics/GetDSCI')) {
        started?.();
        await Promise.race([
          blocked,
          new Promise<never>((_resolve, reject) =>
            init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
              once: true,
            }),
          ),
        ]);
        return json([{ mapDate: latest, name: 'CONUS', dsci: 1 }]);
      }
      return json([raw()]);
    });
    const service = new DroughtService(
      new UsdmClient(fetcher),
      undefined,
      () => new Date('2024-03-12T08:00:00Z'),
    );
    const controller = new AbortController();
    const first = service.current({ area: state }, controller.signal);
    const firstRejected = expect(first).rejects.toThrow();
    await entered;
    const survivor = service.current({ area: state }, signal());
    controller.abort();
    finish?.();
    await firstRejected;
    expect(await survivor).toMatchObject({ found: true, effectiveMapDate: latest });
  });
  it('aborts discovery HTTP work when its sole caller cancels', async () => {
    let started: (() => void) | undefined;
    let stopped: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const aborted = new Promise<void>((resolve) => {
      stopped = resolve;
    });
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_input, init) => {
      started?.();
      return new Promise<Response>((_resolve, reject) =>
        init?.signal?.addEventListener(
          'abort',
          () => {
            stopped?.();
            reject(init.signal?.reason);
          },
          { once: true },
        ),
      );
    });
    const service = new DroughtService(
      new UsdmClient(fetcher),
      undefined,
      () => new Date('2024-03-12T08:00:00Z'),
    );
    const controller = new AbortController();
    const result = service.current({ area: state }, controller.signal);
    const rejected = expect(result).rejects.toThrow();
    await entered;
    controller.abort();
    await Promise.all([rejected, aborted]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe('complete timeseries producer', () => {
  it.each(['cumulative', 'categorical'] as const)(
    'snaps Sunday/Monday, batches states, preserves all rows and tied %s peaks across gaps',
    async (statisticsType) => {
      const dates = ['2024-02-20', '2024-02-27', '2024-03-05'];
      const { service, fetcher } = fixture(() =>
        dates.map((date, index) =>
          raw(date, { dsci: index === 1 ? 50 : 200, d3: index === 1 ? 1 : 12, d4: 3 }),
        ),
      );
      const result = await service.timeseries(
        {
          areas: [state, { areaType: 'state', aoi: 'Alabama' }],
          startDate: '2024-02-25',
          endDate: '2024-03-11',
          statisticsType,
        },
        signal(),
      );
      expect(result.effectiveRange).toEqual({ startDate: '2024-02-20', endDate: latest });
      expect(result.areas).toHaveLength(1);
      expect(result.rows.map((row) => row.row_id)).toEqual([1, 2, 3]);
      expect(result.rows[2]?.validEnd).toBe('2024-03-11');
      const peakRuns = [
        { startMapDate: '2024-02-20', endMapDate: '2024-02-20', stepDays: 7 },
        { startMapDate: latest, endMapDate: latest, stepDays: 7 },
      ];
      expect(result.summary[0]).toMatchObject({
        observationCount: 3,
        peakDsci: { value: 200, mapDateRuns: peakRuns },
        peakD3D4: {
          value: statisticsType === 'categorical' ? 15 : 12,
          mapDateRuns: peakRuns,
          unit: 'percent',
        },
      });
      expect(fetcher).toHaveBeenCalledTimes(3);
      expect(new URL(String(fetcher.mock.calls[1]?.[0])).searchParams.get('aoi')).toBe('01');
    },
  );
  it('discloses missing metric and DSCI weeks independently without zero filling', async () => {
    const { service } = fixture((url) =>
      url.pathname.endsWith('/GetDSCI') ? [raw('2024-02-27', { dsci: null })] : [raw('2024-02-27')],
    );
    const result = await service.timeseries(
      { areas: [state], startDate: '2024-02-27', endDate: latest },
      signal(),
    );
    expect(result.rowCount).toBe(1);
    expect(result.rows[0]?.dsci).toBeNull();
    expect(result.missingObservations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          component: 'metric',
          count: 1,
          mapDateRuns: [{ startMapDate: latest, endMapDate: latest, stepDays: 7 }],
        }),
        expect.objectContaining({
          component: 'dsci',
          count: 2,
          mapDateRuns: [{ startMapDate: '2024-02-27', endMapDate: latest, stepDays: 7 }],
        }),
      ]),
    );
    expect(result.summary[0]?.peakDsci).toBeNull();
  });
  it('sends all complete rows to the staging seam before any preview', async () => {
    const { service } = fixture(() => [raw('2024-02-27'), raw()]);
    const observed: StageRequest[] = [];
    const result = await service.timeseries(
      { areas: [state], startDate: '2024-02-27', endDate: latest },
      signal(),
      async (request) => {
        observed.push(request);
        return { rows: request.rows.slice(0, 1), staging: null };
      },
    );
    expect(observed[0]?.rows).toHaveLength(2);
    expect(observed[0]?.metadata).toMatchObject({ rowCount: 2 });
    expect(result.rowCount).toBe(2);
    expect(result.rows).toHaveLength(1);
  });
  it('uses county postal batching and filters unrequested returned counties', async () => {
    const { service, fetcher } = fixture(() =>
      ['01001', '01003', '01005'].map((fips) => raw(latest, { fips, county: fips, state: 'AL' })),
    );
    const result = await service.produceTimeseries(
      {
        areas: [
          { areaType: 'county', aoi: '01003' },
          { areaType: 'county', aoi: '01001' },
        ],
        startDate: latest,
        endDate: latest,
      },
      signal(),
    );
    expect(result.rows.map((row) => row.id)).toEqual(['01001', '01003']);
    expect(
      fetcher.mock.calls.slice(1).map(([url]) => new URL(String(url)).searchParams.get('aoi')),
    ).toEqual(['AL', 'AL']);
  });
  it('partitions full-history county batches by byte-estimated weekly windows without gaps or duplicate boundaries', async () => {
    const { service, fetcher } = fixture();
    const result = await service.produceTimeseries(
      {
        areas: [
          { areaType: 'county', aoi: '01001' },
          { areaType: 'county', aoi: '01003' },
        ],
        startDate: '2000-01-04',
        endDate: latest,
      },
      signal(),
    );
    const requests = fetcher.mock.calls
      .map(([url]) => new URL(String(url)))
      .filter((url) => url.pathname.endsWith('ByAreaPercent'));
    expect(requests.length).toBeGreaterThan(1);
    const iso = (value: string | null) => {
      if (!value) throw new Error('Missing date');
      const [month, day, year] = value.split('/');
      return `${year}-${month?.padStart(2, '0')}-${day?.padStart(2, '0')}`;
    };
    const windows = requests.map((url) => ({
      start: iso(url.searchParams.get('startdate')),
      end: iso(url.searchParams.get('enddate')),
    }));
    expect(windows[0]?.start).toBe('2000-01-04');
    expect(windows.at(-1)?.end).toBe(latest);
    const counties = referenceBundle.counties.filter((county) => county.state === 'AL').length;
    for (const [index, window] of windows.entries()) {
      expect(requests[index]?.searchParams.get('aoi')).toBe('AL');
      if (index) expect(window.start).toBe(addDays(windows[index - 1]?.end ?? '', 7));
      const weeks = (Date.parse(window.end) - Date.parse(window.start)) / 604_800_000 + 1;
      expect(weeks * counties * 1024).toBeLessThanOrEqual(8 * 1024 * 1024);
    }
    expect(fetcher.mock.calls).toHaveLength(1 + requests.length * 2);
    expect(result.metadata.missingObservations).toHaveLength(4);
    expect(result.rows).toEqual([]);
  });
  it('uses a direct exact selector for shape-valid unknown numeric counties', async () => {
    const { service, fetcher } = fixture(() => [
      raw(latest, { fips: '99999', county: 'Unbundled county' }),
    ]);
    const result = await service.produceTimeseries(
      { areas: [{ areaType: 'county', aoi: '99999' }], startDate: latest, endDate: latest },
      signal(),
    );
    expect(result.rows[0]).toMatchObject({ id: '99999', name: 'Unbundled county' });
    expect(new URL(String(fetcher.mock.calls[1]?.[0])).searchParams.get('aoi')).toBe('99999');
  });
  it('returns valid empty coverage with every requested missing area', async () => {
    const { service, fetcher } = fixture();
    const result = await service.timeseries(
      { areas: [state], startDate: '2024-03-12', endDate: '2024-03-18' },
      signal(),
    );
    expect(result).toMatchObject({ effectiveRange: null, rows: [], rowCount: 0, staging: null });
    expect(result.missingAreas).toHaveLength(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('rejects heterogeneous geography, unsupported population and oversized request plans before I/O', async () => {
    const { service, fetcher } = fixture();
    const base = { startDate: latest, endDate: latest };
    await expect(
      service.produceTimeseries(
        { ...base, areas: [state, { areaType: 'county', aoi: '01001' }] },
        signal(),
      ),
    ).rejects.toMatchObject({ data: { reason: 'invalid_area' } });
    await expect(
      service.produceTimeseries(
        {
          ...base,
          areas: [{ areaType: 'huc', aoi: '01', hucLevel: 2 }],
          metric: 'population_count',
        },
        signal(),
      ),
    ).rejects.toMatchObject({ data: { reason: 'unsupported_metric' } });
    await expect(
      service.produceTimeseries(
        {
          ...base,
          areas: Array.from({ length: 33 }, (_, index) => ({
            areaType: 'huc' as const,
            aoi: String(index).padStart(4, '0'),
            hucLevel: 4 as const,
          })),
        },
        signal(),
      ),
    ).rejects.toMatchObject({ data: { reason: 'dataset_too_large', maxRequests: 64 } });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('complete severity comparison producer', () => {
  it('ranks ties by canonical ID and omits areas without exact baseline values', async () => {
    const { service } = fixture((url) =>
      url.searchParams.get('startdate') === '2/6/2024'
        ? [
            raw('2024-02-06', { name: 'Alabama', dsci: 100 }),
            raw('2024-02-06', { name: 'Alaska', dsci: 50 }),
          ]
        : [
            raw(latest, { name: 'Alaska', dsci: 150 }),
            raw(latest, { name: 'Alabama', dsci: 200 }),
            raw(latest, { name: 'Arizona', dsci: 250 }),
          ],
    );
    const result = await service.produceComparison(
      { scope: 'states', date: latest, baselineDate: '2024-02-06' },
      signal(),
    );
    expect(result.rows.map((row) => [row.id, row.rank, row.rankedValue, row.change])).toEqual([
      ['01', 1, 100, 100],
      ['02', 1, 100, 100],
    ]);
    expect(result.metadata.excludedAreas).toContainEqual(
      expect.objectContaining({
        area: expect.objectContaining({ id: '04' }),
        missing: ['baseline'],
      }),
    );
  });
  it('uses competition ranks 1,1,3 and stages every row when limit is smaller', async () => {
    const { service } = fixture(() => [
      raw(latest, { name: 'Arizona', dsci: 10 }),
      raw(latest, { name: 'Alaska', dsci: 50 }),
      raw(latest, { name: 'Alabama', dsci: 50 }),
    ]);
    const requests: StageRequest[] = [];
    const result = await service.compare(
      { scope: 'states', limit: 1 },
      signal(),
      async (request) => {
        requests.push(request);
        return { rows: request.rows.slice(0, request.limit), staging: null };
      },
    );
    expect(requests[0]?.rows.map((row) => ('rank' in row ? row.rank : null))).toEqual([1, 1, 3]);
    expect(result.comparedCount).toBe(3);
    expect(result.rows).toHaveLength(1);
  });
  it('uses all supported postal selectors for nationwide county comparison', async () => {
    const { service, fetcher } = fixture(() =>
      referenceBundle.counties.map((area) =>
        raw(latest, { fips: area.id, county: area.name, state: area.state }),
      ),
    );
    const result = await service.produceComparison({ scope: 'counties' }, signal());
    expect(result.metadata.includedStates).toEqual(
      referenceBundle.states.map((area) => area.state),
    );
    expect(new URL(String(fetcher.mock.calls[1]?.[0])).searchParams.get('aoi')?.split(',')).toEqual(
      result.metadata.includedStates,
    );
    expect(result.rows).toHaveLength(referenceBundle.counties.length);
  });
  it('returns an empty unpublished nationwide comparison rather than metadata overflow', async () => {
    const { service, fetcher } = fixture();
    const result = await service.compare({ scope: 'counties', date: '2024-03-12' }, signal());
    expect(result).toMatchObject({ rows: [], comparedCount: 0, staging: null });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe('authoritative weeks and immutable pagination', () => {
  const input = {
    startDate: '2024-02-20',
    endDate: latest,
    minCategory: 'D2' as const,
    minWeeks: 1,
    states: ['AL'],
  };
  const streaks = [
    {
      fips: '01001',
      county: 'Autauga County',
      state: 'AL',
      startDate: '2024-02-20',
      endDate: '2024-02-26',
      consecutiveWeeks: 1,
    },
    {
      fips: '01001',
      county: 'Autauga County',
      state: 'AL',
      startDate: latest,
      endDate: '2024-03-11',
      consecutiveWeeks: 1,
    },
    {
      fips: '01003',
      county: 'Baldwin County',
      state: 'AL',
      startDate: '2024-02-27',
      endDate: '2024-03-11',
      consecutiveWeeks: 2,
    },
  ];
  it('retains repeated county streaks, Monday endings and all rows across cached pages', async () => {
    const { service, fetcher } = fixture(() => [...streaks].reverse());
    const first = await service.weeks({ ...input, limit: 1 }, signal());
    const second = await service.weeks(
      { ...input, states: ['Alabama'], cursor: first.nextCursor ?? undefined, limit: 2 },
      signal(),
    );
    expect([...first.rows, ...second.rows]).toEqual(streaks);
    expect(second).toMatchObject({ totalCount: 3, hasMore: false, nextCursor: null });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('rejects changed filters, forged offsets and expired cursors without network replay', async () => {
    const { service, fetcher, advance } = fixture(() => streaks);
    const first = await service.weeks({ ...input, limit: 1 }, signal());
    const cursor = first.nextCursor ?? '';
    await expect(
      service.weeks({ ...input, cursor, minCategory: 'D3' }, signal()),
    ).rejects.toMatchObject({ data: { reason: 'invalid_cursor' } });
    const forged: Record<string, unknown> = JSON.parse(Buffer.from(cursor, 'base64url').toString());
    forged.offset = 3;
    await expect(
      service.weeks(
        { ...input, cursor: Buffer.from(JSON.stringify(forged)).toString('base64url') },
        signal(),
      ),
    ).rejects.toMatchObject({ data: { reason: 'invalid_cursor' } });
    advance(300_000);
    await expect(service.weeks({ ...input, cursor }, signal())).rejects.toMatchObject({
      data: { reason: 'invalid_cursor' },
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('preserves nonconsecutive source counts and exact county filtering', async () => {
    const { service, fetcher } = fixture(() => [
      { fips: '01001', county: 'Autauga County', state: 'AL', nonConsecutiveWeeks: 2 },
      { fips: '01003', county: 'Baldwin County', state: 'AL', nonConsecutiveWeeks: 3 },
    ]);
    const result = await service.weeks(
      { ...input, states: undefined, county: '01001', mode: 'non_consecutive' },
      signal(),
    );
    expect(result.rows).toEqual([
      { fips: '01001', county: 'Autauga County', state: 'AL', nonConsecutiveWeeks: 2 },
    ]);
    expect(String(fetcher.mock.calls[1]?.[0])).toContain('GetNonConsecutiveStatisticsCounty');
  });
  it('returns empty without duration I/O when publication clipping makes minWeeks impossible', async () => {
    const { service, fetcher } = fixture();
    expect(
      await service.weeks(
        { ...input, startDate: latest, endDate: '2024-03-18', minWeeks: 2 },
        signal(),
      ),
    ).toMatchObject({ totalCount: 0, rows: [], nextCursor: null });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('returns the exact 200-row maximum page and its final remainder without losing rows', async () => {
    const rows = Array.from({ length: 201 }, (_, index) => ({
      fips: `01${String(index).padStart(3, '0')}`,
      county: `County ${index}`,
      state: 'AL',
      nonConsecutiveWeeks: 2,
    }));
    const { service, fetcher } = fixture(() => rows);
    const first = await service.weeks({ ...input, mode: 'non_consecutive', limit: 200 }, signal());
    expect(first.rows).toHaveLength(200);
    expect(first.hasMore).toBe(true);
    const last = await service.weeks(
      { ...input, mode: 'non_consecutive', limit: 200, cursor: first.nextCursor ?? undefined },
      signal(),
    );
    expect([...first.rows, ...last.rows]).toEqual(rows);
    expect(last).toMatchObject({
      totalCount: 201,
      rows: [rows[200]],
      hasMore: false,
      nextCursor: null,
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('rejects a single oversized record rather than returning a nonadvancing cursor', async () => {
    const { service } = fixture(() => [{ ...streaks[0], county: 'X'.repeat(40_001) }]);
    await expect(service.weeks(input, signal())).rejects.toMatchObject({
      data: { reason: 'dataset_too_large' },
    });
  });
  it('returns empty unknown numeric counties using their valid state prefix', async () => {
    const { service, fetcher } = fixture();
    expect(
      await service.weeks({ ...input, states: undefined, county: '01999' }, signal()),
    ).toMatchObject({ rows: [], totalCount: 0, states: ['AL'] });
    expect(new URL(String(fetcher.mock.calls[1]?.[0])).searchParams.get('aoi')).toBe('AL');
  });
});
