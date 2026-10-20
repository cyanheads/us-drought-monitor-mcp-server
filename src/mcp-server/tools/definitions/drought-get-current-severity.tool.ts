/**
 * @fileoverview Exact published-week drought snapshot and authoritative DSCI changes.
 * @module mcp-server/tools/definitions/drought-get-current-severity.tool
 */
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { droughtService } from '../../../services/drought/drought-service.js';
import { AreaSchema, GeographySchema, ProvenanceSchema } from '../../../services/drought/types.js';
import { renderWorkflow } from '../../../services/drought/workflow-format.js';
import {
  CategoricalBucketsSchema,
  CumulativeBucketsSchema,
} from '../../../services/drought/workflow-schema.js';

const ChangeSchema = z.object({
  baselineMapDate: z.string().describe('Exact baseline Tuesday.'),
  baselineDsci: z.number().nullable().describe('Upstream baseline index or null.'),
  delta: z.number().nullable().describe('Current minus baseline DSCI index.'),
  status: z
    .enum(['available', 'before_coverage', 'missing'])
    .describe('Availability of exact delta.'),
});
/** Snapshot joins only the same canonical area and exact map date. */
export const droughtGetCurrentSeverityTool = tool('drought_get_current_severity', {
  title: 'Get a drought severity snapshot',
  description:
    'Get current or dated drought severity, cumulative and categorical area percentages, area square miles, supported population counts and experimental upstream DSCI. Resolve identifiers with drought_list_reference. DSCI changes use exactly 4 and 52 weeks earlier; missing observations remain null. US selects both CONUS and Total.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    area: GeographySchema.describe('One exact geography selector.'),
    date: z
      .string()
      .max(10)
      .optional()
      .describe('Calendar date YYYY-MM-DD; defaults to latest published map.'),
  }),
  output: z.object({
    found: z.boolean().describe('At least one complete severity snapshot exists.'),
    requestedArea: GeographySchema.describe('Original selector.'),
    resolvedAreas: z.array(AreaSchema).describe('Resolved canonical areas.'),
    requestedDate: z.string().nullable().describe('Requested date, or null for latest.'),
    effectiveMapDate: z.string().nullable().describe('Containing Tuesday.'),
    latestMapDate: z.string().describe('Latest actually published map.'),
    availableFrom: z.string().describe('First published map.'),
    snapshots: z
      .array(
        AreaSchema.extend({
          mapDate: z.string().describe('Exact map date.'),
          validStart: z.string().describe('Full Tuesday validity start.'),
          validEnd: z.string().describe('Full Monday validity end.'),
          areaPercentCumulative: CumulativeBucketsSchema.describe('Cumulative area percent.'),
          areaPercentCategorical: CategoricalBucketsSchema.describe('Exclusive area percent.'),
          areaSqMilesCumulative: CumulativeBucketsSchema.describe('Cumulative area square miles.'),
          populationCountCumulative: CumulativeBucketsSchema.nullable().describe(
            'Cumulative population in people, or null.',
          ),
          populationStatus: z
            .enum(['available', 'unsupported', 'missing'])
            .describe('Population support and observation status.'),
          dsci: z.number().nullable().describe('Experimental upstream index, 0–500.'),
          dsciStatus: z.enum(['available', 'missing']).describe('Index availability.'),
          dsciChange4Weeks: ChangeSchema.describe('Exact 28-day baseline change.'),
          dsciChange52Weeks: ChangeSchema.describe('Exact 364-day baseline change.'),
        }).describe('Exact-week severity components and authoritative index changes.'),
      )
      .describe('Complete required severity components for each area.'),
    guidance: z.string().nullable().describe('Missing-data or coverage guidance.'),
    provenance: ProvenanceSchema.describe('Actual sources and attribution.'),
  }),
  enrichment: { notice: z.string().optional().describe('Missing observation guidance.') },
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
      when: 'Identifier shape is invalid.',
      recovery:
        'Call drought_list_reference with topic area_types and supply the documented geography format.',
      thrownBy: 'service',
    },
    {
      reason: 'invalid_date_range',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The date is not a real calendar date.',
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
      reason: 'upstream_shape_invalid',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Upstream data is malformed, duplicate or outside scope.',
      recovery:
        'Retry the same drought tool later; call drought_list_reference with topic coverage to check supported data.',
      thrownBy: 'service',
    },
    {
      reason: 'dataset_too_large',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The complete snapshot exceeds bounded response budgets.',
      recovery: 'Call drought_get_current_severity for one smaller geography selector and retry.',
      thrownBy: 'service',
    },
  ],
  async handler(input, ctx) {
    const result = await droughtService.current(input, ctx.signal);
    if (result.guidance) ctx.enrich.notice(result.guidance);
    return result;
  },
  format: (result) => [{ type: 'text', text: renderWorkflow(result) }],
});
