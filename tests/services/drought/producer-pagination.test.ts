/**
 * @fileoverview Public producer paging against fixed USDM HTTP responses.
 * @module tests/services/drought/producer-pagination
 */
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CanvasRegistry, DataCanvas, DuckdbProvider } from '@cyanheads/mcp-ts-core/canvas';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addDays } from '@/services/drought/dates.js';

const dates = ['2024-02-20', '2024-02-27', '2024-03-05'] as const;
const base = { mapDate: '2024-03-05', dsci: 195, none: 10, d0: 90, d1: 60, d2: 30, d3: 12, d4: 3 };
const compareInput = { scope: 'states' } as const;
const seriesInput = {
  areas: [{ areaType: 'state' as const, aoi: 'AL' }],
  startDate: dates[0],
  endDate: dates[2],
};
const text = (result: Awaited<ReturnType<typeof runToolContract>>) =>
  result.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n');
const tenant = (tenantId: string) => ({ context: { tenantId } });
async function fixture(mappedDates: readonly string[] = dates) {
  const fetcher = vi.fn(async (input: string) => {
    const { pathname, searchParams } = new URL(String(input));
    const rows =
      pathname === '/api/USStatistics/GetDSCI'
        ? [{ ...base, name: 'CONUS' }]
        : searchParams.get('startdate') !== '3/5/2024'
          ? mappedDates.map((mapDate) => ({ ...base, mapDate, name: 'Alabama' }))
          : ['Alabama', 'Alaska', 'Arizona'].map((name) => ({ ...base, name }));
    return Response.json(rows);
  });
  vi.stubGlobal('fetch', fetcher);
  const [compare, series] = await Promise.all([
    import('@/mcp-server/tools/definitions/drought-compare-areas.tool.js'),
    import('@/mcp-server/tools/definitions/drought-get-timeseries.tool.js'),
  ]);
  return {
    fetcher,
    compare: compare.droughtCompareAreasTool,
    series: series.droughtGetTimeseriesTool,
  };
}
beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2024-03-12T08:00:00Z'));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});
describe('producer pagination', () => {
  it('returns complete inline rankings without opting in and discloses the existing effective default', async () => {
    const { compare } = await fixture();
    const result = await runToolContract(compare, compareInput);
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      comparedCount: 3,
      effectiveLimit: 20,
      staging: null,
    });
    expect(compare.output.parse(result.structuredContent).rows.map((row) => row.id)).toEqual([
      '01',
      '02',
      '04',
    ]);
    expect(result.structuredContent).not.toHaveProperty('nextCursor');
    expect(text(result)).toContain('**effectiveLimit:** 20');
  });
  it.each(['compare', 'series'] as const)(
    'walks every %s snapshot row with exact metadata and no further fetch',
    async (which) => {
      const definitions = await fixture();
      const tool = definitions[which];
      const input = which === 'compare' ? compareInput : seriesInput;
      const full = await runToolContract(tool, input, tenant('owner'));
      const first = await runToolContract(tool, { ...input, limit: 1 }, tenant('owner'));
      expect(first.isError).not.toBe(true);
      const page = tool.output.parse(first.structuredContent);
      expect(page.rows).toHaveLength(1);
      expect(page).toMatchObject({ hasMore: true, nextCursor: expect.any(String) });
      if (!page.nextCursor) throw new Error('Expected first continuation');
      expect(text(first)).toContain(page.nextCursor);
      const rowTable = text(first).split('## rows\n')[1]?.split('\n## ')[0] ?? '';
      const html = execFileSync(
        'bun',
        ['-e', 'console.log(Bun.markdown.html(await Bun.stdin.text()))'],
        {
          input: rowTable,
          encoding: 'utf8',
        },
      );
      expect(html.match(/<td><code>[123]<\/code><\/td>/g)?.length).toBeGreaterThan(0);
      const calls = definitions.fetcher.mock.calls.length;
      vi.setSystemTime(new Date('2024-03-12T08:04:59Z'));
      const next = await runToolContract(
        tool,
        { ...input, cursor: page.nextCursor },
        tenant('owner'),
      );
      expect(next.isError).not.toBe(true);
      const middle = tool.output.parse(next.structuredContent);
      expect(middle.rows).toHaveLength(1);
      if (!middle.nextCursor) throw new Error('Expected second continuation');
      expect(text(next)).toContain(middle.nextCursor);
      const end = await runToolContract(
        tool,
        { ...input, limit: 2, cursor: middle.nextCursor },
        tenant('owner'),
      );
      const last = tool.output.parse(end.structuredContent);
      expect(last).toMatchObject({ hasMore: false, nextCursor: null });
      expect([...page.rows, ...middle.rows, ...last.rows]).toEqual(
        tool.output.parse(full.structuredContent).rows,
      );
      expect(last).toEqual({ ...page, rows: last.rows, hasMore: false, nextCursor: null });
      const replay = await runToolContract(
        tool,
        { ...input, limit: 2, cursor: middle.nextCursor },
        tenant('owner'),
      );
      expect(replay.structuredContent).toEqual(end.structuredContent);
      expect(definitions.fetcher).toHaveBeenCalledTimes(calls);
    },
  );
  it('rejects blank, malformed, foreign, changed, tampered and expired cursors without fetch', async () => {
    const { compare, series, fetcher } = await fixture();
    const first = await runToolContract(compare, { ...compareInput, limit: 1 }, tenant('owner'));
    const { nextCursor } = compare.output.parse(first.structuredContent);
    if (!nextCursor) throw new Error('Expected an inline continuation');
    const calls = fetcher.mock.calls.length;
    const bad = await Promise.all([
      runToolContract(compare, { ...compareInput, cursor: '' }, tenant('owner')),
      runToolContract(compare, { ...compareInput, cursor: 'malformed' }, tenant('owner')),
      runToolContract(compare, { ...compareInput, cursor: nextCursor }, tenant('other')),
      runToolContract(series, { ...seriesInput, cursor: nextCursor }, tenant('owner')),
      runToolContract(
        compare,
        { ...compareInput, direction: 'asc', cursor: nextCursor },
        tenant('owner'),
      ),
      runToolContract(
        compare,
        { ...compareInput, cursor: nextCursor.replace('.1.', '.3.') },
        tenant('owner'),
      ),
    ]);
    vi.advanceTimersByTime(300_000);
    bad.push(
      await runToolContract(compare, { ...compareInput, cursor: nextCursor }, tenant('owner')),
    );
    for (const result of bad) {
      expect(result).toMatchObject({
        isError: true,
        structuredContent: {
          error: {
            data: {
              reason: 'invalid_cursor',
              recovery: { hint: expect.stringContaining('without cursor') },
            },
          },
        },
      });
      expect(text(result)).toContain('without cursor');
      expect(text(result)).toContain('invalid_cursor');
    }
    expect(fetcher).toHaveBeenCalledTimes(calls);
  });
  it('accepts normalized area aliases and preserves explicit-token errors without analytics', async () => {
    const { series, fetcher } = await fixture();
    const first = await runToolContract(series, { ...seriesInput, limit: 1 });
    const { nextCursor } = series.output.parse(first.structuredContent);
    if (!nextCursor) throw new Error('Expected an inline continuation');
    const calls = fetcher.mock.calls.length;
    const next = await runToolContract(series, {
      ...seriesInput,
      areas: [{ areaType: 'state', aoi: 'Alabama' }],
      cursor: nextCursor,
    });
    expect(series.output.parse(next.structuredContent).rows.map((row) => row.row_id)).toEqual([2]);
    expect(fetcher).toHaveBeenCalledTimes(calls);
    const explicit = await runToolContract(series, {
      ...seriesInput,
      canvas_id: 'aaaaaaaaaa',
      limit: 1,
      cursor: '',
    });
    expect(explicit).toMatchObject({
      isError: true,
      structuredContent: { error: { data: { reason: 'canvas_unavailable' } } },
    });
    expect(text(explicit)).toContain('canvas_unavailable');
  });
  it('returns exhausted, empty and clamped inline pages and enforces strict caps', async () => {
    const { series, compare } = await fixture();
    const exhausted = await runToolContract(series, { ...seriesInput, limit: 201 });
    expect(exhausted.structuredContent).toMatchObject({
      rowCount: 3,
      nextCursor: null,
      hasMore: false,
      effectiveLimit: 200,
      limitNotice: expect.stringContaining('clamped'),
    });
    expect(text(exhausted)).toContain('Requested limit 201 was clamped to 200');
    const empty = await runToolContract(compare, {
      ...compareInput,
      date: '2024-03-12',
      limit: 200,
    });
    expect(empty.structuredContent).toMatchObject({
      rows: [],
      comparedCount: 0,
      nextCursor: null,
      hasMore: false,
    });
    expect(text(empty)).toContain('## rows\n\n[]');
    vi.stubEnv('DROUGHT_CLAMP_LIMITS', 'false');
    vi.resetModules();
    const strict = await fixture();
    for (const limit of [0, 201]) {
      const result = await runToolContract(strict.series, { ...seriesInput, limit });
      expect(result.isError).toBe(true);
    }
    expect(strict.fetcher).not.toHaveBeenCalled();
  });
  it('bounds retained entry count without reserving slots for exhausted pages', async () => {
    const { compare } = await fixture();
    const acquire = (limit: number) => runToolContract(compare, { ...compareInput, limit });
    const cursors: string[] = [];
    for (let index = 0; index < 32; index++) {
      const { nextCursor } = compare.output.parse((await acquire(1)).structuredContent);
      if (!nextCursor) throw new Error('Expected an inline continuation');
      cursors.push(nextCursor);
    }
    expect(compare.output.parse((await acquire(3)).structuredContent).nextCursor).toBeNull();
    const refresh = await runToolContract(compare, { ...compareInput, cursor: cursors[0] });
    expect(refresh.isError).not.toBe(true);
    await acquire(1);
    const evicted = await runToolContract(compare, { ...compareInput, cursor: cursors[1] });
    expect(evicted.structuredContent).toMatchObject({
      error: { data: { reason: 'invalid_cursor' } },
    });
  });
  it('counts serialized metadata bytes against the shared snapshot capacity', async () => {
    const { compare } = await fixture();
    const { pageProducer } = await import('@/services/drought/producer-pagination.js');
    const first = await runToolContract(compare, compareInput);
    const full = compare.output.parse(first.structuredContent);
    const result = {
      ...full,
      provenance: { ...full.provenance, credit: 'é'.repeat(17 * 1024 * 1024) },
    };
    const ctx = createMockContext();
    const begin = () =>
      pageProducer(
        'comparison',
        {},
        1,
        ctx,
        () => 'filters',
        async () => result,
      );
    const { nextCursor } = (await begin()).result;
    if (!nextCursor) throw new Error('Expected an inline continuation');
    await begin();
    const unused = vi.fn(async () => result);
    await expect(
      pageProducer('comparison', { cursor: nextCursor }, undefined, ctx, () => 'filters', unused),
    ).rejects.toMatchObject({ data: { reason: 'invalid_cursor' } });
    expect(unused).not.toHaveBeenCalled();
  });
  it('returns an exact staged preview wider than the legacy budget and registers every row', async () => {
    const allDates = Array.from({ length: 201 }, (_, index) =>
      addDays(dates[2], (index - 200) * 7),
    );
    const { series } = await fixture(allDates);
    const { setCanvas } = await import('@/services/canvas-accessor.js');
    const query = (await import('@/mcp-server/tools/definitions/drought-dataframe-query.tool.js'))
      .droughtDataframeQueryTool;
    const root = await mkdtemp(join(tmpdir(), 'drought-producer-paging-'));
    const provider = new DuckdbProvider({
      defaultRowLimit: 501,
      exportRootPath: root,
      tempRootPath: root,
      memoryLimitMb: 128,
      schemaSniffRows: 100,
    });
    const canvas = new DataCanvas(
      provider,
      new CanvasRegistry(provider, {
        ttlMs: 86_400_000,
        absoluteCapMs: 604_800_000,
        maxCanvasesPerTenant: 4,
        sweeperIntervalMs: 0,
      }),
    );
    setCanvas(canvas);
    try {
      const input = { ...seriesInput, startDate: allDates[0]! };
      const omitted = await runToolContract(series, input);
      const exact = await runToolContract(series, { ...input, limit: 200 });
      const result = series.output.parse(exact.structuredContent);
      expect(series.output.parse(omitted.structuredContent).rows.length).toBeLessThan(200);
      expect(result.rows.map((row) => row.row_id)).toEqual(
        Array.from({ length: 200 }, (_, index) => index + 1),
      );
      expect(result.rowCount).toBe(201);
      expect(result.nextCursor).toBeUndefined();
      expect(result.staging?.row_count).toBe(201);
      if (!result.staging) throw new Error('Expected a staged continuation');
      const sql = `SELECT row_id FROM ${result.staging.table_name} ORDER BY row_id`;
      const next = await runToolContract(query, {
        canvas_id: result.staging.canvas_id,
        sql,
        offset: 200,
      });
      expect(query.output.parse(next.structuredContent).rows).toEqual([{ row_id: 201 }]);
      expect(text(next)).toContain('201');
      const pastEnd = await runToolContract(query, {
        canvas_id: result.staging.canvas_id,
        sql,
        offset: 201,
      });
      expect(pastEnd.structuredContent).toMatchObject({ rows: [], next_offset: null });
    } finally {
      setCanvas(undefined);
      await canvas.shutdown(createMockContext());
      await rm(root, { recursive: true, force: true });
    }
  });
});
