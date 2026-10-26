/**
 * @fileoverview Dual-surface dataframe contracts and operator defaults using real DuckDB.
 * @module tests/services/drought/datacanvas-contract
 */
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { disabledTool } from '@cyanheads/mcp-ts-core';
import { CanvasRegistry, DataCanvas, DuckdbProvider } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getCanvasConfig, seedCanvasDefaults } from '@/config/canvas-config.js';
import { droughtCompareAreasTool as compareTool } from '@/mcp-server/tools/definitions/drought-compare-areas.tool.js';
import { droughtDataframeDescribeTool as describeTool } from '@/mcp-server/tools/definitions/drought-dataframe-describe.tool.js';
import { droughtDataframeDropTool as dropTool } from '@/mcp-server/tools/definitions/drought-dataframe-drop.tool.js';
import { droughtDataframeQueryTool as queryTool } from '@/mcp-server/tools/definitions/drought-dataframe-query.tool.js';
import { droughtGetTimeseriesTool as timeseriesTool } from '@/mcp-server/tools/definitions/drought-get-timeseries.tool.js';
import { setCanvas } from '@/services/canvas-accessor.js';
import { dataframeService } from '@/services/drought/dataframe-service.js';
import { DroughtService } from '@/services/drought/drought-service.js';
import { referenceBundle } from '@/services/drought/reference-data.js';
import { UsdmClient } from '@/services/drought/usdm-client.js';
import type { StageHandle, WeeklyRow } from '@/services/drought/workflow-schema.js';

