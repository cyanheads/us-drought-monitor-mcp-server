/**
 * @fileoverview Compare complete state or county severity populations.
 * @module mcp-server/tools/definitions/drought-compare-areas.tool
 */
import { tool, z } from '@cyanheads/mcp-ts-core';
import { CanvasIdSchema } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  comparisonPreviewLimit,
  effectiveLimit,
  producerPageLimit,
  producerPageMaximum,
} from '../../../config/page-limits.js';
import { dataframeService } from '../../../services/drought/dataframe-service.js';
import { droughtService } from '../../../services/drought/drought-service.js';
import { pageProducer } from '../../../services/drought/producer-pagination.js';
import { AreaSchema, ProvenanceSchema } from '../../../services/drought/types.js';
import { renderWorkflow } from '../../../services/drought/workflow-format.js';
import {
  ComparisonRowSchema,
  ProducerCursorSchema,
  producerPageFields,
  StageHandleSchema,
} from '../../../services/drought/workflow-schema.js';

const shared = {
  date: z
    .string()
    .max(10)
    .regex(/^(?:|\d{4}-\d{2}-\d{2})$/)
    .optional()
    .describe('Target calendar date; defaults to latest published map.'),
  baselineDate: z
    .string()
    .max(10)
    .regex(/^(?:|\d{4}-\d{2}-\d{2})$/)
    .optional()
    .describe('Optional exact baseline date, no later than target.'),
  metric: z
    .enum(['dsci', 'd2_d4', 'd3_d4'])
    .default('dsci')
    .describe('Experimental DSCI or cumulative area percentage.'),
  direction: z
    .enum(['asc', 'desc'])
    .default('desc')
    .describe('Order by severity or baseline change.'),
  limit: producerPageLimit(
    `Default staged preview is up to ${comparisonPreviewLimit} rows; without analytics omission returns all rows.`,
  ),
  cursor: ProducerCursorSchema,
  canvas_id: z
    .union([z.literal(''), CanvasIdSchema])
    .optional()
    .describe('Canvas token from an earlier drought producer to reuse.'),
};
/** Rank actual severity or exact change, preserving ties and missing sides. */
export const droughtCompareAreasTool = tool('drought_compare_areas', {
  title: 'Compare drought severity across areas',
  description:
    'Rank all supported states, or counties within an optional state, on one published map. Omit state for nationwide supported counties. With baselineDate, rank target minus exact baseline; missing sides are excluded explicitly. Equal values share competition rank. Supply limit for an exact first page and continue in the staged table, or pass nextCursor with the same filters when analytics is disabled. Without a limit or cursor, disabled analytics returns complete rankings within acquisition limits.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z.discriminatedUnion('scope', [
    z.object({ scope: z.literal('states').describe('All supported states.'), ...shared }).strict(),
    z
      .object({
        scope: z.literal('counties').describe('Supported counties.'),
        state: z
          .string()
          .max(200)
          .optional()
          .describe('Exact state postal, FIPS or full name; omitted means nationwide.'),
        ...shared,
      })
      .strict(),
  ]),
  output: z.object({
    scope: z.enum(['states', 'counties']).describe('Compared geography scope.'),
    state: z.string().nullable().describe('Resolved county state or null.'),
    includedStates: z.array(z.string()).describe('Actual supported included state postal codes.'),
    metric: z.enum(['dsci', 'd2_d4', 'd3_d4']).describe('Compared severity measure.'),
    unit: z.enum(['index', 'percent']).describe('Severity unit.'),
    changeUnit: z.enum(['index', 'percentage_points']).describe('Difference unit.'),
    targetMapDate: z.string().describe('Exact target Tuesday.'),
    baselineMapDate: z.string().nullable().describe('Exact baseline Tuesday or null.'),
    rows: z
      .array(ComparisonRowSchema)
      .describe('Complete ranking, staged preview, or inline page.'),
    comparedCount: z.number().int().describe('Complete comparable population.'),
    excludedAreas: z
      .array(
        z
          .object({
            area: AreaSchema.describe('Excluded geography.'),
            missing: z.array(z.enum(['target', 'baseline'])).describe('Missing comparison sides.'),
          })
          .describe('One excluded area and its missing comparison sides.'),
      )
      .describe('Every area lacking a required value.'),
    staging: StageHandleSchema.nullable().describe('Complete ranking table when staged.'),
    provenance: ProvenanceSchema.describe('Actual sources and attribution.'),
    ...producerPageFields,
  }),
  enrichment: {
    effectiveLimit: z
      .number()
      .int()
      .optional()
      .describe('Effective page size, or default preview ceiling without an explicit limit.'),
    limitNotice: z.string().optional().describe('Disclosure when the requested limit was clamped.'),
    notice: z.string().optional().describe('Empty comparison or preview continuation guidance.'),
    totalCount: z
      .number()
      .int()
      .describe('Complete comparable population before preview selection.'),
  },
  errors: [
    {
      reason: 'invalid_cursor',
      code: JsonRpcErrorCode.ValidationError,
      when: 'An inline snapshot cursor is malformed, expired, foreign, or does not match the filters or provider.',
      recovery: 'Restart drought_compare_areas without cursor to obtain a fresh result.',
      thrownBy: 'service',
    },
    {
      reason: 'upstream_request_rejected',
      code: JsonRpcErrorCode.ValidationError,
      when: 'USDM rejects a selector or date request.',
      recovery:
        'Call drought_list_reference for supported identifiers and coverage, then retry with those selectors and dates.',
      thrownBy: 'service',
    },
    {
      reason: 'staging_busy',
      code: JsonRpcErrorCode.RateLimited,
      when: 'The acquisition queue is full, the admission wait expired, or the tenant ledger is full.',
      recovery: 'Retry after active acquisition workflows finish.',
      retryable: true,
      thrownBy: 'service',
    },
    {
      reason: 'ambiguous_area',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Several exact names match.',
      recovery:
        'Call drought_list_reference for the geography type and supply its exact identifier.',
      thrownBy: 'service',
    },
    {
      reason: 'unknown_area',
      code: JsonRpcErrorCode.NotFound,
      when: 'The state name cannot resolve.',
      recovery: 'Call drought_list_reference for states to find a supported identifier.',
      thrownBy: 'service',
    },
    {
      reason: 'invalid_area',
      code: JsonRpcErrorCode.ValidationError,
      when: 'State is used with the wrong scope.',
      recovery: 'Call drought_compare_areas with county scope when supplying a state filter.',
      thrownBy: 'service',
    },
    {
      reason: 'invalid_date_range',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Dates are impossible or baseline follows target.',
      recovery:
        'Call drought_list_reference with topic coverage, then retry this tool with ordered calendar dates.',
      thrownBy: 'service',
    },
    {
      reason: 'publication_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'No latest publication is available.',
      recovery:
        'Retry drought_get_current_severity later; call drought_list_reference with topic coverage for the publication schedule.',
      retryable: true,
      thrownBy: 'service',
    },
    {
      reason: 'dataset_too_large',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The complete request exceeds acquisition or retained-data quotas.',
      recovery: 'Narrow county scope to one state in drought_compare_areas and retry.',
      thrownBy: 'service',
    },
    {
      reason: 'upstream_shape_invalid',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Upstream data is malformed, duplicate or outside scope.',
      recovery:
        'Retry the same drought tool later; call drought_list_reference with topic coverage to check supported data.',
      thrownBy: 'service',
    },
    {
      reason: 'canvas_unavailable',
      code: JsonRpcErrorCode.ConfigurationError,
      when: 'An explicit canvas token requires an unavailable analytical provider.',
      recovery:
        'Use the npm or Docker analytical installation with @duckdb/node-api and CANVAS_PROVIDER_TYPE=duckdb; MCPB supports inline results only.',
      thrownBy: 'service',
    },
    {
      reason: 'staging_capacity_exhausted',
      code: JsonRpcErrorCode.RateLimited,
      when: 'Retained analytical capacity is exhausted.',
      recovery: 'Reuse a returned canvas_id with a free table slot, or retry after table expiry.',
      retryable: true,
      thrownBy: 'service',
    },
    {
      reason: 'canvas_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The supplied canvas is absent or expired.',
      recovery: 'Re-run drought_compare_areas to stage data and use the returned canvas_id.',
      thrownBy: 'service',
    },
    {
      reason: 'canvas_capacity_exhausted',
      code: JsonRpcErrorCode.RateLimited,
      when: 'The provider cannot mint another canvas.',
      recovery:
        'Reuse a canvas_id already returned by drought_compare_areas, or retry after expiry.',
      retryable: true,
      thrownBy: 'service',
    },
  ],
  async handler(input, ctx) {
    const limit =
      input.limit === undefined
        ? undefined
        : effectiveLimit(input.limit, producerPageMaximum, 'drought_compare_areas', ctx);
    const { result, effective } = await pageProducer(
      'comparison',
      input,
      limit,
      ctx,
      () => droughtService.comparisonBinding(input),
      () =>
        dataframeService.withAdmission(ctx, (stage) =>
          droughtService.compare({ ...input, limit }, ctx.signal, stage),
        ),
    );
    ctx.enrich({
      effectiveLimit: effective ?? comparisonPreviewLimit,
      ...(input.limit !== undefined && limit !== undefined && input.limit > limit
        ? {
            limitNotice: `Requested limit ${input.limit} was clamped to ${limit}.${result.staging && result.rows.length < result.comparedCount ? ' Use the staged table for every remaining row.' : result.hasMore ? ' Pass nextCursor for every remaining row.' : ''}`,
          }
        : {}),
    });
    ctx.enrich.total(result.comparedCount);
    if (!result.comparedCount)
      ctx.enrich.notice(
        'No comparable published observations exist for these dates; call drought_compare_areas with dates inside the coverage shown by drought_list_reference(topic=coverage).',
      );
    return result;
  },
  format: (result) => [{ type: 'text', text: renderWorkflow(result) }],
});
