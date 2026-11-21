/**
 * @fileoverview Retrieve complete joined weekly drought observations.
 * @module mcp-server/tools/definitions/drought-get-timeseries.tool
 */
import { tool, z } from '@cyanheads/mcp-ts-core';
import { CanvasIdSchema } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  effectiveLimit,
  producerPageLimit,
  producerPageMaximum,
} from '../../../config/page-limits.js';
import { dataframeService } from '../../../services/drought/dataframe-service.js';
import { droughtService } from '../../../services/drought/drought-service.js';
import { pageProducer } from '../../../services/drought/producer-pagination.js';
import {
  AreaSchema,
  GeographySchema,
  MetricSchema,
  ProvenanceSchema,
  StatisticsTypeSchema,
} from '../../../services/drought/types.js';
import { renderWorkflow } from '../../../services/drought/workflow-format.js';
import {
  MetadataPagesSchema,
  MissingSchema,
  ProducerCursorSchema,
  producerPageFields,
  RangeSchema,
  StageHandleSchema,
  SummarySchema,
  WeeklyRowSchema,
} from '../../../services/drought/workflow-schema.js';

/** Weekly metric and authoritative DSCI with disclosed missing observations. */
export const droughtGetTimeseriesTool = tool('drought_get_timeseries', {
  title: 'Get weekly drought observations',
  description:
    'Get weekly drought metrics and experimental DSCI for 1–100 explicit areas sharing one geography type and HUC level. Resolve identifiers with drought_list_reference. Dates select inclusive Tuesday map weeks. Missing values remain null; summaries include every tied peak. Supply limit for an exact first page and continue in the staged table, or pass nextCursor with the same filters when analytics is disabled. Without a limit or cursor, disabled analytics returns complete series within acquisition limits.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z.object({
    areas: z.array(GeographySchema).min(1).max(100).describe('Explicit homogeneous geographies.'),
    startDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .describe('First requested calendar date, YYYY-MM-DD.'),
    endDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .describe('Last requested calendar date, YYYY-MM-DD.'),
    metric: MetricSchema.default('area_percent').describe(
      'Measure; population supports US, state and county only and carries estimation assumptions in provenance.populationInterpretation.',
    ),
    statisticsType: StatisticsTypeSchema.default('cumulative').describe(
      'Overlapping cumulative or exclusive categorical buckets.',
    ),
    limit: producerPageLimit('Omit for the size-based staged preview or complete inline rows.'),
    cursor: ProducerCursorSchema,
    canvas_id: z
      .union([z.literal(''), CanvasIdSchema])
      .optional()
      .describe('Canvas token from a previous drought producer to reuse when staging.'),
  }),
  output: z.object({
    guidance: z.string().optional().describe('Geography selection or coverage guidance.'),
    metadata_pages: MetadataPagesSchema.optional().describe(
      'Present only when complete metadata requires automatic continuation.',
    ),
    areas: z.array(AreaSchema).describe('Resolved deduplicated areas.'),
    requestedRange: RangeSchema.describe('Original requested dates.'),
    effectiveRange: RangeSchema.nullable().describe('Published coverage intersection.'),
    latestMapDate: z.string().describe('Latest map actually published.'),
    metric: MetricSchema.describe('Selected metric.'),
    statisticsType: StatisticsTypeSchema.describe('Selected representation.'),
    unit: z.string().describe('Bucket unit.'),
    rows: z
      .array(WeeklyRowSchema)
      .describe('Complete inline rows, staged preview, or inline page.'),
    rowCount: z.number().int().describe('Complete observation count.'),
    missingAreas: z.array(AreaSchema).describe('Areas without metric observations.'),
    missingObservations: z.array(MissingSchema).describe('Missing metric and DSCI dates.'),
    summary: z.array(SummarySchema).describe('Full-data area summaries.'),
    staging: StageHandleSchema.nullable().describe('Complete analytical table when staged.'),
    provenance: ProvenanceSchema.describe('Actual sources and attribution.'),
    ...producerPageFields,
  }),
  enrichment: {
    notice: z
      .string()
      .optional()
      .describe('Geography selection, coverage or missing-data guidance.'),
    effectiveLimit: z.number().int().optional().describe('Effective page size when paging.'),
    limitNotice: z.string().optional().describe('Disclosure when the requested limit was clamped.'),
    totalCount: z.number().int().optional().describe('Complete observation count when paging.'),
  },
  errors: [
    {
      reason: 'invalid_cursor',
      code: JsonRpcErrorCode.ValidationError,
      when: 'An inline snapshot cursor is malformed, expired, foreign, or does not match the filters or provider.',
      recovery: 'Restart drought_get_timeseries without cursor to obtain a fresh result.',
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
      when: 'A geography name cannot resolve.',
      recovery:
        'Call drought_list_reference for the geography type to find a supported identifier.',
      thrownBy: 'service',
    },
    {
      reason: 'invalid_area',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Identifier or homogeneous area combination is invalid.',
      recovery:
        'Call drought_list_reference with topic area_types and supply the documented geography format.',
      thrownBy: 'service',
    },
    {
      reason: 'unsupported_metric',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Population is requested for an unsupported geography.',
      recovery:
        'Call drought_list_reference with topic area_types, then use an available metric in drought_get_timeseries.',
      thrownBy: 'service',
    },
    {
      reason: 'invalid_date_range',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Dates are impossible or reversed.',
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
      recovery: 'Narrow dates or areas in drought_get_timeseries and retry the smaller request.',
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
      recovery: 'Re-run drought_get_timeseries to stage data and use the returned canvas_id.',
      thrownBy: 'service',
    },
    {
      reason: 'canvas_capacity_exhausted',
      code: JsonRpcErrorCode.RateLimited,
      when: 'The analytical provider cannot mint another canvas.',
      recovery:
        'Reuse a canvas_id already returned by drought_get_timeseries, or retry after expiry.',
      retryable: true,
      thrownBy: 'service',
    },
  ],
  async handler(input, ctx) {
    const limit =
      input.limit === undefined
        ? undefined
        : effectiveLimit(input.limit, producerPageMaximum, 'drought_get_timeseries', ctx);
    const { result, effective } = await pageProducer(
      'timeseries',
      input,
      limit,
      ctx,
      () => droughtService.timeseriesBinding(input),
      () =>
        dataframeService.withAdmission(ctx, (stage) =>
          droughtService.timeseries({ ...input, limit }, ctx.signal, stage),
        ),
    );
    if (effective !== undefined) {
      ctx.enrich.total(result.rowCount);
      ctx.enrich({
        effectiveLimit: effective,
        ...(input.limit !== undefined && limit !== undefined && input.limit > limit
          ? {
              limitNotice: `Requested limit ${input.limit} was clamped to ${limit}.${result.staging && result.rows.length < result.rowCount ? ' Use the staged table for every remaining row.' : result.hasMore ? ' Pass nextCursor for every remaining row.' : ''}`,
            }
          : {}),
      });
    }
    const missing = !result.rowCount
      ? 'No USDM observations are available for the resolved areas and published weeks; call drought_get_timeseries with a different range or drought_list_reference(topic=coverage).'
      : result.missingObservations.length
        ? 'Missing observations are disclosed by component and date; null DSCI does not mean zero drought.'
        : undefined;
    const notice = [result.guidance, missing].filter(Boolean).join(' ');
    if (notice) ctx.enrich.notice(notice);
    return result;
  },
  format: (result) => [{ type: 'text', text: renderWorkflow(result) }],
});