let root: string;
let canvas: DataCanvas;
let handle: StageHandle;
let tenant = 0;
let tenantId: string;
const source = {
  provenance: {
    sourceUrls: ['https://usdmdataservices.unl.edu/api/source'],
    retrievedAt: '2024-03-05T12:00:00Z',
    credit: 'Literal\r\nsource\n``` untouched',
    dsciExperimental: true,
  },
  requestedRange: { startDate: '2024-02-27', endDate: '2024-03-05' },
  missing: null,
};
const original: WeeklyRow[] = [0, 1].map((index) => ({
  areaType: 'county',
  id: '01001',
  state: 'AL',
  name: 'Autauga \r\nCounty',
  row_id: index + 1,
  mapDate: '2024-03-05',
  validStart: '2024-03-05',
  validEnd: '2024-03-11',
  metric: 'area_percent',
  statisticsType: 'cumulative',
  unit: 'percent',
  buckets: { none: 0, d0_d4: index ? 0.125 : 0, d1_d4: null, d2_d4: 12.375, d3_d4: 0, d4: 0 },
  dsci: null,
  dsciStatus: 'missing',
}));
const options = () => ({ context: { tenantId } });
function text(blocks: { type: string; text?: string }[]) {
  return blocks
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('\n');
}
function scalars(value: unknown): unknown[] {
  return Array.isArray(value)
    ? value.flatMap(scalars)
    : value !== null && typeof value === 'object'
      ? Object.values(value).flatMap(scalars)
      : [value];
}
function parity(result: Awaited<ReturnType<typeof runToolContract>>) {
  expect(result.isError).not.toBe(true);
  const rendered = text(result.content);
  const html = execFileSync(
    'bun',
    ['-e', 'console.log(Bun.markdown.html(await Bun.stdin.text()))'],
    { input: text(result.content.slice(0, 1)), encoding: 'utf8' },
  ).replace(/<th[\s\S]*?<\/th>/g, '');
  const decode = (value: string) =>
    value
      .replace(/&#(x[\da-f]+|\d+);/gi, (_, code: string) =>
        String.fromCodePoint(
          code.startsWith('x') ? Number.parseInt(code.slice(1), 16) : Number(code),
        ),
      )
      .replace(
        /&(amp|lt|gt|quot|apos);/g,
        (_, entity: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[entity] ?? '',
      );
  const decoded = [...html.matchAll(/<code[^>]*>([\s\S]*?)<\/code>/g)]
    .flatMap((match) => scalars(JSON.parse(decode(match[1] ?? ''))))
    .filter((value) => !(typeof value === 'string' && /^https:\/\/[^\s<>]+$/.test(value)));
  const { totalCount, effectiveLimit, limitNotice, ...domain } = result.structuredContent as Record<
    string,
    unknown
  >;
  if (typeof effectiveLimit === 'number')
    expect(rendered).toContain(`**effectiveLimit:** ${effectiveLimit}`);
  if (typeof limitNotice === 'string') expect(rendered).toContain(limitNotice);
  if (typeof totalCount === 'number') expect(rendered).toContain(`${totalCount} total`);
  const values = scalars(domain).filter(
    (value) => !(typeof value === 'string' && /^https:\/\/[^\s<>]+$/.test(value)),
  );
  expect(decoded).toEqual(values);
  for (const value of scalars(result.structuredContent))
    if (typeof value === 'string' && value.startsWith('https://'))
      expect(
        [...html.matchAll(/<a href="([^"]*)"/g)].map((match) => decodeURI(decode(match[1] ?? ''))),
      ).toContain(decodeURI(value));
}

beforeEach(async () => {
  tenantId = `canvas-contract-${tenant++}`;
  root = await mkdtemp(join(tmpdir(), 'drought-contract-test-'));
  const provider = new DuckdbProvider({
    defaultRowLimit: 501,
    exportRootPath: root,
    tempRootPath: root,
    memoryLimitMb: 128,
    schemaSniffRows: 100,
  });
  canvas = new DataCanvas(
    provider,
    new CanvasRegistry(provider, {
      ttlMs: 86_400_000,
      absoluteCapMs: 604_800_000,
      maxCanvasesPerTenant: 4,
      sweeperIntervalMs: 0,
    }),
  );
  setCanvas(canvas);
  const context = createMockContext({ tenantId });
  const result = await dataframeService.withAdmission(context, (stage) =>
    stage({
      kind: 'timeseries',
      rows: original,
      metadata: source,
      limit: 1,
      signal: context.signal,
    }),
  );
  handle = result.staging!;
});
afterEach(async () => {
  setCanvas(undefined);
  await canvas.shutdown(createMockContext({ tenantId }));
  await rm(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('dataframe public contracts', () => {
  it.each(['population_count', 'area_percent'] as const)(
    'retains %s population/RFC provenance across describe and paged SQL without refetch',
    async (metric) => {
      const population = metric === 'population_count';
      const context = createMockContext({ tenantId });
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) => {
        const url = new URL(String(input));
        const rows = url.pathname.includes('/USStatistics/')
          ? [{ mapDate: '2024-03-05', name: 'CONUS', dsci: 1 }]
          : ['2024-02-27', '2024-03-05'].map((mapDate) => ({
              mapDate,
              ...(population
                ? { fips: '53033', county: 'King County', state: 'WA' }
                : url.pathname.endsWith('/GetDSCI')
                  ? { name: 'Colorado Basin' }
                  : { riverForecastCenterName: 'Colorado Basin' }),
              none: 0,
              d0: 78.7,
              d1: population ? 279048.05 : 13.35,
              d2: 1.63,
              d3: 0,
              d4: 0,
              dsci: 94,
            }));
        return new Response(JSON.stringify(rows));
      });
      const service = new DroughtService(
        new UsdmClient(fetcher),
        undefined,
        () => new Date('2024-03-12T00:00:00Z'),
      );
      const produced = await dataframeService.withAdmission(context, (stage) =>
        service.timeseries(
          {
            areas: [
              population
                ? { areaType: 'county', aoi: '53033' }
                : { areaType: 'river_forecast_center', aoi: 'CBRFC' },
            ],
            startDate: '2024-02-27',
            endDate: '2024-03-05',
            metric,
            canvas_id: handle.canvas_id,
          },
          context.signal,
          (request) => stage({ ...request, limit: 1 }),
        ),
      );
      const parsed = timeseriesTool.output.parse(produced);
      expect(parsed.staging?.row_count).toBe(2);
      const rendered = text(await timeseriesTool.format!(parsed));
      expect(rendered).toContain(population ? '279048.05' : 'CBRFC');
      if (population) {
        expect(parsed.provenance).toMatchObject({
          populationInterpretation: {
            caveat: expect.stringContaining('rough census-based estimates'),
          },
        });
        expect(rendered).toContain('PopulationStatistics.aspx');
      } else expect(parsed.provenance).not.toHaveProperty('populationInterpretation');
      const calls = fetcher.mock.calls.length;
      const staged = parsed.staging!;
      const described = await runToolContract(
        describeTool,
        { canvas_id: staged.canvas_id, table_name: staged.table_name },
        options(),
      );
      parity(described);
      expect(
        describeTool.output.parse(described.structuredContent).tables[0]?.metadata,
      ).toMatchObject({ provenance: parsed.provenance });
      for (const [offset, count] of [
        [0, 1],
        [1, 1],
        [2, 0],
      ] as const) {
        const result = await runToolContract(
          queryTool,
          {
            canvas_id: staged.canvas_id,
            sql: `SELECT * FROM ${staged.table_name} ORDER BY row_id`,
            limit: 1,
            offset,
          },
          options(),
        );
        const page = queryTool.output.parse(result.structuredContent);
        parity({ ...result, structuredContent: page });
        if (offset === 0) {
          expect(result.structuredContent).toMatchObject({ truncated: true, shown: 1, cap: 1 });
          expect(text(result.content)).toContain('Continue with next_offset');
        }
        if (offset === 2) expect(text(result.content)).toContain('No rows remain at offset 2');
        expect(page.rows).toHaveLength(count);
        expect(
          page.tableMetadata.find((table) => table.name === staged.table_name)?.provenance,
        ).toEqual(parsed.provenance);
        if (population) expect(text(result.content)).toContain('PopulationStatistics.aspx');
        if (count)
          expect(page.rows[0]).toMatchObject(
            population ? { id: '53033', d1_d4: 279048.05 } : { id: 'CBRFC', d2_d4: 1.63 },
          );
      }
      expect(fetcher).toHaveBeenCalledTimes(calls);
    },
  );
  it('preserves cancellation while reading retained metadata on both surfaces', async () => {
    const controller = new AbortController();
    const acquire = canvas.acquire.bind(canvas);
    vi.spyOn(canvas, 'acquire').mockImplementation(async (...args) => {
      const instance = await acquire(...args);
      controller.abort();
      return instance;
    });
    const result = await runToolContract(
      describeTool,
      { canvas_id: handle.canvas_id, table_name: handle.table_name },
      { context: { tenantId, signal: controller.signal } },
    );
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.RequestCancelled },
    });
    expect(text(result.content)).toMatch(/cancel/i);
    vi.restoreAllMocks();
  });
  it('names staged continuation only when a clamped comparison has rows remaining', async () => {
    const counties = referenceBundle.counties.filter((county) => county.state === 'TX');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2024-03-12T08:00:00Z'));
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>().mockImplementation(async (input) => {
        const url = new URL(String(input));
        return new Response(
          JSON.stringify(
            url.pathname.includes('/USStatistics/')
              ? [{ mapDate: '2024-03-05', name: 'CONUS', dsci: 1 }]
              : counties.map((county) => ({
                  fips: county.id,
                  county: county.name,
                  state: 'TX',
                  mapDate: '2024-03-05',
                  dsci: 1,
                })),
          ),
        );
      }),
    );
    const result = await runToolContract(
      compareTool,
      { scope: 'counties', state: 'TX', date: '2024-03-05', limit: 201 },
      options(),
    );
    expect(result.isError).not.toBe(true);
    const parsed = compareTool.output.parse(result.structuredContent);
    expect(parsed.staging).not.toBeNull();
    expect(parsed.rows.length).toBeLessThan(parsed.comparedCount);
    expect(result.structuredContent).toMatchObject({
      effectiveLimit: 200,
      limitNotice: expect.stringContaining('Use the staged table'),
    });
    expect(text(result.content)).toContain('Use the staged table');
  });
  it('clamps count-based retained metadata pages and recovers each wide item exactly once', async () => {
    const context = createMockContext({ tenantId });
    const items = Array.from({ length: 250 }, (_, index) => ({
      index,
      nested: { value: 'm'.repeat(1000) },
    }));
    const staged = await dataframeService.withAdmission(context, (stage) =>
      stage({ kind: 'timeseries', rows: [], metadata: { summary: items }, signal: context.signal }),
    );
    const base = {
      canvas_id: staged.staging!.canvas_id,
      table_name: staged.staging!.table_name,
      metadata_field: 'summary' as const,
    };
    const recovered: unknown[] = [];
    for (const [offset, count, next] of [
      [0, 100, 100],
      [100, 100, 200],
      [200, 50, null],
      [300, 0, null],
    ] as const) {
      const result = await runToolContract(
        describeTool,
        { ...base, metadata_offset: offset, metadata_limit: 101 },
        options(),
      );
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        effectiveLimit: 100,
        limitNotice: expect.stringContaining('100'),
        metadata_page: { total: 250, offset, next_offset: next },
      });
      const page = describeTool.output.parse(result.structuredContent).metadata_page!;
      expect(page.items).toHaveLength(count);
      recovered.push(...page.items);
      parity(result);
    }
    expect(recovered).toEqual(items);
    const exact = await runToolContract(describeTool, { ...base, metadata_limit: 100 }, options());
    expect(describeTool.output.parse(exact.structuredContent).metadata_page?.items).toEqual(
      items.slice(0, 100),
    );
  });
  it('returns count-based wide SQL pages and an oversized singleton intact on both surfaces', async () => {
    const context = createMockContext({ tenantId });
    const staged = await dataframeService.withAdmission(context, (stage) =>
      stage({
        kind: 'timeseries',
        rows: Array.from({ length: 250 }, (_, index) => ({ ...original[0]!, row_id: index })),
        metadata: source,
        limit: 1,
        canvas_id: handle.canvas_id,
        signal: context.signal,
      }),
    );
    const sql = `SELECT row_id, repeat('x', 1000) AS wide FROM ${staged.staging!.table_name} ORDER BY row_id`;
    for (const [offset, count, next] of [
      [0, 100, 100],
      [100, 100, 200],
      [200, 50, null],
      [300, 0, null],
    ] as const) {
      const result = await runToolContract(
        queryTool,
        { canvas_id: handle.canvas_id, sql, limit: 100, offset },
        options(),
      );
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ returnedCount: count, next_offset: next });
      const parsed = queryTool.output.parse(result.structuredContent);
      expect(parsed.rows).toHaveLength(count);
      for (const [index, row] of parsed.rows.entries())
        expect(row).toEqual({ row_id: offset + index, wide: 'x'.repeat(1000) });
      expect(text(result.content)).toContain(text(await queryTool.format!(parsed)));
      if (count) expect(text(result.content)).toContain('x'.repeat(1000));
    }
    const result = await runToolContract(
      queryTool,
      { canvas_id: handle.canvas_id, sql: "SELECT repeat('x', 80001) AS huge" },
      options(),
    );
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ rows: [{ huge: 'x'.repeat(80001) }] });
    expect(text(result.content)).toContain('x'.repeat(80001));
  });
  it('preserves nested query JSON once while linking every nested URL', async () => {
    const result = await runToolContract(
      queryTool,
      {
        canvas_id: handle.canvas_id,
        sql: "SELECT {'url': 'https://example.org/proof?x=&copy;', 'proof': 7} AS nested, [{'url': 'https://example.org/array', 'proof': false}] AS urls",
      },
      options(),
    );
    expect(result.structuredContent).toMatchObject({
      rows: [
        {
          nested: { url: 'https://example.org/proof?x=&copy;', proof: 7 },
          urls: [{ url: 'https://example.org/array', proof: false }],
        },
      ],
    });
    parity(result);
  });
  it('proves the parity harness rejects a deliberately corrupted structured cell', async () => {
    const result = await runToolContract(
      queryTool,
      { canvas_id: handle.canvas_id, sql: 'SELECT 1 AS value' },
      options(),
    );
    parity(result);
    expect(() =>
      parity({
        ...result,
        structuredContent: {
          ...queryTool.output.parse(result.structuredContent),
          rows: [{ value: 2 }],
        },
      }),
    ).toThrow();
  });
  it('accepts a terminal delimiter and clamps limits on both wire surfaces', async () => {
    const result = await runToolContract(
      queryTool,
      { canvas_id: handle.canvas_id, sql: 'SELECT 1 AS value; -- terminal', limit: 501 },
      options(),
    );
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      rows: [{ value: 1 }],
      effectiveLimit: 500,
      limitNotice: expect.stringContaining('500'),
    });
    expect(text(result.content)).toContain('limitNotice');
    parity(result);
    const empty = await runToolContract(
      queryTool,
      { canvas_id: handle.canvas_id, sql: 'SELECT 1 AS value;', limit: 501, offset: 2 },
      options(),
    );
    expect(empty.structuredContent).toMatchObject({
      rows: [],
      effectiveLimit: 500,
      next_offset: null,
      limitNotice: expect.stringContaining('500'),
    });
    expect(text(empty.content)).toContain('effectiveLimit');
    expect(text(empty.content)).toContain('No rows remain at offset 2');
    expect(text(empty.content)).not.toContain('No rows match');
  });
  it('recovers every metadata collection for a 100-county panel on both wire surfaces without refetch', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-19T08:00:00Z'));
    const counties = referenceBundle.counties.filter((area) => area.state === 'TX').slice(0, 100);
    const date = '2026-10-13';
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.pathname.includes('/USStatistics/'))
        return new Response(JSON.stringify([{ mapDate: date, name: 'CONUS', dsci: 1 }]));
      const dsci = url.pathname.endsWith('/GetDSCI');
      return new Response(
        JSON.stringify(
          counties.flatMap((county, index) =>
            index % (dsci ? 5 : 3) === 0
              ? []
              : [
                  {
                    fips: county.id,
                    county: county.name,
                    state: 'TX',
                    mapDate: date,
                    none: 10,
                    d0: 90,
                    d1: 60,
                    d2: 30,
                    d3: 12,
                    d4: 3,
                    dsci: 195,
                  },
                ],
          ),
        ),
      );
    });
    vi.stubGlobal('fetch', fetcher);
    const input = {
      areas: counties.map((county) => ({ areaType: 'county' as const, aoi: county.id })),
      startDate: date,
      endDate: date,
    };
    const complete = await new DroughtService(new UsdmClient(fetcher)).produceTimeseries(
      input,
      new AbortController().signal,
    );
    const produced = await runToolContract(timeseriesTool, input, options());
    expect(produced.isError).not.toBe(true);
    const response = timeseriesTool.output.parse(produced.structuredContent);
    expect(response.staging).not.toBeNull();
    expect(response.metadata_pages).toBeDefined();
    const staged = response.staging!;
    expect(text(produced.content)).toContain('metadata_pages');
    expect(text(produced.content).length).toBeLessThanOrEqual(80_000);
    const calls = fetcher.mock.calls.length;
    const base = { canvas_id: staged.canvas_id, table_name: staged.table_name };
    const unpaged = await runToolContract(describeTool, base, options());
    parity(unpaged);
    for (const field of ['areas', 'summary', 'missingAreas', 'missingObservations'] as const) {
      const all: unknown[] = [];
      let offset: number | null = 0;
      while (offset !== null) {
        const result: Awaited<ReturnType<typeof runToolContract>> = await runToolContract(
          describeTool,
          { ...base, metadata_field: field, metadata_offset: offset, metadata_limit: 100 },
          options(),
        );
        parity(result);
        const page: ReturnType<typeof describeTool.output.parse>['metadata_page'] =
          describeTool.output.parse(result.structuredContent).metadata_page;
        if (!page) throw new Error('Missing retained metadata page');
        expect(page.total).toBe(complete.metadata[field].length);
        all.push(...page.items);
        offset = page.next_offset;
      }
      expect(all).toEqual(complete.metadata[field]);
      const past = await runToolContract(
        describeTool,
        { ...base, metadata_field: field, metadata_offset: 1000 },
        options(),
      );
      parity(past);
      expect(past.structuredContent).toMatchObject({
        metadata_page: { items: [], next_offset: null },
      });
    }
    expect(fetcher).toHaveBeenCalledTimes(calls);
    for (const args of [
      { canvas_id: base.canvas_id, metadata_field: 'areas' },
      { ...base, metadata_field: 'areas', metadata_offset: -1 },
      { ...base, metadata_field: 'areas', metadata_limit: 0 },
      { ...base, metadata_field: 'areas', metadata_limit: 1.5 },
    ] as const) {
      const invalid = await runToolContract(describeTool, args, options());
      expect(invalid.isError).toBe(true);
      expect(text(invalid.content)).toContain('metadata');
    }
  });
  it('round-trips exact source metadata, codes and values through both consumption paths', async () => {
    const described = await runToolContract(
      describeTool,
      { canvas_id: handle.canvas_id, table_name: handle.table_name },
      options(),
    );
    parity(described);
    expect(described.structuredContent).toMatchObject({
      tables: [
        {
          metadata: {
            ...source,
            bucketColumnMapping: { 'buckets.d0_d4': 'd0_d4', 'buckets.d2_d4': 'd2_d4' },
          },
        },
      ],
    });
    const queried = await runToolContract(
      queryTool,
      { canvas_id: handle.canvas_id, sql: `SELECT * FROM ${handle.table_name} ORDER BY row_id` },
      options(),
    );
    parity(queried);
    expect(queried.structuredContent).toMatchObject({
      rows: original.map(({ buckets, ...row }) => ({ ...row, ...buckets })),
      returnedCount: 2,
      countIsExact: true,
      tableMetadata: [{ name: handle.table_name, provenance: source.provenance }],
    });
    const removed = await runToolContract(
      dropTool,
      { canvas_id: handle.canvas_id, table_name: handle.table_name },
      options(),
    );
    parity(removed);
    expect(removed.structuredContent).toMatchObject({ dropped: true });
    const absent = await runToolContract(
      dropTool,
      { canvas_id: handle.canvas_id, table_name: handle.table_name },
      options(),
    );
    parity(absent);
    expect(absent.structuredContent).toMatchObject({ dropped: false });
  });
  it('renders empty-page guidance on both surfaces without claiming an exact total at a nonzero offset', async () => {
    const result = await runToolContract(
      queryTool,
      { canvas_id: handle.canvas_id, sql: `SELECT * FROM ${handle.table_name}`, offset: 3 },
      options(),
    );
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      rows: [],
      next_offset: null,
      countIsExact: false,
      notice: expect.stringContaining('drought_dataframe_describe'),
    });
    expect(text(result.content)).toContain('drought_dataframe_describe');
  });
  it.each([
    ['invalid_sql', 'SELECT ('],
    ['sql_execution_error', `SELECT CAST('not an integer' AS INTEGER)`],
    ['sql_read_only', 'SELECT * FROM information_schema.tables'],
  ])('returns declared %s recovery with the same reason on both surfaces', async (reason, sql) => {
    const result = await runToolContract(
      queryTool,
      { canvas_id: handle.canvas_id, sql },
      options(),
    );
    const recovery = queryTool.errors?.find((error) => error.reason === reason)?.recovery;
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { data: { reason, recovery: { hint: recovery } } },
    });
    expect(text(result.content)).toContain(reason);
    expect(text(result.content)).toContain(recovery);
    expect(JSON.stringify(result)).not.toMatch(
      /node_modules|\/private\/|Binder Error|Parser Error|\.cpp/,
    );
  });
  it('keeps describe, query and drop missing-token recovery appropriate to their operation', async () => {
    await canvas.drop(handle.canvas_id, createMockContext({ tenantId }));
    for (const tool of [describeTool, queryTool, dropTool]) {
      const result =
        tool.name === queryTool.name
          ? await runToolContract(
              queryTool,
              { canvas_id: handle.canvas_id, sql: 'SELECT 1' },
              options(),
            )
          : await runToolContract(
              tool === dropTool ? dropTool : describeTool,
              { canvas_id: handle.canvas_id, table_name: handle.table_name },
              options(),
            );
      const hint = tool.errors?.find((entry) => entry.reason === 'canvas_not_found')?.recovery;
      expect(result.structuredContent).toMatchObject({
        error: { data: { reason: 'canvas_not_found', recovery: { hint } } },
      });
      expect(text(result.content)).toContain(hint);
      if (tool.name === dropTool.name) expect(hint).not.toMatch(/re-run|re-stage/i);
    }
  });
  it('rejects missing/malformed tokens, SQL boundaries, limits and offsets before the engine', async () => {
    expect(queryTool.input.safeParse({ sql: 'SELECT 1' }).success).toBe(false);
    for (const input of [
      { canvas_id: 'x', sql: 'SELECT 1' },
      { canvas_id: handle.canvas_id, sql: '' },
      { canvas_id: handle.canvas_id, sql: 'x'.repeat(16385) },
      { canvas_id: handle.canvas_id, sql: 'SELECT 1', limit: 0 },
      { canvas_id: handle.canvas_id, sql: 'SELECT 1', limit: 1.5 },
      { canvas_id: handle.canvas_id, sql: 'SELECT 1', offset: -1 },
      { canvas_id: handle.canvas_id, sql: 'SELECT 1', offset: 250001 },
    ]) {
      const result = await runToolContract(queryTool, input, options());
      expect(result.structuredContent).toMatchObject({
        error: { code: JsonRpcErrorCode.InvalidParams },
      });
      expect(result.isError).toBe(true);
    }
    expect(describeTool.input.safeParse({}).success).toBe(false);
  });
  it('uses disabledTool with the default opt-out and allows explicitly enabled removal', async () => {
    vi.stubEnv('DROUGHT_DATAFRAME_DROP_ENABLED', undefined);
    expect(getCanvasConfig().dropEnabled).toBe(false);
    const disabled = disabledTool(dropTool, {
      reason: 'Disposable table removal is disabled.',
      hint: 'Set DROUGHT_DATAFRAME_DROP_ENABLED=true to enable.',
    });
    expect(disabled).toMatchObject({
      name: dropTool.name,
      __mcpDisabled: { hint: 'Set DROUGHT_DATAFRAME_DROP_ENABLED=true to enable.' },
    });
    expect(
      (await runToolContract(describeTool, { canvas_id: handle.canvas_id }, options()))
        .structuredContent,
    ).toMatchObject({ tables: [{ name: handle.table_name }] });
    vi.stubEnv('DROUGHT_DATAFRAME_DROP_ENABLED', 'true');
    expect(getCanvasConfig().dropEnabled).toBe(true);
    expect(
      (
        await runToolContract(
          dropTool,
          { canvas_id: handle.canvas_id, table_name: handle.table_name },
          options(),
        )
      ).structuredContent,
    ).toMatchObject({ dropped: true });
    vi.stubEnv('DROUGHT_DATAFRAME_DROP_ENABLED', 'false');
    expect(getCanvasConfig().dropEnabled).toBe(false);
  });
  it('returns actionable provider-none errors on both consumption paths', async () => {
    setCanvas(undefined);
    for (const tool of [describeTool, queryTool, dropTool]) {
      const result =
        tool.name === queryTool.name
          ? await runToolContract(
              queryTool,
              { canvas_id: handle.canvas_id, sql: 'SELECT 1' },
              options(),
            )
          : await runToolContract(
              tool === dropTool ? dropTool : describeTool,
              { canvas_id: handle.canvas_id, table_name: handle.table_name },
              options(),
            );
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.ConfigurationError,
          data: { reason: 'canvas_unavailable' },
        },
      });
      expect(text(result.content)).toContain('CANVAS_PROVIDER_TYPE=duckdb');
      expect(text(result.content)).toContain('MCPB');
    }
  });
  it('preserves complete query provenance beyond preview thresholds on both surfaces', async () => {
    const context = createMockContext({ tenantId });
    for (let index = 0; index < 6; index++)
      await dataframeService.withAdmission(context, (stage) =>
        stage({
          kind: 'timeseries',
          rows: original,
          metadata: { provenance: { credit: 'x'.repeat(7_000) } },
          limit: 1,
          canvas_id: handle.canvas_id,
          signal: context.signal,
        }),
      );
    const result = await runToolContract(
      queryTool,
      { canvas_id: handle.canvas_id, sql: 'SELECT 1' },
      options(),
    );
    expect(result.isError).not.toBe(true);
    expect(queryTool.output.parse(result.structuredContent).tableMetadata).toHaveLength(7);
    parity(result);
  });
});

