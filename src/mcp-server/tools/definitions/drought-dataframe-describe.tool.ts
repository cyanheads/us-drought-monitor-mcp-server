/**
 * @fileoverview Inspect one caller-supplied analytical canvas and its table metadata.
 * @module mcp-server/tools/definitions/drought-dataframe-describe.tool
 */
import { tool, z } from '@cyanheads/mcp-ts-core';
import { CANVAS_IDENTIFIER_REGEX, CanvasIdSchema } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { dataframeService } from '../../../services/drought/dataframe-service.js';
import { renderFields } from '../../../services/drought/format.js';
import { METADATA_FIELDS } from '../../../services/drought/metadata-pages.js';

/** Describe bounded schemas, or full metadata for one named table. */
export const droughtDataframeDescribeTool = tool('drought_dataframe_describe', {
  title: 'Describe staged drought tables',
  description:
    'Inspect tables and column types in a canvas_id returned by drought_get_timeseries or drought_compare_areas. Supply table_name for its complete source query, area/date/metric, units, missing-data and provenance metadata. Omit table_name for bounded schema summaries. Tokens are shareable capabilities and expire; this tool never lists other tokens.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  input: z.object({
    canvas_id: CanvasIdSchema.describe('Token returned by a drought producer.'),
    table_name: z
      .union([
        z.literal(''),
        z
          .string()
          .regex(CANVAS_IDENTIFIER_REGEX)
          .describe('SQL identifier of an existing staged table.'),
      ])
      .optional()
      .describe('Table name from the stage handle; omit for schema summaries.'),
    metadata_field: z
      .enum(METADATA_FIELDS)
      .optional()
      .describe('Retained metadata collection to page; requires table_name.'),
    metadata_offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe('Items to skip in the retained metadata snapshot.'),
    metadata_limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(20)
      .describe('Maximum metadata items, further bounded by response budgets.'),
  }),
  output: z.object({
    canvas_id: z.string().describe('Supplied canvas token.'),
    expires_at: z.string().describe('Actual canvas expiry.'),
    metadata_page: z
      .object({
        field: z.enum(METADATA_FIELDS).describe('Requested metadata collection.'),
        items: z
          .array(z.unknown())
          .describe('Unchanged complete items from the retained snapshot.'),
        total: z.number().int().describe('Total collection items.'),
        offset: z.number().int().describe('Requested item offset.'),
        next_offset: z.number().int().nullable().describe('Next offset, or null at the end.'),
      })
      .optional()
      .describe('One complete bounded metadata page for a named table.'),
    tables: z
      .array(
        z
          .object({
            name: z.string().describe('Table name.'),
            kind: z.enum(['table', 'view']).describe('Stored object kind.'),
            rowCount: z.number().int().describe('Complete table row count.'),
            columns: z
              .array(
                z
                  .object({
                    name: z.string().describe('Column name.'),
                    type: z.string().describe('SQL type.'),
                    nullable: z.boolean().optional().describe('Whether NULL values are permitted.'),
                  })
                  .describe('One SQL column and its nullability.'),
              )
              .describe('Explicit SQL schema.'),
            expiresAt: z.string().nullable().describe('Actual per-table expiry, or null.'),
            metadata: z
              .record(z.string(), z.unknown())
              .describe('Complete producer metadata for a requested table; empty for summaries.'),
          })
          .describe('One table in the supplied canvas with its explicit schema.'),
      )
      .describe('Tables only in this specified canvas.'),
  }),
  errors: [
    {
      reason: 'invalid_metadata_page',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Metadata pagination lacks a named table or uses an unavailable collection.',
      recovery:
        'Supply table_name and a metadata_field from the staged time-series response, with a nonnegative offset.',
      thrownBy: 'service',
    },
    {
      reason: 'canvas_unavailable',
      code: JsonRpcErrorCode.ConfigurationError,
      when: 'Analytical provider is unavailable.',
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
      when: 'The requested table is absent.',
      recovery:
        'Call drought_dataframe_describe with the same canvas_id, or re-stage with drought_get_timeseries or drought_compare_areas.',
      thrownBy: 'service',
    },
    {
      reason: 'dataset_too_large',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The complete metadata cannot fit the response.',
      recovery:
        'Narrow dates or areas in drought_get_timeseries or drought_compare_areas and stage a smaller table.',
      thrownBy: 'service',
    },
  ],
  enrichment: {
    totalCount: z
      .number()
      .int()
      .optional()
      .describe('Total items in the requested retained metadata collection.'),
  },
  async handler(input, ctx) {
    const result = await dataframeService.describe(
      {
        canvas_id: input.canvas_id,
        ...(input.table_name ? { table_name: input.table_name } : {}),
        ...(input.metadata_field ? { metadata_field: input.metadata_field } : {}),
        metadata_offset: input.metadata_offset,
        metadata_limit: input.metadata_limit,
      },
      ctx,
    );
    if (result.metadata_page) ctx.enrich.total(result.metadata_page.total);
    return result;
  },
  format: (result) => [{ type: 'text', text: renderFields(result) }],
});
