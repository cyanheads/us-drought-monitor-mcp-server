/**
 * @fileoverview Population precision and River Forecast Center acquisition contracts.
 * @module tests/services/drought/domain
 */
import { describe, expect, it, vi } from 'vitest';
import { GeographySchema } from '@/services/drought/types.js';
import { type MetricQuery, RequestBudget, UsdmClient } from '@/services/drought/usdm-client.js';

const budget = () => new RequestBudget(new AbortController().signal);
const row = {
  mapDate: '2024-08-27',
  none: 21.3,
  d0: 78.7,
  d1: 13.35,
  d2: 1.63,
  d3: 0,
  d4: 0,
};
const query = {
  aoi: 'CBRFC',
  areaType: 'river_forecast_center',
  areas: [{ areaType: 'river_forecast_center', id: 'CBRFC', name: 'Colorado Basin' }],
  startDate: '2024-08-27',
  endDate: '2024-08-27',
  metric: 'area_percent',
  statisticsType: 'cumulative',
} as const;
const json = (value: unknown) => new Response(JSON.stringify(value));

describe('population and RFC acquisition', () => {
  it('characterizes raw fractional population and unsupported HUC metrics', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async () =>
        json([{ ...row, fips: '53033', county: 'King County', state: 'WA', d1: 279048.05 }]),
      );
    const client = new UsdmClient(fetcher);
    const population: MetricQuery = {
      ...query,
      areaType: 'county',
      aoi: '53033',
      areas: [{ areaType: 'county', id: '53033', name: 'King County', state: 'WA' }],
      metric: 'population_count',
    };
    expect((await client.metric(population, budget()))[0]?.buckets).toMatchObject({
      d1_d4: 279048.05,
    });
    await expect(client.metric({ ...population, areaType: 'huc' }, budget())).rejects.toMatchObject(
      { data: { reason: 'unsupported_metric' } },
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('accepts an explicit RFC selector and routes cumulative and categorical observations', async () => {
    expect(GeographySchema.parse({ areaType: 'river_forecast_center', aoi: 'CBRFC' })).toEqual({
      areaType: 'river_forecast_center',
      aoi: 'CBRFC',
    });
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) =>
      json([
        {
          ...row,
          ...(new URL(String(input)).searchParams.get('statisticsType') === '2'
            ? { d0: 65.35, d1: 11.72 }
            : {}),
          riverForecastCenterName: 'Colorado Basin',
        },
      ]),
    );
    const client = new UsdmClient(fetcher);
    for (const statisticsType of ['cumulative', 'categorical'] as const) {
      const result = await client.metric(
        { ...query, areas: [...query.areas], statisticsType },
        budget(),
      );
      expect(result[0]).toMatchObject({
        id: 'CBRFC',
        name: 'Colorado Basin',
        buckets:
          statisticsType === 'cumulative'
            ? { d0_d4: 78.7, d2_d4: 1.63 }
            : { d0_only: 65.35, d1_only: 11.72, d2_only: 1.63 },
      });
    }
    expect(String(fetcher.mock.calls[0]?.[0])).toContain(
      '/RiverForecastCenterStatistics/GetDroughtSeverityStatisticsByAreaPercent?',
    );
    expect(String(fetcher.mock.calls[1]?.[0])).toContain('statisticsType=2');
  });
  it.each(['Northwest', '', null, undefined])(
    'rejects mismatched or absent RFC identity %s',
    async (riverForecastCenterName) => {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue(json([{ ...row, riverForecastCenterName }]));
      await expect(
        new UsdmClient(fetcher).metric({ ...query, areas: [...query.areas] }, budget()),
      ).rejects.toMatchObject({ data: { reason: 'upstream_shape_invalid' } });
    },
  );
  it('validates DSCI names, preserves empty observations and rejects unsupported population before I/O', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json([{ mapDate: row.mapDate, name: 'Colorado Basin', dsci: 94 }]))
      .mockResolvedValueOnce(json([]))
      .mockResolvedValueOnce(json([{ mapDate: row.mapDate, name: 'Northwest', dsci: 94 }]));
    const client = new UsdmClient(fetcher);
    const input = { ...query, areas: [...query.areas] };
    expect(await client.dsci(input, budget())).toMatchObject([{ id: 'CBRFC', dsci: 94 }]);
    expect(await client.metric(input, budget())).toEqual([]);
    await expect(client.dsci(input, budget())).rejects.toMatchObject({
      data: { reason: 'upstream_shape_invalid' },
    });
    await expect(
      client.metric({ ...input, metric: 'population_count' }, budget()),
    ).rejects.toMatchObject({ data: { reason: 'unsupported_metric' } });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
});
