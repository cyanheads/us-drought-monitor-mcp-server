/**
 * @fileoverview Count ceilings, schema disclosure and request-scoped clamp telemetry.
 * @module config/page-limits
 */
import { type Context, z } from '@cyanheads/mcp-ts-core';
import { createCounter } from '@cyanheads/mcp-ts-core/utils';
import { getCanvasConfig } from './canvas-config.js';

const clamps = createCounter('drought.limit_clamps', 'Drought page limits clamped', '{clamps}');
/** Producer limit defaults and ceiling, shared by schemas and staging. */
export const comparisonPreviewLimit = 20;
export const producerPageMaximum = 200;
function pageCount(maximum: number) {
  const schema = z.number().int().min(1);
  return getCanvasConfig().clampLimits ? schema : schema.max(maximum);
}
function limitDescription(maximum: number) {
  return getCanvasConfig().clampLimits
    ? `values above ${maximum} are clamped with disclosure`
    : `maximum ${maximum}`;
}
/** Advertise a maximum only when oversized requests are rejected. */
export function pageLimit(defaultLimit: number, maximum: number, subject: string) {
  return pageCount(maximum)
    .default(defaultLimit)
    .describe(`Default ${defaultLimit} ${subject}; ${limitDescription(maximum)}.`);
}
/** Preserve input presence so an omitted producer limit keeps legacy output. */
export function producerPageLimit(omission: string) {
  return pageCount(producerPageMaximum)
    .optional()
    .describe(
      `Optional exact rows per page; ${limitDescription(producerPageMaximum)}. ${omission}`,
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
