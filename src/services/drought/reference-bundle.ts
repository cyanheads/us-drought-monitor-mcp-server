/**
 * @fileoverview Lossless reference storage with shared vintages and collection-owned geography types.
 * @module services/drought/reference-bundle
 */
import { z } from '@cyanheads/mcp-ts-core';
import {
  GeographyRecordSchema,
  type ReferenceBundle,
  ReferenceBundleSchema,
} from './reference-schema.js';

const collections = [
  ['states', 'state'],
  ['counties', 'county'],
  ['tribal', 'tribal'],
  ['climateDivisions', 'climate_division'],
  ['riverForecastCenters', 'river_forecast_center'],
  ['huc', 'huc'],
] as const;
const StoredRecordSchema = GeographyRecordSchema.omit({ areaType: true, sourceVintage: true })
  .extend({ sourceVintage: z.number().int().nonnegative() })
  .strict();
const StoredBundleSchema = ReferenceBundleSchema.extend({
  schemaVersion: z.literal(2),
  vintages: z.array(z.string().min(1)),
  states: z.array(StoredRecordSchema),
  counties: z.array(StoredRecordSchema),
  tribal: z.array(StoredRecordSchema),
  climateDivisions: z.array(StoredRecordSchema),
  riverForecastCenters: z.array(StoredRecordSchema),
  huc: z.array(StoredRecordSchema),
});

/** Store repeated vintage strings once without changing public records or provenance. */
export function encodeReferenceBundle(bundle: ReferenceBundle) {
  const vintages = [
    ...new Set(
      collections.flatMap(([collection]) => bundle[collection].map((row) => row.sourceVintage)),
    ),
  ];
  return StoredBundleSchema.parse({
    ...bundle,
    schemaVersion: 2,
    vintages,
    ...Object.fromEntries(
      collections.map(([collection]) => [
        collection,
        bundle[collection].map((row) => {
          const { areaType: _areaType, sourceVintage, ...fields } = row;
          return { ...fields, sourceVintage: vintages.indexOf(sourceVintage) };
        }),
      ]),
    ),
  });
}

/** Validate the stored representation and restore the full public reference model. */
export function decodeReferenceBundle(input: unknown): ReferenceBundle {
  const stored = StoredBundleSchema.parse(input);
  return ReferenceBundleSchema.parse({
    ...stored,
    schemaVersion: 1,
    ...Object.fromEntries(
      collections.map(([collection, areaType]) => [
        collection,
        stored[collection].map((row) => ({
          ...row,
          areaType,
          sourceVintage: stored.vintages[row.sourceVintage],
        })),
      ]),
    ),
  });
}
