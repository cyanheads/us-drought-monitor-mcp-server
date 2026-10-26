/**
 * @fileoverview Population provenance and RFC discovery/workflow wire contracts.
 * @module tests/services/drought/domain-workflows
 */
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const latest = '2024-08-27';
const rfc = { areaType: 'river_forecast_center', aoi: 'CBRFC' } as const;
const county = { areaType: 'county', aoi: '53033' } as const;
const methodology = 'https://droughtmonitor.unl.edu/About/AbouttheData/PopulationStatistics.aspx';
const text = (result: Awaited<ReturnType<typeof runToolContract>>) =>
  result.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');

async function fixture(
  options: { missingPopulation?: boolean; emptyRfc?: boolean; mismatched?: boolean } = {},
) {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) => {
    const url = new URL(String(input));
    let rows: unknown[];
    if (url.pathname.includes('/USStatistics/'))
      rows = [{ mapDate: latest, name: 'CONUS', dsci: 1 }];
    else if (url.pathname.includes('Population') && options.missingPopulation) rows = [];
    else if (url.pathname.includes('/RiverForecastCenterStatistics/') && options.emptyRfc)
      rows = [];
    else {
      const isRfc = url.pathname.includes('/RiverForecastCenterStatistics/');
      const name = options.mismatched
        ? 'Northwest'
        : url.searchParams.get('aoi') === 'NWRFC'
          ? 'Northwest'
          : 'Colorado Basin';
      if (url.pathname.endsWith('/GetDSCI'))
        rows = [
          { mapDate: '2024-07-30', dsci: 72 },
          { mapDate: latest, dsci: 94 },
        ]
          .filter(
            (row) =>
              row.mapDate >=
                new Date(url.searchParams.get('startdate')!).toISOString().slice(0, 10) &&
              row.mapDate <= new Date(url.searchParams.get('enddate')!).toISOString().slice(0, 10),
          )
          .map((row) => ({
            ...row,
            ...(isRfc ? { name } : { fips: '53033', county: 'King County', state: 'WA' }),
          }));
      else
        rows = [
          {
            mapDate: latest,
            ...(isRfc
              ? { riverForecastCenterName: name }
              : { fips: '53033', county: 'King County', state: 'WA' }),
            none: 21.3,
            d0: url.searchParams.get('statisticsType') === '2' ? 65.35 : 78.7,
            d1: url.pathname.endsWith('ByPopulation') ? 279048.05 : 11.72,
            d2: 1.63,
            d3: 0,
            d4: 0,
          },
        ];
    }
    return new Response(JSON.stringify(rows));
  });
  vi.stubGlobal('fetch', fetcher);
  const [current, series, reference, service] = await Promise.all([
    import('@/mcp-server/tools/definitions/drought-get-current-severity.tool.js'),
    import('@/mcp-server/tools/definitions/drought-get-timeseries.tool.js'),
    import('@/mcp-server/tools/definitions/drought-list-reference.tool.js'),
    import('@/services/drought/drought-service.js'),
  ]);
  return {
    fetcher,
    current: current.droughtGetCurrentSeverityTool,
    series: series.droughtGetTimeseriesTool,
    reference: reference.droughtListReferenceTool,
    service: service.droughtService,
  };
}
beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2024-09-03T08:00:00Z'));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('population and RFC public workflows', () => {
  it.each([false, true])(
    'carries population interpretation on snapshots including missing=%s',
    async (missingPopulation) => {
      const tools = await fixture({ missingPopulation });
      const result = await runToolContract(tools.current, { area: county, date: latest });
      expect(result.isError).not.toBe(true);
      const parsed = tools.current.output.parse(result.structuredContent);
      expect(parsed.provenance).toMatchObject({
        populationInterpretation: {
          methodologyUrl: methodology,
          caveat: expect.stringContaining('rough census-based estimates'),
        },
      });
      expect(parsed.snapshots[0]).toMatchObject(
        missingPopulation
          ? { populationStatus: 'missing', populationCountCumulative: null }
          : { populationStatus: 'available', populationCountCumulative: { d1_d4: 279048.05 } },
      );
      expect(text(result)).toContain(methodology);
      expect(text(result)).toContain('uniform population');
      expect(parsed.provenance.populationInterpretation).not.toHaveProperty('censusVintage');
    },
  );
  it.each(['population_count', 'population_percent'] as const)(
    'carries %s provenance through both series representations',
    async (metric) => {
      const tools = await fixture();
      for (const statisticsType of ['cumulative', 'categorical'] as const) {
        const result = await runToolContract(tools.series, {
          areas: [county],
          startDate: latest,
          endDate: latest,
          metric,
          statisticsType,
        });
        expect(result.isError).not.toBe(true);
        expect(tools.series.output.parse(result.structuredContent).provenance).toMatchObject({
          populationInterpretation: { methodologyUrl: methodology },
        });
        expect(text(result)).toContain(methodology);
        expect(text(result)).toContain('artificial');
      }
      const areaOnly = await runToolContract(tools.series, {
        areas: [county],
        startDate: latest,
        endDate: latest,
      });
      expect(tools.series.output.parse(areaOnly.structuredContent).provenance).not.toHaveProperty(
        'populationInterpretation',
      );
    },
  );
  it('discovers every RFC over multiple pages and validates empty/filter/cursor boundaries', async () => {
    const tools = await fixture();
    const ids: string[] = [];
    let cursor: string | undefined;
    do {
      const result = await runToolContract(tools.reference, {
        topic: 'river_forecast_centers',
        limit: 5,
        ...(cursor ? { cursor } : {}),
      });
      expect(result.isError).not.toBe(true);
      const page = tools.reference.output.parse(result.structuredContent);
      expect(page.totalCount).toBe(13);
      expect(page.sourceMetadata.some((source) => source.url.endsWith('?rfc'))).toBe(true);
      for (const record of page.records) {
        ids.push(record.id);
        expect(text(result)).toContain(record.id);
        expect(text(result)).toContain(record.name);
      }
      if (page.nextCursor) {
        const decoded = JSON.parse(Buffer.from(page.nextCursor, 'base64url').toString());
        const past = await runToolContract(tools.reference, {
          topic: 'river_forecast_centers',
          cursor: Buffer.from(JSON.stringify({ ...decoded, offset: 13 })).toString('base64url'),
        });
        expect(past.structuredContent).toMatchObject({
          error: { data: { reason: 'invalid_cursor' } },
        });
        expect(text(past)).toContain('Restart drought_list_reference');
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(ids).toHaveLength(13);
    expect(new Set(ids).size).toBe(13);
    const empty = await runToolContract(tools.reference, {
      topic: 'river_forecast_centers',
      nameContains: 'invented-not-real',
      limit: 200,
    });
    expect(empty.structuredContent).toMatchObject({ records: [], totalCount: 0, nextCursor: null });
    expect(text(empty)).toContain('No reference names match');
    const invalid = await runToolContract(tools.reference, {
      topic: 'river_forecast_centers',
      state: 'WA',
    });
    expect(invalid.structuredContent).toMatchObject({
      error: { data: { reason: 'invalid_reference_filter' } },
    });
    expect(text(invalid)).toContain('use filters belonging');
    expect(tools.fetcher).not.toHaveBeenCalled();
  });
  it('resolves RFC names and codes, snapshots unsupported population and joins multi-RFC history', async () => {
    const tools = await fixture();
    const snapshot = await runToolContract(tools.current, {
      area: { ...rfc, aoi: 'Colorado Basin' },
      date: latest,
    });
    expect(snapshot.isError).not.toBe(true);
    expect(tools.current.output.parse(snapshot.structuredContent)).toMatchObject({
      snapshots: [
        {
          id: 'CBRFC',
          populationStatus: 'unsupported',
          populationCountCumulative: null,
          dsci: 94,
          dsciChange4Weeks: { baselineDsci: 72, delta: 22 },
          areaPercentCategorical: { d0_only: 65.35 },
        },
      ],
    });
    expect(text(snapshot)).toContain('CBRFC');
    expect(text(snapshot)).toContain('unsupported');
    const series = await runToolContract(tools.series, {
      areas: [rfc, { ...rfc, aoi: 'nwrfc' }, rfc],
      startDate: '2024-08-20',
      endDate: '2024-09-03',
    });
    expect(series.isError).not.toBe(true);
    expect(tools.series.output.parse(series.structuredContent)).toMatchObject({
      effectiveRange: { startDate: '2024-08-20', endDate: latest },
      areas: [{ id: 'CBRFC' }, { id: 'NWRFC' }],
      rowCount: 2,
      missingObservations: expect.arrayContaining([
        expect.objectContaining({ count: 1, component: 'metric' }),
      ]),
    });
    expect(text(series)).toContain('NWRFC');
    expect(text(series)).toContain('missingObservations');
    expect(tools.fetcher.mock.calls.some(([url]) => String(url).includes('Population'))).toBe(
      false,
    );
  });
  it('distinguishes known RFC empty observations from invented membership and unsupported metrics', async () => {
    const tools = await fixture({ emptyRfc: true });
    const empty = await runToolContract(tools.series, {
      areas: [rfc],
      startDate: latest,
      endDate: latest,
    });
    expect(empty.isError).not.toBe(true);
    expect(tools.series.output.parse(empty.structuredContent)).toMatchObject({
      rows: [],
      rowCount: 0,
      missingAreas: [{ id: 'CBRFC' }],
    });
    expect(text(empty)).toContain('No USDM observations');
    for (const [areas, metric, reason] of [
      [[{ ...rfc, aoi: 'ZZNOTREALRFC' }], 'area_percent', 'unknown_area'],
      [[rfc], 'population_count', 'unsupported_metric'],
    ] as const) {
      const before = tools.fetcher.mock.calls.length;
      const error = await runToolContract(tools.series, {
        areas: [...areas],
        startDate: latest,
        endDate: latest,
        metric,
      });
      expect(error.structuredContent).toMatchObject({
        error: { data: { reason, recovery: { hint: expect.any(String) } } },
      });
      expect(text(error)).toContain(reason);
      expect(text(error)).toContain('drought_list_reference');
      expect(tools.fetcher).toHaveBeenCalledTimes(before);
    }
  });
  it('returns the declared upstream identity recovery on both surfaces', async () => {
    const tools = await fixture({ mismatched: true });
    const result = await runToolContract(tools.series, {
      areas: [rfc],
      startDate: latest,
      endDate: latest,
    });
    expect(result.structuredContent).toMatchObject({
      error: { data: { reason: 'upstream_shape_invalid', recovery: { hint: expect.any(String) } } },
    });
    expect(text(result)).toContain('upstream_shape_invalid');
    expect(text(result)).toContain('Retry the same drought tool later');
  });
});
