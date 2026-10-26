/**
 * @fileoverview Count ceilings, schema disclosure and request-scoped clamp telemetry.
 * @module config/page-limits
 */
import { type Context, z } from '@cyanheads/mcp-ts-core';
import { createCounter } from '@cyanheads/mcp-ts-core/utils';
import { getCanvasConfig } from './canvas-config.js';

const clamps = createCounter('drought.limit_clamps', 'Drought page limits clamped', '{clamps}');
/** Advertise a maximum only when oversized requests are rejected. */
export function pageLimit(defaultLimit: number, maximum: number, subject: string) {
  const clamp = getCanvasConfig().clampLimits;
  const schema = z.number().int().min(1);
  return (clamp ? schema : schema.max(maximum))
    .default(defaultLimit)
    .describe(
      `Default ${defaultLimit} ${subject}; ${clamp ? `values above ${maximum} are clamped with disclosure` : `maximum ${maximum}`}.`,
    );
}
/** Record each normalization once at the public request boundary. */
export function effectiveLimit(
  requested: number,
  maximum: number,
  toolName: string,
  ctx: Context,
): number {
  const limit = Math.min(requested, maximum);
  if (requested > limit) {
    ctx.log.notice('Drought page limit clamped.', {
      toolName,
      requestedLimit: requested,
      effectiveLimit: limit,
    });
    clamps.add(1, { tool: toolName });
  }
  return limit;
}
