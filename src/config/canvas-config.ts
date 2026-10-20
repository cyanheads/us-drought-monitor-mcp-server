/**
 * @fileoverview Analytical defaults seeded after operator environment loading.
 * @module config/canvas-config
 */
import { z } from '@cyanheads/mcp-ts-core';
import { normalizeEnv, parseEnvConfig } from '@cyanheads/mcp-ts-core/config';
import { configurationError } from '@cyanheads/mcp-ts-core/errors';

/** Seed only unset operator settings before createApp first reads configuration. */
export function seedCanvasDefaults(): void {
  for (const [key, value] of Object.entries({
    CANVAS_PROVIDER_TYPE: 'duckdb',
    CANVAS_DEFAULT_MEMORY_LIMIT_MB: '128',
    CANVAS_MAX_CANVASES_PER_TENANT: '4',
  })) {
    if (normalizeEnv({ value: process.env[key] }).value === undefined) process.env[key] = value;
  }
  if (
    process.env.CANVAS_PROVIDER_TYPE !== 'none' &&
    normalizeEnv({ value: process.env.CANVAS_DEFAULT_ROW_LIMIT }).value !== undefined &&
    (!Number.isSafeInteger(Number(process.env.CANVAS_DEFAULT_ROW_LIMIT)) ||
      Number(process.env.CANVAS_DEFAULT_ROW_LIMIT) < 501)
  ) {
    throw configurationError(
      'CANVAS_DEFAULT_ROW_LIMIT must be an integer at least 501 for analytical sentinel paging.',
    );
  }
}
/** Parse the opt-in table removal setting during setup. */
export function getCanvasConfig() {
  return parseEnvConfig(
    z.object({
      dropEnabled: z
        .stringbool()
        .default(false)
        .describe('Enable deletion of disposable staged tables.'),
    }),
    { dropEnabled: 'DROUGHT_DATAFRAME_DROP_ENABLED' },
  );
}
