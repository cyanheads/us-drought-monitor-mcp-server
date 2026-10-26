/**
 * @fileoverview Page-limit schemas, strict configuration and clamp telemetry.
 * @module tests/services/drought/page-limits
 */
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  vi.restoreAllMocks();
});

describe('page limits', () => {
  it('strictly parses the default-on clamp flag', async () => {
    const { getCanvasConfig } = await import('@/config/canvas-config.js');
    vi.stubEnv('DROUGHT_CLAMP_LIMITS', undefined);
    expect(getCanvasConfig().clampLimits).toBe(true);
    vi.stubEnv('DROUGHT_CLAMP_LIMITS', 'false');
    expect(getCanvasConfig().clampLimits).toBe(false);
    vi.stubEnv('DROUGHT_CLAMP_LIMITS', 'sometimes');
    expect(() => getCanvasConfig()).toThrow();
  });
  it.each([true, false])(
    'advertises and enforces every count schema with clamping %s',
    async (clamp) => {
      vi.stubEnv('DROUGHT_CLAMP_LIMITS', String(clamp));
      vi.resetModules();
      const { pageLimit } = await import('@/config/page-limits.js');
      for (const [defaultLimit, cap] of [
        [25, 200],
        [20, 200],
        [25, 500],
        [20, 100],
      ]) {
        const schema = pageLimit(defaultLimit!, cap!, 'items');
        expect(schema.parse(undefined)).toBe(defaultLimit);
        expect(schema.safeParse(cap).success).toBe(true);
        expect(schema.safeParse(cap! + 1).success).toBe(clamp);
        expect(schema.toJSONSchema()).toMatchObject(clamp ? { minimum: 1 } : { maximum: cap });
        if (clamp) expect(schema.toJSONSchema().maximum).toBe(Number.MAX_SAFE_INTEGER);
        for (const value of [0, -1, 1.5]) expect(schema.safeParse(value).success).toBe(false);
      }
    },
  );
  it('logs and counts only actual clamps with bounded metric attributes', async () => {
    const add = vi.fn();
    vi.doMock('@cyanheads/mcp-ts-core/utils', async (original) => ({
      ...(await original<Record<string, unknown>>()),
      createCounter: vi.fn(() => ({ add })),
    }));
    vi.resetModules();
    const { effectiveLimit } = await import('@/config/page-limits.js');
    const ctx = createMockContext();
    const notice = vi.spyOn(ctx.log, 'notice');
    expect(effectiveLimit(201, 200, 'drought_list_reference', ctx)).toBe(200);
    expect(effectiveLimit(200, 200, 'drought_list_reference', ctx)).toBe(200);
    expect(notice).toHaveBeenCalledExactlyOnceWith('Drought page limit clamped.', {
      toolName: 'drought_list_reference',
      requestedLimit: 201,
      effectiveLimit: 200,
    });
    expect(add).toHaveBeenCalledExactlyOnceWith(1, { tool: 'drought_list_reference' });
    vi.doUnmock('@cyanheads/mcp-ts-core/utils');
  });
  it('wires strict schemas and defaults into all five public count inputs', async () => {
    vi.stubEnv('DROUGHT_CLAMP_LIMITS', 'false');
    vi.resetModules();
    const [
      { droughtListReferenceTool: reference },
      { droughtGetWeeksInDroughtTool: weeks },
      { droughtCompareAreasTool: compare },
      { droughtDataframeQueryTool: query },
      { droughtDataframeDescribeTool: describeTool },
    ] = await Promise.all([
      import('@/mcp-server/tools/definitions/drought-list-reference.tool.js'),
      import('@/mcp-server/tools/definitions/drought-get-weeks-in-drought.tool.js'),
      import('@/mcp-server/tools/definitions/drought-compare-areas.tool.js'),
      import('@/mcp-server/tools/definitions/drought-dataframe-query.tool.js'),
      import('@/mcp-server/tools/definitions/drought-dataframe-describe.tool.js'),
    ]);
    expect(reference.input.parse({ topic: 'states' }).limit).toBe(25);
    expect(
      weeks.input.parse({
        startDate: '2024-03-05',
        endDate: '2024-03-05',
        minCategory: 'D1',
        minWeeks: 1,
      }).limit,
    ).toBe(25);
    expect(compare.input.parse({ scope: 'states' }).limit).toBe(20);
    expect(query.input.parse({ canvas_id: 'missing000', sql: 'SELECT 1' }).limit).toBe(25);
    expect(describeTool.input.parse({ canvas_id: 'missing000' }).metadata_limit).toBe(20);
    const results = await Promise.all([
      runToolContract(reference, { topic: 'states', limit: 201 }),
      runToolContract(weeks, {
        startDate: '2024-03-05',
        endDate: '2024-03-05',
        minCategory: 'D1',
        minWeeks: 1,
        limit: 201,
      }),
      runToolContract(compare, { scope: 'states', limit: 201 }),
      runToolContract(query, { canvas_id: 'missing000', sql: 'SELECT 1', limit: 501 }),
      runToolContract(describeTool, { canvas_id: 'missing000', metadata_limit: 101 }),
    ]);
    for (const result of results) {
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({ error: { code: -32602 } });
      expect(
        result.content.some((block) => block.type === 'text' && block.text.includes('limit')),
      ).toBe(true);
    }
  });
});
