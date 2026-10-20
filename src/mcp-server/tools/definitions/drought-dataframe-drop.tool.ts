/**
 * @fileoverview Opt-in removal of one disposable drought table.
 * @module mcp-server/tools/definitions/drought-dataframe-drop.tool
 */
import { tool, z } from '@cyanheads/mcp-ts-core';
import { CANVAS_IDENTIFIER_REGEX, CanvasIdSchema } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { dataframeService } from '../../../services/drought/dataframe-service.js';
import { renderFields } from '../../../services/drought/format.js';

/** Registration must be gated with disabledTool unless explicitly enabled. */
export const droughtDataframeDropTool = tool('drought_dataframe_drop', {
  title: 'Drop one staged drought table',
  description:
    'Remove one disposable staged drought table using its exact canvas_id and table_name. This deletes only the analytical copy, never source data. dropped false means the table was already absent. This operation is available only when table removal is enabled.',
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  input: z.object({
    canvas_id: CanvasIdSchema.describe('Token returned by a drought producer.'),
    table_name: z.string().regex(CANVAS_IDENTIFIER_REGEX).describe('Exact staged table to remove.'),
  }),
  output: z.object({
    canvas_id: z.string().describe('Supplied canvas token.'),
    table_name: z.string().describe('Requested table name.'),
    dropped: z.boolean().describe('True if a table was removed; false if already absent.'),
  }),
  errors: [
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
      when: 'Token is absent; nothing remains to remove.',
      recovery:
        'Nothing remains to remove; use drought_dataframe_describe only with another canvas_id already returned to you.',
      thrownBy: 'service',
    },
  ],
  handler: (input, ctx) => dataframeService.drop(input, ctx),
  format: (result) => [{ type: 'text', text: renderFields(result) }],
});
