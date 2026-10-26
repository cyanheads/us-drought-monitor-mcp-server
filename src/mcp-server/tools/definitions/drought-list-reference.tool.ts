/**
 * @fileoverview Browse complete USDM reference families with local filtering and paging.
 * @module mcp-server/tools/definitions/drought-list-reference.tool
 */
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { effectiveLimit, pageLimit } from '../../../config/page-limits.js';
import { renderFields } from '../../../services/drought/format.js';
import { listReference } from '../../../services/drought/reference-data.js';
import {
  ReferenceRecordSchema,
  ReferenceTopicSchema,
  SourceMetadataSchema,
} from '../../../services/drought/reference-schema.js';
import { HucLevelSchema, ProvenanceSchema } from '../../../services/drought/types.js';

/** Offline reference discovery, never a live publication-date claim. */
export const droughtListReferenceTool = tool('drought_list_reference', {
  title: 'Look up drought reference data',
  description:
    'Look up drought categories, DSCI formulas, metric support, publication coverage and exact geography identifiers. Filter complete families by nameContains before paging. Use state for counties or climate_divisions; huc requires hucLevel 2, 4, 6 or 8 and accepts a shorter parentHuc. Follow nextCursor with the same filters to browse every match.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  input: z.object({
    topic: ReferenceTopicSchema.describe(
      'Reference family to browse; river_forecast_centers provides official RFC codes and names.',
    ),
    nameContains: z
      .string()
      .max(200)
      .optional()
      .describe('All normalized tokens must appear in the reference name.'),
    state: z
      .string()
      .max(200)
      .optional()
      .describe(
        'County or climate-division filter: exact state postal code, two-digit FIPS or full name.',
      ),
    hucLevel: HucLevelSchema.optional().describe('Required for huc; exact identifier width.'),
    parentHuc: z
      .string()
      .max(6)
      .optional()
      .describe('Existing parent HUC at level 2, 4 or 6, shorter than hucLevel; blank is omitted.'),
    cursor: z
      .string()
      .max(2048)
      .optional()
      .describe('Continuation cursor from the previous page with the same filters.'),
    limit: pageLimit(25, 200, 'records per page'),
  }),
  output: z.object({
    topic: ReferenceTopicSchema.describe('Selected reference family.'),
    records: z.array(ReferenceRecordSchema).describe('Complete records on this page.'),
    totalCount: z.number().int().describe('Count after filtering, before pagination.'),
    nextCursor: z.string().nullable().describe('Continuation with identical filters, or null.'),
    hasMore: z.boolean().describe('Whether another page remains.'),
    bundleVersion: z.string().describe('Generated reference bundle version.'),
    sourceMetadata: z.array(SourceMetadataSchema).describe('Source vintages and SHA-256 evidence.'),
    provenance: ProvenanceSchema.describe('Source attribution and acquisition time.'),
  }),
  enrichment: {
    notice: z.string().optional().describe('Guidance when no names match.'),
    effectiveLimit: z
      .number()
      .int()
      .optional()
      .describe('Effective page ceiling after clamping to 200.'),
    limitNotice: z.string().optional().describe('Disclosure when the requested limit was clamped.'),
  },
  errors: [
    {
      reason: 'ambiguous_area',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Multiple exact normalized names match.',
      recovery:
        'Call drought_list_reference for the geography type and supply its exact identifier.',
      thrownBy: 'service',
    },
    {
      reason: 'unknown_area',
      code: JsonRpcErrorCode.NotFound,
      when: 'The county state filter cannot resolve.',
      recovery: 'Call drought_list_reference for states to find a supported identifier.',
      thrownBy: 'service',
    },
    {
      reason: 'invalid_cursor',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The cursor is malformed or filters changed.',
      recovery: 'Restart drought_list_reference without cursor and retain the same filters.',
      thrownBy: 'service',
    },
    {
      reason: 'invalid_reference_filter',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Filters do not belong to the selected topic.',
      recovery:
        'Call drought_list_reference with topic area_types and use filters belonging to the selected topic.',
      thrownBy: 'service',
    },
  ],
  handler(input, ctx) {
    ctx.signal.throwIfAborted();
    const limit = effectiveLimit(input.limit, 200, 'drought_list_reference', ctx);
    ctx.enrich({
      effectiveLimit: limit,
      ...(input.limit > limit
        ? {
            limitNotice: `Requested limit ${input.limit} was clamped to ${limit}; follow nextCursor for every remaining record.`,
          }
        : {}),
    });
    const result = listReference({
      topic: input.topic,
      limit,
      ...(input.nameContains ? { nameContains: input.nameContains } : {}),
      ...(input.state ? { state: input.state } : {}),
      ...(input.cursor ? { cursor: input.cursor } : {}),
      ...(input.hucLevel ? { hucLevel: input.hucLevel } : {}),
      ...(input.parentHuc ? { parentHuc: input.parentHuc } : {}),
    });
    if (!result.totalCount)
      ctx.enrich.notice(
        'No reference names match these filters; call drought_list_reference with the same topic and without nameContains to browse.',
      );
    return result;
  },
  format: (result) => [{ type: 'text', text: renderFields(result) }],
});
