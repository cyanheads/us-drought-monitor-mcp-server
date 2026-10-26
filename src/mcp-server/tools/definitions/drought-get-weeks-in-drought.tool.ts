/**
 * @fileoverview Page authoritative county drought duration statistics.
 * @module mcp-server/tools/definitions/drought-get-weeks-in-drought.tool
 */
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { effectiveLimit, pageLimit } from '../../../config/page-limits.js';
import { droughtService } from '../../../services/drought/drought-service.js';
import { AreaSchema, ProvenanceSchema } from '../../../services/drought/types.js';
import { renderWorkflow } from '../../../services/drought/workflow-format.js';
import { RangeSchema, WeeksRowSchema } from '../../../services/drought/workflow-schema.js';
/** County durations retain observed window-bounded upstream streak boundaries. */
export const droughtGetWeeksInDroughtTool = tool('drought_get_weeks_in_drought', {
  title: 'Get county weeks in drought',
  description:
    'Get authoritative consecutive streaks or non-consecutive week counts when any county area meets the selected drought category or worse. Supply states or one county, never both; omitted selectors mean supported nationwide counties. Counts are duration statistics, not program eligibility. Follow nextCursor with unchanged filters within five minutes.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    startDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .describe('First requested date, YYYY-MM-DD.'),
    endDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .describe('Last requested date, YYYY-MM-DD.'),
    minCategory: z
      .preprocess(
        (value) => (typeof value === 'string' ? value.toUpperCase() : value),
        z.enum(['D0', 'D1', 'D2', 'D3', 'D4']),
      )
      .describe('Minimum drought category.'),
    minWeeks: z
      .number()
      .int()
      .min(1)
      .describe('Minimum weeks, no more than requested inclusive map weeks.'),
    mode: z
      .enum(['consecutive', 'non_consecutive'])
      .default('consecutive')
      .describe('Window-bounded consecutive streaks or qualifying week counts.'),
    states: z
      .array(z.string().max(200))
      .min(1)
      .max(54)
      .optional()
      .describe('Exact state postal, FIPS or full names; mutually exclusive with county.'),
    county: z
      .string()
      .max(200)
      .optional()
      .describe(
        'County FIPS or exact/unique suffix-free county name, state; mutually exclusive with states.',
      ),
    cursor: z
      .string()
      .max(2048)
      .optional()
      .describe('Continuation returned with identical filters.'),
    limit: pageLimit(25, 200, 'rows per page'),
  }),
  output: z.object({
    guidance: z
      .string()
      .optional()
      .describe('Coverage guidance for known legacy Connecticut counties.'),
    mode: z.enum(['consecutive', 'non_consecutive']).describe('Selected duration mode.'),
    minCategory: z.enum(['D0', 'D1', 'D2', 'D3', 'D4']).describe('Minimum category.'),
    minWeeks: z.number().int().describe('Minimum qualifying map weeks.'),
    thresholdRule: z
      .literal('any_area_at_or_above')
      .describe('County qualifies if any area meets category or worse.'),
    states: z.array(z.string()).describe('Resolved supported state postal codes.'),
    county: AreaSchema.nullable().describe('Resolved exact county or null.'),
    requestedRange: RangeSchema.describe('Original dates.'),
    effectiveRange: RangeSchema.nullable().describe('Published map-week coverage intersection.'),
    latestMapDate: z.string().describe('Latest actually published map.'),
    rows: z.array(WeeksRowSchema).describe('Complete authoritative rows on this page.'),
    totalCount: z.number().int().describe('Full filtered result count.'),
    nextCursor: z.string().nullable().describe('Query-bound continuation, or null.'),
    hasMore: z.boolean().describe('Another page remains.'),
    provenance: ProvenanceSchema.describe('Actual sources and attribution.'),
  }),
  enrichment: {
    notice: z.string().optional().describe('Empty threshold or coverage guidance.'),
    effectiveLimit: z
      .number()
      .int()
      .optional()
      .describe('Effective page ceiling after clamping to 200.'),
    limitNotice: z.string().optional().describe('Disclosure when the requested limit was clamped.'),
  },
  errors: [
    {
      reason: 'upstream_request_rejected',
      code: JsonRpcErrorCode.ValidationError,
      when: 'USDM rejects a selector or date request.',
      recovery:
        'Call drought_list_reference for supported identifiers and coverage, then retry with those selectors and dates.',
      thrownBy: 'service',
    },
    {
      reason: 'ambiguous_area',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Several exact county names match.',
      recovery: 'Call drought_list_reference for counties and supply its exact identifier.',
      thrownBy: 'service',
    },
    {
      reason: 'unknown_area',
      code: JsonRpcErrorCode.NotFound,
      when: 'A county or state cannot resolve.',
      recovery:
        'Call drought_list_reference for the geography type to find a supported identifier.',
      thrownBy: 'service',
    },
    {
      reason: 'invalid_area',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Identifier or selector combination is invalid.',
      recovery:
        'Call drought_list_reference with topic area_types and supply states or one county.',
      thrownBy: 'service',
    },
    {
      reason: 'invalid_date_range',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Dates are impossible, reversed or shorter than minWeeks.',
      recovery:
        'Use ordered calendar dates within drought_list_reference coverage; lower minWeeks or widen startDate and endDate when the threshold exceeds the window.',
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
      when: 'Complete duration acquisition or cache exceeds resource quotas.',
      recovery: 'Narrow dates or states in drought_get_weeks_in_drought and retry.',
      thrownBy: 'service',
    },
    {
      reason: 'upstream_shape_invalid',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Upstream durations are malformed or duplicate.',
      recovery:
        'Retry the same drought tool later; call drought_list_reference with topic coverage to check supported data.',
      thrownBy: 'service',
    },
    {
      reason: 'invalid_cursor',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Continuation is malformed, expired or filters changed.',
      recovery: 'Restart drought_get_weeks_in_drought without cursor and retain the same filters.',
      thrownBy: 'service',
    },
  ],
  async handler(input, ctx) {
    const limit = effectiveLimit(input.limit, 200, 'drought_get_weeks_in_drought', ctx);
    ctx.enrich({
      effectiveLimit: limit,
      ...(input.limit > limit
        ? {
            limitNotice: `Requested limit ${input.limit} was clamped to ${limit}; follow cursor for every remaining row.`,
          }
        : {}),
    });
    const result = await droughtService.weeks({ ...input, limit }, ctx.signal);
    if (result.guidance) ctx.enrich.notice(result.guidance);
    else if (!result.totalCount)
      ctx.enrich.notice(
        result.effectiveRange
          ? 'No counties meet this threshold; call drought_get_weeks_in_drought with a lower minWeeks or minCategory, or a wider date range.'
          : 'No published map weeks overlap this range; call drought_get_weeks_in_drought with the coverage shown by drought_list_reference(topic=coverage).',
      );
    return result;
  },
  format: (result) => [{ type: 'text', text: renderWorkflow(result) }],
});
