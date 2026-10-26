/**
 * @fileoverview Versioned reference bundle and public reference record schemas.
 * @module services/drought/reference-schema
 */
import { z } from '@cyanheads/mcp-ts-core';
import { AreaSchema } from './types.js';

/** Geography record with source-vintage information. */
export const GeographyRecordSchema = AreaSchema.extend({
  sourceVintage: z.string().describe('Source dataset vintage.'),
  currentUsdm: z
    .boolean()
    .optional()
    .describe('Whether the county appears in the acquisition-week USDM response.'),
}).describe('Canonical geography with source vintage.');
/** Source acquisition evidence retained in the shipped bundle. */
export const SourceMetadataSchema = z
  .object({
    url: z.string().describe('Official public source URL.'),
    fetchedAt: z.string().describe('UTC acquisition timestamp.'),
    sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .describe('SHA-256 of exact source bytes.'),
    recordCount: z.number().int().nonnegative().describe('Extracted source record count.'),
    vintage: z.string().describe('Dataset vintage or map date.'),
  })
  .describe('Acquisition evidence for an official reference source.');
/** Full generated geography bundle. */
export const ReferenceBundleSchema = z.object({
  schemaVersion: z.literal(1),
  bundleVersion: z.string(),
  sourceMetadata: z.array(SourceMetadataSchema),
  states: z.array(GeographyRecordSchema),
  counties: z.array(GeographyRecordSchema),
  tribal: z.array(GeographyRecordSchema),
  climateDivisions: z.array(GeographyRecordSchema),
  riverForecastCenters: z.array(GeographyRecordSchema),
  huc: z.array(GeographyRecordSchema),
});
/** Reference topic selector. */
export const ReferenceTopicSchema = z.enum([
  'categories',
  'dsci',
  'area_types',
  'coverage',
  'states',
  'counties',
  'tribal',
  'climate_divisions',
  'river_forecast_centers',
  'huc',
]);
/** Declared informational reference records. */
export const InformationRecordSchema = z
  .object({
    id: z.string().describe('Reference record identifier.'),
    name: z.string().describe('Reference label.'),
    description: z.string().describe('Definition or interpretation.'),
    percentile: z.string().optional().describe('Official example percentile range.'),
    spiSpei: z.string().optional().describe('Official SPI/SPEI range.'),
    identifierFormat: z.string().optional().describe('Accepted identifier syntax.'),
    metrics: z.array(z.string()).optional().describe('Supported public metrics.'),
    cumulativeFormula: z
      .string()
      .optional()
      .describe('DSCI formula using cumulative area percentages.'),
    categoricalFormula: z
      .string()
      .optional()
      .describe('DSCI formula using categorical area percentages.'),
  })
  .describe('Named drought definition, coverage note or selector guidance.');
/** Per-topic records carry either a canonical geography or named definition. */
export const ReferenceRecordSchema = z
  .union([GeographyRecordSchema, InformationRecordSchema])
  .describe('A canonical geography or drought reference definition.');
export type ReferenceBundle = z.infer<typeof ReferenceBundleSchema>;
export type GeographyRecord = z.infer<typeof GeographyRecordSchema>;
export type ReferenceTopic = z.infer<typeof ReferenceTopicSchema>;
export type ReferenceRecord = z.infer<typeof ReferenceRecordSchema>;
