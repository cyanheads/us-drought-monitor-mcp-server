/**
 * @fileoverview Public drought success/error envelopes and exact Markdown recovery.
 * @module tests/services/drought/workflow-contracts
 */
import { execFileSync } from 'node:child_process';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addDays } from '@/services/drought/dates.js';
import { renderFields, renderScalar } from '@/services/drought/format.js';
import { renderWorkflow } from '@/services/drought/workflow-format.js';

const latest = '2024-03-05';
const area = { areaType: 'state', aoi: 'AL' } as const;
const range = { startDate: latest, endDate: latest };
const observation = {
  mapDate: latest,
  name: 'Alabama',
  dsci: 193,
  none: 10,
  d0: 90,
  d1: 60,
  d2: 30,
  d3: null,
  d4: 3,
};
const duration = {
  fips: '01001',
  county: 'Autauga County',
  state: 'AL',
  startDate: latest,
  endDate: '2024-03-11',
  consecutiveWeeks: 1,
};
const text = (result: Awaited<ReturnType<typeof runToolContract>>) =>
  result.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
const markdownHtml = (markdown: string) =>
  execFileSync('bun', ['-e', 'console.log(Bun.markdown.html(await Bun.stdin.text()))'], {
    input: markdown,
    encoding: 'utf8',
  });
