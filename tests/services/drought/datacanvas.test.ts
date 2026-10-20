/**
 * @fileoverview Admission, lifecycle and analytical queries against real in-memory DuckDB.
 * @module tests/services/drought/datacanvas
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CanvasRegistry, DataCanvas, DuckdbProvider } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setCanvas } from '@/services/canvas-accessor.js';
import { DataframeService } from '@/services/drought/dataframe-service.js';
import { DroughtService, type StageRequest } from '@/services/drought/drought-service.js';
import { UsdmClient } from '@/services/drought/usdm-client.js';
import type { ComparisonRow } from '@/services/drought/workflow-schema.js';

let root: string;
let canvas: DataCanvas;
let registry: CanvasRegistry;
let service: DataframeService;
let clock: number;
const ctx = (tenantId = 'canvas-test') => createMockContext({ tenantId });
const rows = (count: number): ComparisonRow[] =>
  Array.from({ length: count }, (_, index) => ({
    row_id: index + 1,
    areaType: 'county',
    id: '01001',
    name: 'Autauga\r\nCounty `quoted`',
    state: 'AL',
    targetValue: index === 0 ? 0 : 0.125,
    baselineValue: null,
    change: null,
    rankedValue: 0.125,
    rank: index + 1,
  }));
const metadata = {
  provenance: {
    sourceUrls: [
      'https://usdmdataservices.unl.edu/api/CountyStatistics/GetDroughtSeverityStatisticsByAreaPercent',
    ],
    credit: 'source\r\ncredit `exact`',
    retrievedAt: '2024-03-05T12:00:00Z',
  },
  metric: 'd2_d4',
  nested: { missing: null, values: [false, '01', 0.125] },
};
async function stage(count = 3, context = ctx(), extra: Partial<StageRequest> = {}) {
  return service.withAdmission(context, (produce) =>
    produce({
      kind: 'comparison',
      rows: rows(count),
      metadata,
      limit: 1,
      signal: context.signal,
      ...extra,
    }),
  );
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function expensiveSql(table: string): string {
  const aliases = Array.from({ length: 22 }, (_, index) => `t${index}`);
  return `SELECT SUM(sin(${aliases.map((alias) => `${alias}.row_id`).join(' + ')})) FROM ${aliases.map((alias) => `${table} ${alias}`).join(' CROSS JOIN ')}`;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'drought-canvas-test-'));
  clock = Date.now();
  const provider = new DuckdbProvider({
    defaultRowLimit: 501,
    exportRootPath: root,
    tempRootPath: root,
    memoryLimitMb: 128,
    schemaSniffRows: 100,
  });
  registry = new CanvasRegistry(
    provider,
    {
      ttlMs: 86_400_000,
      absoluteCapMs: 604_800_000,
      maxCanvasesPerTenant: 10,
      sweeperIntervalMs: 0,
    },
    () => clock,
  );
  canvas = new DataCanvas(provider, registry);
  setCanvas(canvas);
  service = new DataframeService();
});
afterEach(async () => {
  setCanvas(undefined);
  await canvas.shutdown(ctx());
  await rm(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('atomic analytical admission and retention', () => {
  it('automatically retains and pages overflowing metadata even for zero observations', async () => {
    const areas = Array.from({ length: 100 }, (_, index) => ({
      areaType: 'county',
      id: String(index).padStart(5, '0'),
      name: 'County '.repeat(30),
    }));
    const full = {
      areas,
      summary: areas.map((area) => ({ area, observationCount: 0 })),
      missingAreas: areas,
      missingObservations: areas.map((area) => ({
        area,
        component: 'metric',
        count: 1,
        mapDateRuns: [{ startMapDate: '2024-03-05', endMapDate: '2024-03-05', stepDays: 7 }],
      })),
    };
    const result = await stage(0, ctx(), { kind: 'timeseries', metadata: full });
    expect(result.staging?.row_count).toBe(0);
    for (const field of ['areas', 'summary', 'missingAreas', 'missingObservations'] as const) {
      const items: unknown[] = [];
      let offset: number | null = 0;
      while (offset !== null) {
        const description = await service.describe(
          {
            canvas_id: result.staging!.canvas_id,
            table_name: result.staging!.table_name,
            metadata_field: field,
            metadata_offset: offset,
            metadata_limit: 7,
          },
          ctx(),
        );
        const page = description.metadata_page!;
        items.push(...page.items);
        offset = page.next_offset;
      }
      expect(items).toEqual(full[field]);
    }
  });
  it('reuses the most recent owned canvas at the process cap without evicting live tables', async () => {
    const handles = [];
    for (let index = 0; index < 4; index++) handles.push((await stage()).staging!);
    const fifth = (await stage()).staging!;
    expect(fifth.canvas_id).toBe(handles[3]!.canvas_id);
    expect(
      (await service.describe({ canvas_id: fifth.canvas_id }, ctx())).tables
        .map((table) => table.name)
        .sort(),
    ).toEqual([handles[3]!.table_name, fifth.table_name].sort());
    expect(canvas.countForTenant(ctx())).toBe(4);
  });
  it('reclaims abandoned service-owned empty engines for a fresh omitted-token stage', async () => {
    for (let index = 0; index < 4; index++) await stage();
    clock += 1_800_001;
    await registry.sweep();
    await service.withAdmission(ctx('unrelated'), async () => null);
    await expect(stage()).resolves.toHaveProperty('staging.canvas_id');
    expect(canvas.countForTenant(ctx())).toBe(1);
  });
  it('preserves caller-owned and explicitly reused empty canvases while reclaiming other tenants', async () => {
    const callerOwned = await canvas.acquire(undefined, ctx());
    await stage(3, ctx(), { canvas_id: callerOwned.canvasId });
    const reused = (await stage()).staging!;
    await stage(3, ctx(), { canvas_id: reused.canvas_id });
    await stage(3, ctx('abandoned'));
    await stage(3, ctx('abandoned'));
    clock += 1_800_001;
    await registry.sweep();
    await expect(stage(3, ctx('fresh'))).resolves.toHaveProperty('staging.canvas_id');
    expect(canvas.countForTenant(ctx('abandoned'))).toBe(0);
    expect((await service.describe({ canvas_id: callerOwned.canvasId }, ctx())).tables).toEqual([]);
    expect((await service.describe({ canvas_id: reused.canvas_id }, ctx())).tables).toEqual([]);
  });
  it('lets abandoned reused empty canvases expire despite repeated unrelated admissions', async () => {
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    const tokens: string[] = [];
    for (let index = 0; index < 4; index++) {
      const handle = (await stage()).staging!;
      tokens.push(handle.canvas_id);
      await stage(3, ctx(), { canvas_id: handle.canvas_id });
    }
    clock += 1_800_001;
    await registry.sweep();
    await service.withAdmission(ctx('unrelated'), async () => null);
    for (let hour = 0; hour < 25; hour++) {
      clock += 3_600_000;
      await service.withAdmission(ctx('unrelated'), async () => null);
    }
    await expect(service.describe({ canvas_id: tokens[0]! }, ctx())).rejects.toMatchObject({
      data: { reason: 'canvas_not_found' },
    });
    await registry.sweep();
    await expect(stage()).resolves.toHaveProperty('staging.canvas_id');
    expect(canvas.countForTenant(ctx())).toBe(1);
  });
  it('does not reclaim empty canvases while their tenant has another admitted producer', async () => {
    for (let index = 0; index < 4; index++) await stage();
    clock += 1_800_001;
    await registry.sweep();
    const entered = deferred();
    const release = deferred();
    const producer = service.withAdmission(ctx(), async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    try {
      await expect(stage(3, ctx('another'))).rejects.toMatchObject({
        data: { reason: 'staging_capacity_exhausted' },
      });
      expect(canvas.countForTenant(ctx())).toBe(4);
    } finally {
      release.resolve();
      await producer;
    }
    await expect(stage(3, ctx('another'))).resolves.toHaveProperty('staging.canvas_id');
  });
  it('preserves an empty engine until an in-flight analytical query settles', async () => {
    const first = (await stage()).staging!;
    for (let index = 1; index < 4; index++) await stage();
    clock += 1_800_001;
    await registry.sweep();
    const entered = deferred();
    const release = deferred();
    const provider = canvas.getProvider();
    const original = provider.query.bind(provider);
    vi.spyOn(provider, 'query').mockImplementation(async (...args) => {
      entered.resolve();
      await release.promise;
      return original(...args);
    });
    const query = service.query(
      { canvas_id: first.canvas_id, sql: 'SELECT 1 AS value', limit: 1, offset: 0 },
      ctx(),
    );
    await entered.promise;
    try {
      await expect(stage(3, ctx('fresh'))).rejects.toMatchObject({
        data: { reason: 'staging_capacity_exhausted' },
      });
      expect(canvas.countForTenant(ctx())).toBe(4);
    } finally {
      release.resolve();
      expect((await query).rows).toEqual([{ value: 1 }]);
    }
    await expect(stage(3, ctx('fresh'))).resolves.toHaveProperty('staging.canvas_id');
  });
  it('rejects the third workflow before its fetch callback and releases empty/inline/failure slots', async () => {
    const entered = deferred();
    const release = deferred();
    let started = 0;
    const work = () =>
      service.withAdmission(ctx(), async () => {
        started++;
        if (started === 2) entered.resolve();
        await release.promise;
      });
    const first = work();
    const second = work();
    await entered.promise;
    const fetch = vi.fn();
    await expect(service.withAdmission(ctx('another-tenant'), fetch)).rejects.toMatchObject({
      data: { reason: 'staging_busy' },
    });
    expect(fetch).not.toHaveBeenCalled();
    release.resolve();
    await Promise.all([first, second]);
    for (const count of [0, 1])
      expect(await stage(count)).toMatchObject({ rows: rows(count), staging: null });
    await expect(
      service.withAdmission(ctx(), async () => {
        throw new Error('upstream fixture failed');
      }),
    ).rejects.toThrow('upstream fixture failed');
    expect(canvas.countForTenant(ctx())).toBe(0);
    await expect(stage()).resolves.toHaveProperty('staging.canvas_id');
  });
  it('serializes concurrent omitted-token calls and caps all tenants at four canvases', async () => {
    const first = await Promise.all([stage(), stage()]);
    expect(new Set(first.map((result) => result.staging?.canvas_id)).size).toBe(2);
    await Promise.all([stage(3, ctx('second')), stage(3, ctx('third'))]);
    await expect(stage(3, ctx('fourth'))).rejects.toMatchObject({
      data: { reason: 'staging_capacity_exhausted' },
    });
    const token = first[0]?.staging?.canvas_id ?? '';
    await expect(stage(3, ctx(), { canvas_id: token })).resolves.toHaveProperty(
      'staging.canvas_id',
      token,
    );
    await canvas.drop(token, ctx());
    await expect(stage(3, ctx('fourth'))).resolves.toHaveProperty('staging.canvas_id');
  });
  it('caps tables per canvas and releases table reservations on drop', async () => {
    const first = (await stage()).staging!;
    for (let index = 1; index < 8; index++) await stage(3, ctx(), { canvas_id: first.canvas_id });
    await expect(stage(3, ctx(), { canvas_id: first.canvas_id })).rejects.toMatchObject({
      data: { reason: 'staging_capacity_exhausted' },
    });
    expect((await service.describe({ canvas_id: first.canvas_id }, ctx())).tables).toHaveLength(8);
    expect(
      await service.drop({ canvas_id: first.canvas_id, table_name: first.table_name }, ctx()),
    ).toHaveProperty('dropped', true);
    await expect(stage(3, ctx(), { canvas_id: first.canvas_id })).resolves.toHaveProperty(
      'staging',
    );
  });
  it('reconciles expired canvases before admitting new omitted-token staging', async () => {
    const first = (await stage()).staging!;
    for (let index = 1; index < 4; index++) await stage();
    clock += 604_800_001;
    await expect(stage()).resolves.toHaveProperty('staging.canvas_id');
    await expect(service.describe({ canvas_id: first.canvas_id }, ctx())).rejects.toMatchObject({
      data: { reason: 'canvas_not_found' },
    });
  });
  it('reconciles table TTL expiry while preserving its live canvas', async () => {
    const first = (await stage()).staging!;
    clock += 1_800_001;
    await registry.sweep();
    expect((await service.describe({ canvas_id: first.canvas_id }, ctx())).tables).toEqual([]);
    await expect(stage(3, ctx(), { canvas_id: first.canvas_id })).resolves.toHaveProperty(
      'staging.canvas_id',
      first.canvas_id,
    );
  });
  it('does not allocate on oversized metadata, oversized rows or pre-cancelled work', async () => {
    await expect(stage(3, ctx(), { metadata: { huge: 'x'.repeat(40_001) } })).rejects.toMatchObject(
      { data: { reason: 'dataset_too_large', component: 'table_metadata' } },
    );
    const oversized = rows(1);
    oversized[0]!.name = 'x'.repeat(64 * 1024 * 1024);
    await expect(stage(1, ctx(), { rows: oversized })).rejects.toMatchObject({
      data: { reason: 'dataset_too_large', component: 'table_rows' },
    });
    const controller = new AbortController();
    controller.abort();
    const fetch = vi.fn();
    await expect(
      service.withAdmission(createMockContext({ signal: controller.signal }), fetch),
    ).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
    expect(canvas.countForTenant(ctx())).toBe(0);
  });
  it('reserves exact retained rows per tenant and releases them after explicit removal', async () => {
    const retained = (await stage(200_000)).staging!;
    await expect(stage(50_001, ctx(), { canvas_id: retained.canvas_id })).rejects.toMatchObject({
      data: { reason: 'staging_capacity_exhausted' },
    });
    await expect(stage(3, ctx('independent-tenant'))).resolves.toHaveProperty('staging.canvas_id');
    await service.drop({ canvas_id: retained.canvas_id, table_name: retained.table_name }, ctx());
    await expect(stage(50_001, ctx(), { canvas_id: retained.canvas_id })).resolves.toHaveProperty(
      'staging.row_count',
      50_001,
    );
  }, 20_000);
  it('drops a newly minted empty canvas when cancellation arrives during row preparation', async () => {
    const tenantId = 'cancel-new';
    const controller = new AbortController();
    const context = createMockContext({ tenantId, signal: controller.signal });
    const source = rows(3);
    const value = source[0]!.name;
    Object.defineProperty(source[0], 'name', {
      enumerable: true,
      get() {
        if (canvas.countForTenant(context)) controller.abort();
        return value;
      },
    });
    await expect(stage(3, context, { rows: source })).rejects.toThrow();
    expect(canvas.countForTenant(createMockContext({ tenantId }))).toBe(0);
    await expect(stage(3, createMockContext({ tenantId }))).resolves.toHaveProperty(
      'staging.canvas_id',
    );
  });
  it('cleans partial registration without deleting a reused canvas or existing table', async () => {
    const first = (await stage()).staging!;
    const broken = rows(2);
    Object.assign(broken[1]!, { row_id: 'not-an-integer' });
    await expect(stage(2, ctx(), { rows: broken, canvas_id: first.canvas_id })).rejects.toThrow();
    expect(
      (await service.describe({ canvas_id: first.canvas_id }, ctx())).tables.map(
        (table) => table.name,
      ),
    ).toEqual([first.table_name]);
    await expect(stage(2, ctx('new-failure'), { rows: broken })).rejects.toThrow();
    expect(canvas.countForTenant(ctx('new-failure'))).toBe(0);
  });
  it('includes StageHandle in the forty-thousand-character non-row metadata budget', async () => {
    const largeMetadata = { note: 'x'.repeat(39_500) };
    expect(JSON.stringify(largeMetadata).length).toBeLessThan(40_000);
    await expect(stage(3, ctx(), { metadata: largeMetadata })).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'dataset_too_large' },
    });
    expect(canvas.countForTenant(ctx())).toBe(0);
    const retained = (await stage()).staging!;
    await expect(
      stage(3, ctx(), { metadata: largeMetadata, canvas_id: retained.canvas_id }),
    ).rejects.toMatchObject({ data: { reason: 'dataset_too_large' } });
    expect(
      (await service.describe({ canvas_id: retained.canvas_id }, ctx())).tables.map(
        (table) => table.name,
      ),
    ).toEqual([retained.table_name]);
  });
});

describe('real DuckDB staged data and bounded SQL', () => {
  it('stages every domain comparison row through real producer logic with only HTTP faked', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = new URL(String(input));
      return Response.json(
        url.pathname === '/api/USStatistics/GetDSCI'
          ? [{ mapDate: '2024-03-05', name: 'CONUS', dsci: 1 }]
          : ['Alabama', 'Alaska', 'Arizona'].map((name, index) => ({
              mapDate: '2024-03-05',
              name,
              dsci: 50 + index,
            })),
      );
    });
    const producer = new DroughtService(
      new UsdmClient(fetcher),
      undefined,
      () => new Date('2024-03-12T08:00:00Z'),
    );
    const context = ctx();
    const result = await service.withAdmission(context, (stage) =>
      producer.compare({ scope: 'states', limit: 1 }, context.signal, stage),
    );
    expect(result.rows).toHaveLength(1);
    expect(result.comparedCount).toBe(3);
    const handle = result.staging!;
    expect(handle.row_count).toBe(3);
    const queried = await service.query(
      {
        canvas_id: handle.canvas_id,
        sql: `SELECT id, row_id, targetValue FROM ${handle.table_name} ORDER BY row_id`,
        limit: 500,
        offset: 0,
      },
      context,
    );
    expect(queried.rows).toEqual([
      { id: '04', row_id: 1, targetValue: 52 },
      { id: '02', row_id: 2, targetValue: 51 },
      { id: '01', row_id: 3, targetValue: 50 },
    ]);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('retains exact codes, fractional doubles, all metadata and stable full-table pages', async () => {
    const original = rows(1003);
    const handle = (await stage(original.length, ctx(), { rows: original })).staging!;
    expect(handle).toMatchObject({
      row_count: 1003,
      describe_tool: 'drought_dataframe_describe',
      query_tool: 'drought_dataframe_query',
      columns: expect.arrayContaining([
        { name: 'id', type: 'VARCHAR', unit: null },
        { name: 'targetValue', type: 'DOUBLE', unit: null },
      ]),
    });
    const description = await service.describe(
      { canvas_id: handle.canvas_id, table_name: handle.table_name },
      ctx(),
    );
    expect(description.tables[0]).toMatchObject({
      metadata,
      rowCount: 1003,
      expiresAt: handle.expires_at,
    });
    expect(
      (await service.describe({ canvas_id: handle.canvas_id }, ctx())).tables[0]?.metadata,
    ).toEqual({});
    const collected: Record<string, unknown>[] = [];
    let offset = 0;
    do {
      const page = await service.query(
        {
          canvas_id: handle.canvas_id,
          sql: `SELECT * FROM ${handle.table_name} ORDER BY row_id`,
          limit: 500,
          offset,
        },
        ctx(),
      );
      collected.push(...page.rows);
      expect(page.countIsExact).toBe(false);
      if (page.next_offset === null) break;
      expect(page.next_offset).toBeGreaterThan(offset);
      offset = page.next_offset;
    } while (offset < 2000);
    expect(collected).toEqual(original);
    const count = await service.query(
      {
        canvas_id: handle.canvas_id,
        sql: `SELECT COUNT(*) AS total FROM ${handle.table_name}`,
        limit: 500,
        offset: 0,
      },
      ctx(),
    );
    expect(count.rows).toEqual([{ total: '1003' }]);
    expect(count.countIsExact).toBe(true);
    const past = await service.query(
      {
        canvas_id: handle.canvas_id,
        sql: `SELECT row_id FROM ${handle.table_name} ORDER BY row_id`,
        limit: 500,
        offset: 1004,
      },
      ctx(),
    );
    expect(past).toMatchObject({
      rows: [],
      returnedCount: 0,
      has_more: false,
      next_offset: null,
      countIsExact: false,
    });
  });
  it('uses the 501st sentinel rather than claiming a capped result is exact', async () => {
    const handle = (await stage(501)).staging!;
    const first = await service.query(
      {
        canvas_id: handle.canvas_id,
        sql: `SELECT row_id FROM ${handle.table_name} ORDER BY row_id`,
        limit: 500,
        offset: 0,
      },
      ctx(),
    );
    expect(first).toMatchObject({
      returnedCount: 500,
      has_more: true,
      next_offset: 500,
      countIsExact: false,
    });
    const last = await service.query(
      {
        canvas_id: handle.canvas_id,
        sql: `SELECT row_id FROM ${handle.table_name} ORDER BY row_id`,
        limit: 500,
        offset: 500,
      },
      ctx(),
    );
    expect(last).toMatchObject({ rows: [{ row_id: 501 }], has_more: false, next_offset: null });
  });
  it('isolates tokens by tenant, returns no implicit token listing and drops only the named table', async () => {
    const handle = (await stage()).staging!;
    await expect(
      service.describe({ canvas_id: handle.canvas_id }, ctx('outsider')),
    ).rejects.toMatchObject({ data: { reason: 'canvas_not_found' } });
    await expect(
      service.query(
        { canvas_id: handle.canvas_id, sql: 'SELECT 1', limit: 1, offset: 0 },
        ctx('outsider'),
      ),
    ).rejects.toMatchObject({ data: { reason: 'canvas_not_found' } });
    await expect(
      service.drop({ canvas_id: handle.canvas_id, table_name: handle.table_name }, ctx('outsider')),
    ).rejects.toMatchObject({ data: { reason: 'canvas_not_found' } });
    expect((await service.describe({ canvas_id: handle.canvas_id }, ctx())).canvas_id).toBe(
      handle.canvas_id,
    );
    expect(
      await service.drop({ canvas_id: handle.canvas_id, table_name: handle.table_name }, ctx()),
    ).toHaveProperty('dropped', true);
    expect(
      await service.drop({ canvas_id: handle.canvas_id, table_name: handle.table_name }, ctx()),
    ).toHaveProperty('dropped', false);
    expect(canvas.countForTenant(ctx())).toBe(1);
  });
  it.each([
    'DELETE FROM {table}',
    'CREATE TABLE stolen AS SELECT 1',
    "SELECT * FROM read_csv('/private/should-not-be-opened.csv')",
    "SELECT * FROM (SELECT * FROM read_json_auto('https://invalid.example/forbidden'))",
    'SELECT * FROM information_schema.tables',
    'SELECT * FROM duckdb_tables()',
    'SELECT 1); DROP TABLE {table}; SELECT 2 --',
    'SELECT 1; SELECT 2',
  ])('refuses unsafe SQL without public filesystem/engine diagnostics: %s', async (sql) => {
    const handle = (await stage()).staging!;
    const error: unknown = await service
      .query(
        {
          canvas_id: handle.canvas_id,
          sql: sql.replaceAll('{table}', handle.table_name),
          limit: 100,
          offset: 0,
        },
        ctx(),
      )
      .catch((value: unknown) => value);
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: expect.stringMatching(/sql_read_only|invalid_sql/) },
    });
    const publicError = JSON.stringify(error);
    expect(publicError).not.toMatch(
      /\/private\/|should-not-be-opened|node_modules|Binder Error|Parser Error|\.cpp|stack/,
    );
    expect((await service.describe({ canvas_id: handle.canvas_id }, ctx())).tables).toHaveLength(1);
  });
  it('classifies malformed and failing casts safely and rejects a huge projected cell intact', async () => {
    const handle = (await stage()).staging!;
    const query = (sql: string) =>
      service.query({ canvas_id: handle.canvas_id, sql, limit: 100, offset: 0 }, ctx());
    await expect(query('SELECT (')).rejects.toMatchObject({ data: { reason: 'invalid_sql' } });
    await expect(
      query(`SELECT CAST(name AS INTEGER) FROM ${handle.table_name}`),
    ).rejects.toMatchObject({ data: { reason: 'sql_execution_error' } });
    await expect(query("SELECT repeat('x', 40001) AS huge")).rejects.toMatchObject({
      data: { reason: 'query_row_too_large' },
    });
    expect(
      (await query(`SELECT TRY_CAST(name AS INTEGER) AS n FROM ${handle.table_name}`)).rows,
    ).toEqual([{ n: null }, { n: null }, { n: null }]);
  });
  it('bounds aggregate query tableMetadata to forty thousand characters independently of the full envelope', async () => {
    const provenance = { credit: 'x'.repeat(7_000) };
    const first = (await stage(3, ctx(), { metadata: { provenance } })).staging!;
    for (let index = 1; index < 6; index++)
      await stage(3, ctx(), { metadata: { provenance }, canvas_id: first.canvas_id });
    const expectedMetadata = (
      await service.describe({ canvas_id: first.canvas_id }, ctx())
    ).tables.map((table) => ({ name: table.name, provenance }));
    expect(JSON.stringify(expectedMetadata).length).toBeGreaterThan(40_000);
    expect(JSON.stringify(expectedMetadata).length).toBeLessThan(80_000);
    await expect(
      service.query(
        { canvas_id: first.canvas_id, sql: 'SELECT 1 AS value', limit: 1, offset: 0 },
        ctx(),
      ),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'dataset_too_large' },
    });
  });
  it('cancels an actual query and permits a subsequent query on the same canvas', async () => {
    const handle = (await stage()).staging!;
    const controller = new AbortController();
    const pending = service.query(
      { canvas_id: handle.canvas_id, sql: expensiveSql(handle.table_name), limit: 1, offset: 0 },
      createMockContext({ tenantId: 'canvas-test', signal: controller.signal }),
    );
    controller.abort();
    await expect(pending).rejects.toThrow();
    await expect(
      service.query(
        { canvas_id: handle.canvas_id, sql: 'SELECT 1 AS n', limit: 1, offset: 0 },
        ctx(),
      ),
    ).resolves.toMatchObject({ rows: [{ n: 1 }] });
  });
  it('bounds simultaneous queries across tenants and releases both slots on cancellation', async () => {
    const handle = (await stage()).staging!;
    const controller = new AbortController();
    const input = {
      canvas_id: handle.canvas_id,
      sql: expensiveSql(handle.table_name),
      limit: 1,
      offset: 0,
    };
    const context = createMockContext({ tenantId: 'canvas-test', signal: controller.signal });
    const pending = [service.query(input, context), service.query(input, context)];
    await expect(service.query(input, ctx('other'))).rejects.toMatchObject({
      data: { reason: 'staging_busy' },
    });
    controller.abort();
    expect(
      (await Promise.allSettled(pending)).every((result) => result.status === 'rejected'),
    ).toBe(true);
    await expect(service.query({ ...input, sql: 'SELECT 1 AS n' }, ctx())).resolves.toMatchObject({
      rows: [{ n: 1 }],
    });
  });
  it('interrupts actual engine work at its five-second deadline without leaking diagnostics', async () => {
    const handle = (await stage()).staging!;
    const error: unknown = await service
      .query(
        { canvas_id: handle.canvas_id, sql: expensiveSql(handle.table_name), limit: 1, offset: 0 },
        ctx(),
      )
      .catch((value: unknown) => value);
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.Timeout,
      message: 'Analytical operation timed out.',
    });
    expect(JSON.stringify(error)).not.toMatch(/node_modules|\/private\/|\.cpp|stack/);
    await expect(
      service.query(
        { canvas_id: handle.canvas_id, sql: 'SELECT 2 AS n', limit: 1, offset: 0 },
        ctx(),
      ),
    ).resolves.toMatchObject({ rows: [{ n: 2 }] });
  }, 10_000);
  it('refuses disabled analytical staging actionably while inline output still works', async () => {
    setCanvas(undefined);
    expect(await stage(1)).toMatchObject({ staging: null });
    await expect(stage()).rejects.toMatchObject({
      code: JsonRpcErrorCode.ConfigurationError,
      message: expect.stringContaining('CANVAS_PROVIDER_TYPE=duckdb'),
      data: { reason: 'canvas_unavailable' },
    });
  });
});
