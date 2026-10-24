/**
 * @fileoverview Bounded read-only SQL over a caller-held analytical token.
 * @module mcp-server/tools/definitions/drought-dataframe-query.tool
 */
import { tool, z } from '@cyanheads/mcp-ts-core';
import { CanvasIdSchema } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { dataframeService } from '../../../services/drought/dataframe-service.js';
import { renderFields } from '../../../services/drought/format.js';

/** Query an existing canvas without materializing or exporting more tables. */
export const droughtDataframeQueryTool = tool('drought_dataframe_query', {
  title: 'Query staged drought data',
  description:
    'Run one DuckDB read expression against staged drought tables, optionally ending with one semicolon. Get canvas_id from drought_get_timeseries or drought_compare_areas and inspect columns with drought_dataframe_describe. For every original row, SELECT * FROM the table ORDER BY row_id and follow next_offset until null. Arbitrary SQL pagination requires your own stable ORDER BY. Exact totals require SELECT COUNT(*).',
  annotations: { readOnlyHint: true, openWorldHint: false },
  input: z.object({
    canvas_id: CanvasIdSchema.describe('Token returned by a drought producer.'),
    sql: z
      .string()
      .min(1)
      .max(16_384)
      .describe(
        'One DuckDB read expression with an optional terminal semicolon; staged tables only.',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .default(100)
      .describe(
        'Maximum returned rows, clamped to 500 with disclosure and further bounded by complete response size.',
      ),
    offset: z
      .number()
      .int()
      .min(0)
      .max(250_000)
      .default(0)
      .describe('Rows to skip in the stable ordered query.'),
  }),
  output: z.object({
    canvas_id: z.string().describe('Supplied canvas token.'),
    columns: z.array(z.string()).describe('Projected column names in order.'),
    rows: z
      .array(z.record(z.string(), z.unknown()))
      .describe('Complete projected values on this page.'),
    returnedCount: z.number().int().describe('Number of rows returned.'),
    offset: z.number().int().describe('Rows skipped by this query.'),
    next_offset: z
      .number()
      .int()
      .nullable()
      .describe('Continue with this offset and identical SQL, or null.'),
    has_more: z.boolean().describe('Whether another page remains.'),
    countIsExact: z
      .boolean()
      .describe('True only when the page exhausts the query at offset zero.'),
    tableMetadata: z
      .array(
        z
          .object({
            name: z.string().describe('Staged source table.'),
            provenance: z
              .unknown()
              .describe('Source attribution; full metadata is available from describe.'),
          })
          .describe('One staged source table and its retained attribution.'),
      )
      .describe('Bounded table identity and source provenance.'),
  }),
  enrichment: {
    effectiveLimit: z
      .number()
      .int()
      .optional()
      .describe('Effective page ceiling after clamping to 500.'),
    limitNotice: z.string().optional().describe('Disclosure when the requested limit was clamped.'),
    notice: z.string().optional().describe('Empty-result or continuation guidance.'),
    truncated: z.boolean().optional().describe('More query rows remain beyond this page.'),
    shown: z.number().int().optional().describe('Complete rows shown on the truncated page.'),
    cap: z.number().int().optional().describe('Requested maximum page rows.'),
  },
  errors: [
    {
      reason: 'canvas_unavailable',
      code: JsonRpcErrorCode.ConfigurationError,
      when: 'Analytical provider is disabled or unavailable.',
      recovery:
        'Use the npm or Docker analytical installation with @duckdb/node-api and CANVAS_PROVIDER_TYPE=duckdb; MCPB supports inline results only.',
      thrownBy: 'service',
    },
    {
      reason: 'canvas_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'Token is absent, expired or belongs to another tenant.',
      recovery:
        'Re-run drought_get_timeseries or drought_compare_areas to stage data and use the returned canvas_id.',
      thrownBy: 'service',
    },
    {
      reason: 'missing_table',
      code: JsonRpcErrorCode.NotFound,
      when: 'A named staged table is absent.',
      recovery:
        'Call drought_dataframe_describe with the same canvas_id, or re-stage with drought_get_timeseries or drought_compare_areas.',
      thrownBy: 'service',
    },
    {
      reason: 'invalid_sql',
      code: JsonRpcErrorCode.ValidationError,
      when: 'SQL cannot parse or bind.',
      recovery:
        'Call drought_dataframe_describe with the same canvas_id and retry drought_dataframe_query using its columns.',
      thrownBy: 'service',
    },
    {
      reason: 'sql_execution_error',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A data conversion or range expression fails.',
      recovery:
        'Inspect columns with drought_dataframe_describe, then retry drought_dataframe_query with TRY_CAST or a narrower filter.',
      thrownBy: 'service',
    },
    {
      reason: 'sql_read_only',
      code: JsonRpcErrorCode.ValidationError,
      when: 'SQL gate rejects a write, external read or system catalog.',
      recovery:
        'Call drought_dataframe_describe and query only its staged tables with drought_dataframe_query.',
      thrownBy: 'service',
    },
    {
      reason: 'dataset_too_large',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Combined source metadata exceeds the query response budget.',
      recovery:
        'Re-stage the needed dataset in a new canvas with drought_get_timeseries or drought_compare_areas, omitting canvas_id, then query the returned token.',
      thrownBy: 'service',
    },
    {
      reason: 'query_row_too_large',
      code: JsonRpcErrorCode.ValidationError,
      when: 'One projected row cannot fit a complete response.',
      recovery:
        'Inspect columns with drought_dataframe_describe and project smaller values in drought_dataframe_query.',
      thrownBy: 'service',
    },
    {
      reason: 'staging_busy',
      code: JsonRpcErrorCode.RateLimited,
      when: 'Two queries are already active in this process.',
      recovery: 'Retry drought_dataframe_query after the active analytical queries finish.',
      retryable: true,
      thrownBy: 'service',
    },
  ],
  async handler(input, ctx) {
    const limit = Math.min(input.limit, 500);
    ctx.enrich({
      effectiveLimit: limit,
      ...(input.limit > limit
        ? {
            limitNotice: `Requested limit ${input.limit} was clamped to ${limit}; follow next_offset for every remaining row.`,
          }
        : {}),
    });
    const result = await dataframeService.query({ ...input, limit }, ctx);
    if (result.has_more)
      ctx.enrich.truncated({
        shown: result.returnedCount,
        cap: limit,
        guidance: 'Continue with next_offset and identical SQL to retrieve the remaining rows.',
      });
    if (!result.returnedCount)
      ctx.enrich.notice(
        `No rows match; inspect drought_dataframe_describe with canvas_id ${input.canvas_id}.`,
      );
    return result;
  },
  format: (result) => [{ type: 'text', text: renderFields(result) }],
});