const decodeHtml = (value: string) =>
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
function tableRows(html: string): Record<string, unknown>[] {
  const table = /<table>([\s\S]*?)<\/table>/.exec(html)?.[1];
  expect(table).toBeDefined();
  if (!table) throw new Error('Expected an actual rendered Markdown table');
  const scalar = (cell: string): unknown => {
    const code = /<code>([\s\S]*?)<\/code>/.exec(cell)?.[1];
    if (code === undefined) throw new Error(`Present table cell lacks JSON scalar: ${cell}`);
    return JSON.parse(decodeHtml(code));
  };
  const columns = [...table.matchAll(/<th(?:\s[^>]*)?>([\s\S]*?)<\/th>/g)].map((match) =>
    scalar(match[1] ?? ''),
  );
  expect(columns.length).toBeGreaterThan(0);
  const body = /<tbody>([\s\S]*?)<\/tbody>/.exec(table)?.[1] ?? '';
  return [...body.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((row) => {
    const cells = [...(row[1] ?? '').matchAll(/<td(?:\s[^>]*)?>([\s\S]*?)<\/td>/g)].map(
      (match) => match[1] ?? '',
    );
    expect(cells).toHaveLength(columns.length);
    const record: Record<string, unknown> = {};
    for (const [index, cell] of cells.entries()) {
      if (!cell.trim()) continue;
      const name = columns[index];
      if (typeof name !== 'string') throw new Error('Expected exact string column name');
      record[name] = scalar(cell);
      const urls = (value: unknown): string[] =>
        typeof value === 'string' && /^https:\/\/[^\s<>]+$/.test(value)
          ? [value]
          : value !== null && typeof value === 'object'
            ? Object.values(value).flatMap(urls)
            : [];
      const targets = [...cell.matchAll(/<a href="([^"]*)"/g)].map((match) =>
        decodeURI(decodeHtml(match[1] ?? '')),
      );
      expect(targets).toEqual(urls(record[name]).map((url) => decodeURI(url)));
    }
    return record;
  });
}
async function tools(reply?: (url: URL) => unknown[]) {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) => {
    const url = new URL(String(input));
    const rows = reply
      ? reply(url)
      : url.pathname === '/api/USStatistics/GetDSCI'
        ? [{ mapDate: latest, name: 'CONUS', dsci: 1 }]
        : url.pathname.includes('Consecutive')
          ? [duration]
          : [observation];
    return new Response(JSON.stringify(rows));
  });
  vi.stubGlobal('fetch', fetcher);
  const [current, timeseries, compare, weeks] = await Promise.all([
    import('@/mcp-server/tools/definitions/drought-get-current-severity.tool.js'),
    import('@/mcp-server/tools/definitions/drought-get-timeseries.tool.js'),
    import('@/mcp-server/tools/definitions/drought-compare-areas.tool.js'),
    import('@/mcp-server/tools/definitions/drought-get-weeks-in-drought.tool.js'),
  ]);
  return {
    fetcher,
    current: current.droughtGetCurrentSeverityTool,
    timeseries: timeseries.droughtGetTimeseriesTool,
    compare: compare.droughtCompareAreasTool,
    weeks: weeks.droughtGetWeeksInDroughtTool,
  };
}
beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2024-03-12T08:00:00Z'));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('drought public consumption paths', () => {
  it('returns complete producer results through the production disabled-provider path', async () => {
    const dates: string[] = [];
    for (let date = '2000-01-04'; date <= latest; date = addDays(date, 7)) dates.push(date);
    const definitions = await tools((url) =>
      url.pathname === '/api/USStatistics/GetDSCI'
        ? [{ mapDate: latest, name: 'CONUS', dsci: 1 }]
        : dates.map((mapDate) => ({ ...observation, mapDate })),
    );
    const result = await runToolContract(definitions.timeseries, {
      areas: [area],
      startDate: dates[0]!,
      endDate: latest,
    });
    expect(result.isError).not.toBe(true);
    const parsed = definitions.timeseries.output.parse(result.structuredContent);
    expect(parsed.rows).toHaveLength(dates.length);
    expect(parsed.staging).toBeNull();
    expect(parsed.rows.map((row) => row.mapDate)).toEqual(dates);
    expect(tableRows(markdownHtml(text(result)))).toHaveLength(dates.length);
  });
  it('returns exact wide duration pages with unchanged cached continuation on both surfaces', async () => {
    const rows = Array.from({ length: 201 }, (_, index) => ({
      fips: `01${String(index).padStart(3, '0')}`,
      county: `County ${index} ${'w'.repeat(1000)}`,
      state: 'AL',
      nonConsecutiveWeeks: 1,
    }));
    const definitions = await tools((url) =>
      url.pathname === '/api/USStatistics/GetDSCI'
        ? [{ mapDate: latest, name: 'CONUS', dsci: 1 }]
        : rows,
    );
    const input = {
      ...range,
      states: ['AL'],
      minCategory: 'D1' as const,
      minWeeks: 1,
      mode: 'non_consecutive' as const,
      limit: 200,
    };
    const first = await runToolContract(definitions.weeks, input);
    const page = definitions.weeks.output.parse(first.structuredContent);
    expect(page.rows).toEqual(rows.slice(0, 200));
    expect(tableRows(markdownHtml(text(first)))).toEqual(rows.slice(0, 200));
    const last = await runToolContract(definitions.weeks, { ...input, cursor: page.nextCursor! });
    expect(definitions.weeks.output.parse(last.structuredContent)).toMatchObject({
      rows: [rows[200]],
      totalCount: 201,
      nextCursor: null,
    });
    expect(tableRows(markdownHtml(text(last)))).toEqual([rows[200]]);
    expect(definitions.fetcher).toHaveBeenCalledTimes(2);
  });
  it('advertises date syntax while retaining blank optional dates and rejecting impossible calendars', async () => {
    const definitions = await tools();
    expect(definitions.current.input.safeParse({ area, date: '' }).success).toBe(true);
    expect(
      definitions.compare.input.safeParse({ scope: 'states', date: '', baselineDate: '' }).success,
    ).toBe(true);
    for (const date of ['10/13/2026', '2026-1-01', '2026-01-010']) {
      const result = await runToolContract(definitions.current, { area, date });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: { code: JsonRpcErrorCode.InvalidParams },
      });
      expect(text(result)).toContain('date');
    }
    const impossible = await runToolContract(definitions.current, { area, date: '2024-02-30' });
    expect(impossible.structuredContent).toMatchObject({
      error: { data: { reason: 'invalid_date_range' } },
    });
  });
  it('explains duration thresholds beyond the window on both surfaces before acquisition', async () => {
    const definitions = await tools();
    const result = await runToolContract(definitions.weeks, {
      ...range,
      states: ['AL'],
      minCategory: 'D1',
      minWeeks: 2,
    });
    expect(result.structuredContent).toMatchObject({
      error: {
        data: {
          reason: 'invalid_date_range',
          recovery: { hint: expect.stringContaining('lower minWeeks') },
        },
      },
    });
    expect(text(result)).toContain('lower minWeeks');
    expect(text(result)).toContain('widen');
    expect(definitions.fetcher).not.toHaveBeenCalled();
  });
  it('clamps comparison and duration previews with both-surface disclosure', async () => {
    const definitions = await tools();
    const comparison = await runToolContract(definitions.compare, {
      scope: 'states',
      date: latest,
      limit: 201,
    });
    const duration = await runToolContract(definitions.weeks, {
      ...range,
      states: ['AL'],
      minCategory: 'D1',
      minWeeks: 1,
      limit: 201,
    });
    expect(comparison.structuredContent).toMatchObject({ staging: null });
    expect(text(comparison)).not.toContain('staged table');
    for (const result of [comparison, duration]) {
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        effectiveLimit: 200,
        limitNotice: expect.stringContaining('200'),
      });
      expect(text(result)).toContain('limitNotice');
    }
  });
  it.each(['09001', 'Fairfield County, CT'])(
    'preserves empty success and planning-region guidance for %s on every observation workflow',
    async (aoi) => {
      const definitions = await tools((url) =>
        url.pathname === '/api/USStatistics/GetDSCI'
          ? [{ mapDate: latest, name: 'CONUS', dsci: 1 }]
          : [],
      );
      const results = [
        await runToolContract(definitions.current, { area: { areaType: 'county', aoi } }),
        await runToolContract(definitions.timeseries, {
          areas: [{ areaType: 'county', aoi }],
          ...range,
        }),
        await runToolContract(definitions.weeks, {
          county: aoi,
          ...range,
          minCategory: 'D1',
          minWeeks: 1,
        }),
      ];
      for (const result of results) {
        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toMatchObject({
          guidance: expect.stringContaining('planning region'),
          notice: expect.stringContaining('state: CT'),
        });
        expect(text(result)).toContain('planning region');
        expect(text(result)).toContain('drought_list_reference');
      }
    },
  );
  it('declares and mirrors upstream request rejection without retry', async () => {
    const definitions = await tools();
    definitions.fetcher.mockResolvedValue(new Response('', { status: 400 }));
    const result = await runToolContract(definitions.current, { area });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        data: {
          reason: 'upstream_request_rejected',
          recovery: { hint: expect.stringContaining('drought_list_reference') },
        },
      },
    });
    expect(text(result)).toContain('upstream_request_rejected');
    expect(text(result)).toContain('drought_list_reference');
    expect(definitions.fetcher).toHaveBeenCalledTimes(1);
  });
  it('validates actual snapshot, timeseries, comparison and weeks results and renders every returned row', async () => {
    const definitions = await tools();
    const results = await Promise.all([
      runToolContract(definitions.current, { area, date: '' }),
      runToolContract(definitions.timeseries, { areas: [area], ...range, canvas_id: '' }),
      runToolContract(definitions.compare, {
        scope: 'states',
        date: '',
        baselineDate: '',
        canvas_id: '',
        limit: 200,
      }),
      runToolContract(definitions.weeks, {
        ...range,
        minCategory: 'd2',
        minWeeks: 1,
        states: ['AL'],
        county: '',
        cursor: '',
        limit: 200,
      }),
    ]);
    const [current, timeseries, compare, weeks] = results;
    expect(current?.isError).not.toBe(true);
    expect(timeseries?.isError).not.toBe(true);
    expect(compare?.isError).not.toBe(true);
    expect(weeks?.isError).not.toBe(true);
    if (!current || !timeseries || !compare || !weeks) throw new Error('Missing contract result');
    const snapshot = definitions.current.output.parse(current.structuredContent);
    const series = definitions.timeseries.output.parse(timeseries.structuredContent);
    const ranking = definitions.compare.output.parse(compare.structuredContent);
    const durations = definitions.weeks.output.parse(weeks.structuredContent);
    expect(snapshot.snapshots[0]?.dsci).toBe(193);
    expect(series.rows).toHaveLength(1);
    expect(series.rows[0]?.buckets).toMatchObject({ d3_d4: null });
    expect(ranking.rows[0]).toMatchObject({
      targetValue: 193,
      baselineValue: null,
      change: null,
      rank: 1,
    });
    expect(durations.rows).toEqual([
      { ...duration, startMayExtendEarlier: true, endMayContinue: true },
    ]);
    for (const result of results) {
      expect(text(result)).toContain(latest);
      expect(text(result)).toContain('provenance');
    }
    expect(text(current)).toContain('193');
    expect(text(timeseries)).toContain('null');
    expect(text(compare)).toContain('193');
    expect(text(weeks)).toContain('Autauga County');
    expect(text(weeks)).toContain('2024-03-11');
    for (const [result, expectedRows] of [
      [current, snapshot.snapshots],
      [timeseries, series.rows],
      [compare, ranking.rows],
      [weeks, durations.rows],
    ] as const)
      expect(tableRows(markdownHtml(text(result)))).toEqual(expectedRows);
  });
  it('returns empty results with executable notices on both surfaces', async () => {
    const definitions = await tools((url) =>
      url.pathname === '/api/USStatistics/GetDSCI'
        ? [{ mapDate: latest, name: 'CONUS', dsci: 1 }]
        : [],
    );
    const series = await runToolContract(definitions.timeseries, { areas: [area], ...range });
    const weeks = await runToolContract(definitions.weeks, {
      ...range,
      minCategory: 'D2',
      minWeeks: 1,
      states: ['AL'],
    });
    const compare = await runToolContract(definitions.compare, {
      scope: 'states',
      date: '2024-03-12',
    });
    for (const [result, tool] of [
      [series, 'drought_get_timeseries'],
      [weeks, 'drought_get_weeks_in_drought'],
      [compare, 'drought_compare_areas'],
    ] as const) {
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ rows: [] });
      expect(text(result)).toContain(tool);
      expect(result.structuredContent).toMatchObject({ notice: expect.stringContaining(tool) });
    }
  });
  it('mirrors declared invalid-area, date, metric and cursor reasons plus recovery', async () => {
    const definitions = await tools();
    const results = [
      [
        await runToolContract(definitions.current, { area: { areaType: 'state', aoi: 'ZZ' } }),
        definitions.current.errors,
        'unknown_area',
      ],
      [
        await runToolContract(definitions.current, { area, date: '2024-02-30' }),
        definitions.current.errors,
        'invalid_date_range',
      ],
      [
        await runToolContract(definitions.timeseries, {
          areas: [area, { areaType: 'county', aoi: '01001' }],
          ...range,
        }),
        definitions.timeseries.errors,
        'invalid_area',
      ],
      [
        await runToolContract(definitions.timeseries, {
          areas: [{ areaType: 'huc', aoi: '01', hucLevel: 2 }],
          ...range,
          metric: 'population_count',
        }),
        definitions.timeseries.errors,
        'unsupported_metric',
      ],
      [
        await runToolContract(definitions.compare, {
          scope: 'counties',
          date: latest,
          baselineDate: '2024-03-06',
        }),
        definitions.compare.errors,
        'invalid_date_range',
      ],
      [
        await runToolContract(definitions.weeks, {
          ...range,
          minCategory: 'D2',
          minWeeks: 1,
          states: ['AL'],
          county: '01001',
        }),
        definitions.weeks.errors,
        'invalid_area',
      ],
      [
        await runToolContract(definitions.weeks, {
          ...range,
          minCategory: 'D2',
          minWeeks: 1,
          cursor: 'invalid',
        }),
        definitions.weeks.errors,
        'invalid_cursor',
      ],
    ] as const;
    for (const [result, errors, reason] of results) {
      expect(result.isError).toBe(true);
      const recovery = errors?.find((entry) => entry.reason === reason)?.recovery;
      expect(result.structuredContent).toMatchObject({
        error: { data: { reason, recovery: { hint: recovery } } },
      });
      expect(text(result)).toContain(reason);
      expect(text(result)).toContain(recovery);
    }
  });
  it('mirrors publication and malformed-upstream failures without inventing successful output', async () => {
    const empty = await tools(() => []);
    const publication = await runToolContract(empty.current, { area });
    expect(publication.structuredContent).toMatchObject({
      error: {
        data: { reason: 'publication_unavailable', recovery: { hint: expect.any(String) } },
      },
    });
    expect(text(publication)).toContain('publication_unavailable');
    vi.resetModules();
    const broken = await tools((url) =>
      url.pathname === '/api/USStatistics/GetDSCI'
        ? [{ mapDate: latest, name: 'CONUS', dsci: 1 }]
        : [{ ...observation, mapDate: '2024-03-06' }],
    );
    const malformed = await runToolContract(broken.timeseries, { areas: [area], ...range });
    expect(malformed.structuredContent).toMatchObject({
      error: { data: { reason: 'upstream_shape_invalid', recovery: { hint: expect.any(String) } } },
    });
    expect(text(malformed)).toContain('upstream_shape_invalid');
  });
  it('rejects input array and pagination caps on both paths before fetching', async () => {
    const definitions = await tools();
    for (const input of [
      { areas: [], ...range },
      { areas: Array.from({ length: 101 }, () => area), ...range },
    ]) {
      const result = await runToolContract(definitions.timeseries, input);
      expect(result.structuredContent).toMatchObject({
        error: { code: JsonRpcErrorCode.InvalidParams },
      });
      expect(text(result)).toContain('areas');
    }
    for (const limit of [0, -1, 1.5]) {
      const result = await runToolContract(definitions.weeks, {
        ...range,
        minCategory: 'D2',
        minWeeks: 1,
        limit,
      });
      expect(result.structuredContent).toMatchObject({
        error: { code: JsonRpcErrorCode.InvalidParams },
      });
      expect(text(result)).toContain('limit');
    }
    expect(definitions.fetcher).not.toHaveBeenCalled();
  });
  it('returns declared plan-budget rejection on both paths before network I/O', async () => {
    const definitions = await tools();
    const result = await runToolContract(definitions.timeseries, {
      areas: Array.from({ length: 33 }, (_, index) => ({
        areaType: 'huc' as const,
        aoi: String(index).padStart(4, '0'),
        hucLevel: 4 as const,
      })),
      ...range,
    });
    expect(result.structuredContent).toMatchObject({
      error: {
        data: {
          reason: 'dataset_too_large',
          plannedRequests: 67,
          maxRequests: 64,
          recovery: { hint: expect.stringContaining('drought_get_timeseries') },
        },
      },
    });
    expect(text(result)).toContain('dataset_too_large');
    expect(definitions.fetcher).not.toHaveBeenCalled();
  });
  it('accepts the 100-area schema boundary, deduplicates identities and exposes every field on both paths', async () => {
    const definitions = await tools();
    const result = await runToolContract(definitions.timeseries, {
      areas: Array.from({ length: 100 }, () => area),
      ...range,
    });
    expect(result.isError).not.toBe(true);
    const parsed = definitions.timeseries.output.parse(result.structuredContent);
    expect(parsed.areas).toHaveLength(1);
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rowCount).toBe(1);
    for (const key of Object.keys(parsed.rows[0] ?? {})) expect(text(result)).toContain(key);
    expect(definitions.fetcher).toHaveBeenCalledTimes(3);
  });
});

