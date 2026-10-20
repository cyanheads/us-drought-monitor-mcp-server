/**
 * @fileoverview Shared drought geography, metric and provenance contracts.
 * @module services/drought/types
 */
import { z } from '@cyanheads/mcp-ts-core';

/** Supported geography families. */
export const AreaTypeSchema = z.enum([
  'us',
  'state',
  'county',
  'huc',
  'tribal',
  'climate_division',
]);
/** Supported HUC widths. */
export const HucLevelSchema = z.union([z.literal(2), z.literal(4), z.literal(6), z.literal(8)]);
const aoi = z
  .string()
  .min(1)
  .max(200)
  .describe('Exact geography identifier, or supported exact state/county name.');
/** Strict geography input, requiring level only for HUC. */
export const GeographySchema = z
  .discriminatedUnion('areaType', [
    z
      .object({ areaType: z.literal('us').describe('National geography.'), aoi })
      .strict()
      .describe('National coverage selector.'),
    z
      .object({ areaType: z.literal('state').describe('State geography.'), aoi })
      .strict()
      .describe('Exact state selector.'),
    z
      .object({ areaType: z.literal('county').describe('County geography.'), aoi })
      .strict()
      .describe('Exact county selector.'),
    z
      .object({ areaType: z.literal('tribal').describe('Tribal geography.'), aoi })
      .strict()
      .describe('Exact tribal selector.'),
    z
      .object({
        areaType: z.literal('climate_division').describe('Climate division geography.'),
        aoi,
      })
      .strict()
      .describe('Exact climate division selector.'),
    z
      .object({
        areaType: z.literal('huc').describe('Watershed geography.'),
        aoi,
        hucLevel: HucLevelSchema.describe('Exact HUC identifier width.'),
      })
      .strict()
      .describe('Exact watershed selector with matching HUC width.'),
  ])
  .describe('One supported geography and its exact identifier.');
/** Canonical resolved area. */
export const AreaSchema = z
  .object({
    areaType: AreaTypeSchema.describe('Geography family.'),
    id: z.string().describe('Canonical identifier, preserving leading zeroes.'),
    name: z.string().describe('Source geography name.'),
    state: z.string().optional().describe('State postal code where known.'),
    hucLevel: HucLevelSchema.optional().describe('HUC width for watershed areas.'),
  })
  .describe('Canonical geography identity and known state or watershed attributes.');
/** Public metric selectors. */
export const MetricSchema = z.enum([
  'area_percent',
  'area_sq_miles',
  'population_percent',
  'population_count',
]);
/** Cumulative overlapping or categorical exclusive buckets. */
export const StatisticsTypeSchema = z.enum(['cumulative', 'categorical']);
/** Required source attribution and acquisition timestamp. */
export const ProvenanceSchema = z.object({
  sourceUrls: z.array(z.string()).describe('Public source URLs actually used.'),
  retrievedAt: z.string().describe('UTC retrieval timestamp.'),
  credit: z.string().describe('USDM attribution.'),
  dsciCitation: z.string().describe('DSCI citation.'),
  dsciExperimental: z.literal(true).describe('DSCI is an experimental index.'),
});
export type AreaType = z.infer<typeof AreaTypeSchema>;
export type HucLevel = z.infer<typeof HucLevelSchema>;
export type Geography = z.infer<typeof GeographySchema>;
export type Area = z.infer<typeof AreaSchema>;
export type Metric = z.infer<typeof MetricSchema>;
export type StatisticsType = z.infer<typeof StatisticsTypeSchema>;
export type Provenance = z.infer<typeof ProvenanceSchema>;
/** Nullable upstream bucket values preserve unavailable values. */
export type Buckets = { none: number | null } & (
  | {
      d0_d4: number | null;
      d1_d4: number | null;
      d2_d4: number | null;
      d3_d4: number | null;
      d4: number | null;
    }
  | {
      d0_only: number | null;
      d1_only: number | null;
      d2_only: number | null;
      d3_only: number | null;
      d4_only: number | null;
    }
);
/** Statistics row before joining DSCI. */
export type MetricObservation = Area & {
  mapDate: string;
  validStart: string;
  validEnd: string;
  metric: Metric;
  statisticsType: StatisticsType;
  unit: string;
  buckets: Buckets;
};
/** DSCI observation normalized onto the same geography keys. */
export type DsciObservation = Area & { mapDate: string; dsci: number | null };
/** Authoritative upstream county duration row. */
export type WeeksObservation = {
  fips: string;
  county: string;
  state: string;
  startDate?: string;
  endDate?: string;
  consecutiveWeeks?: number;
  startMayExtendEarlier?: boolean;
  endMayContinue?: boolean;
  nonConsecutiveWeeks?: number;
};
/** Exact USDM attribution. */
export const CREDIT =
  'The U.S. Drought Monitor is jointly produced by the National Drought Mitigation Center at the University of Nebraska-Lincoln, the United States Department of Agriculture, the National Oceanic and Atmospheric Administration and the National Aeronautics and Space Administration. Map courtesy of NDMC.';
/** Experimental DSCI citation. */
export const DSCI_CITATION =
  'Akyuz, F. A. 2017. Drought Severity and Coverage Index. United States Drought Monitor.';
/** Construct a deduplicated provenance envelope. */
export function provenance(
  sourceUrls: string[],
  retrievedAt = new Date().toISOString(),
): Provenance {
  return {
    sourceUrls: [...new Set(sourceUrls)],
    retrievedAt,
    credit: CREDIT,
    dsciCitation: DSCI_CITATION,
    dsciExperimental: true,
  };
}
/** Metric units are independent of bucket representation. */
export function metricUnit(metric: Metric): string {
  return metric === 'area_sq_miles'
    ? 'square miles'
    : metric === 'population_count'
      ? 'people'
      : 'percent';
}
