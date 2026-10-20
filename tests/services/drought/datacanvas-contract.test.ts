/**
 * @fileoverview Dual-surface dataframe contracts and operator defaults using real DuckDB.
 * @module tests/services/drought/datacanvas-contract
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { disabledTool } from '@cyanheads/mcp-ts-core';
import { CanvasRegistry, DataCanvas, DuckdbProvider } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getCanvasConfig, seedCanvasDefaults } from '@/config/canvas-config.js';
import { droughtDataframeDescribeTool as describeTool } from '@/mcp-server/tools/definitions/drought-dataframe-describe.tool.js';
import { droughtDataframeDropTool as dropTool } from '@/mcp-server/tools/definitions/drought-dataframe-drop.tool.js';
import { droughtDataframeQueryTool as queryTool } from '@/mcp-server/tools/definitions/drought-dataframe-query.tool.js';
import { setCanvas } from '@/services/canvas-accessor.js';
import { dataframeService } from '@/services/drought/dataframe-service.js';
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
  const decoded = [...rendered.matchAll(/(`{3,})\n([^\n]*)\n\1/g)].map(
    (match) => JSON.parse(match[2] ?? 'null') as unknown,
  );
  const values = scalars(result.structuredContent).filter(
    (value) => !(typeof value === 'string' && /^https:\/\/[^\s<>]+$/.test(value)),
  );
  expect(decoded).toEqual(values);
  for (const value of scalars(result.structuredContent))
    if (typeof value === 'string' && value.startsWith('https://'))
      expect(rendered).toContain(`](<${value}>)`);
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
});

describe('dataframe public contracts', () => {
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
    ['query_row_too_large', "SELECT repeat('x', 40001) AS huge"],
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
      { canvas_id: handle.canvas_id, sql: 'SELECT 1', limit: 501 },
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
  it('declares metadata overflow recovery on both surfaces without advising smaller projected cells', async () => {
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
    const contract = queryTool.errors?.find(
      (entry) => String(entry.reason) === 'dataset_too_large',
    );
    expect(contract).toBeDefined();
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.ValidationError,
        data: { reason: 'dataset_too_large', recovery: { hint: contract?.recovery } },
      },
    });
    expect(text(result.content)).toContain(contract?.recovery);
    expect(contract?.recovery).toMatch(/new canvas|omit canvas_id/i);
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