describe('exact Markdown value recovery', () => {
  it.each([
    'https://example.org/a\\?x=1',
    'https://example.org/a\\|[b]?x=`tick`&y=[c]',
    'https://example.org/a?x=&copy;',
  ])('preserves JSON values and decoded link targets for %s', (url) => {
    const html = markdownHtml(renderFields({ rows: [{ url }], source: url }));
    const values = [...html.matchAll(/<code>([\s\S]*?)<\/code>/g)].map((match) =>
      JSON.parse(decodeHtml(match[1] ?? '')),
    );
    expect(values).toContain(url);
    const targets = [...html.matchAll(/<a href="([^"]*)"/g)].map((match) =>
      decodeURI(decodeHtml(match[1] ?? '')),
    );
    expect(targets).toEqual([url, url]);
  });
  it.each(['records', 'rows', 'columns'])(
    'round-trips compact %s tables including nested collections',
    (field) => {
      const rows = [
        {
          id: '01',
          text: 'x|`\r\n\\',
          nested: { a: [null, false, 0] },
          url: 'https://example.org/a?x=1&y=2',
          optional: null,
        },
        { id: '02', text: '', nested: [] },
      ];
      expect(tableRows(markdownHtml(renderFields({ [field]: rows })))).toEqual(rows);
      expect(tableRows(markdownHtml(renderFields({ tables: [{ columns: rows }] })))).toEqual(rows);
      expect(renderFields({ [field]: [] })).toContain('[]');
    },
  );
  function parse(markdown: string) {
    const html = markdownHtml(markdown);
    return {
      html,
      values: [...html.matchAll(/<pre><code[^>]*>([\s\S]*?)<\/code><\/pre>/g)].flatMap((match) =>
        decodeHtml(match[1] ?? '')
          .trimEnd()
          .split('\n')
          .map((line) => JSON.parse(line) as unknown),
      ),
    };
  }
  it('recovers scalar CR/LF, pipes, embedded fences, nulls and nested metadata through a real Markdown parser', () => {
    const special = 'Name | <tag> & `tick`\nnext\r\nlast\rreturn ``` fence \\| \\\\ path';
    expect(parse(renderScalar(special)).values).toEqual([special]);
    const url = 'https://example.org/source?one=1&two=2';
    const rows = [
      {
        id: '01001',
        name: special,
        value: null,
        buckets: { d3: null, d4: 1, nested: [{ text: special, url }] },
        sourceUrl: url,
      },
    ];
    const result = parse(
      renderWorkflow({
        metadata: {
          nested: [{ label: special, missing: null, count: 0, enabled: false }],
          sources: [url],
        },
        rows,
      }),
    );
    expect(result.values).toEqual([special, null, 0, false]);
    expect(tableRows(result.html)).toEqual(rows);
    expect(result.html).toContain(`href="${url.replaceAll('&', '&amp;')}"`);
  });
  it('preserves absent optional row properties instead of fabricating null values', () => {
    const rows = [
      { id: '01001', state: 'AL', optional: null, text: '' },
      { id: '99999', optional: false, text: 'null' },
    ];
    const parsed = parse(renderWorkflow({ rows }));
    expect(tableRows(parsed.html)).toEqual(rows);
    expect(Object.hasOwn(tableRows(parsed.html)[1] ?? {}, 'state')).toBe(false);
  });
});