describe('analytical default configuration', () => {
  it('seeds only unset/blank settings and preserves explicit none and operator limits', () => {
    for (const key of [
      'CANVAS_PROVIDER_TYPE',
      'CANVAS_DEFAULT_MEMORY_LIMIT_MB',
      'CANVAS_MAX_CANVASES_PER_TENANT',
      'CANVAS_DEFAULT_ROW_LIMIT',
    ])
      vi.stubEnv(key, undefined);
    seedCanvasDefaults();
    expect(process.env.CANVAS_PROVIDER_TYPE).toBe('duckdb');
    expect(process.env.CANVAS_DEFAULT_MEMORY_LIMIT_MB).toBe('128');
    expect(process.env.CANVAS_MAX_CANVASES_PER_TENANT).toBe('4');
    vi.stubEnv('CANVAS_PROVIDER_TYPE', 'none');
    vi.stubEnv('CANVAS_DEFAULT_MEMORY_LIMIT_MB', '256');
    vi.stubEnv('CANVAS_MAX_CANVASES_PER_TENANT', '2');
    vi.stubEnv('CANVAS_DEFAULT_ROW_LIMIT', '1');
    seedCanvasDefaults();
    expect(process.env.CANVAS_PROVIDER_TYPE).toBe('none');
    expect(process.env.CANVAS_DEFAULT_MEMORY_LIMIT_MB).toBe('256');
    expect(process.env.CANVAS_MAX_CANVASES_PER_TENANT).toBe('2');
    vi.stubEnv('CANVAS_PROVIDER_TYPE', ' ');
    vi.stubEnv('CANVAS_DEFAULT_ROW_LIMIT', '501');
    seedCanvasDefaults();
    expect(process.env.CANVAS_PROVIDER_TYPE).toBe('duckdb');
  });
  it.each(['0', '500', '501.5', 'not-a-number'])(
    'refuses an enabled provider row limit without a sentinel: %s',
    (limit) => {
      vi.stubEnv('CANVAS_PROVIDER_TYPE', 'duckdb');
      vi.stubEnv('CANVAS_DEFAULT_ROW_LIMIT', limit);
      expect(() => seedCanvasDefaults()).toThrow('CANVAS_DEFAULT_ROW_LIMIT');
    },
  );
});
