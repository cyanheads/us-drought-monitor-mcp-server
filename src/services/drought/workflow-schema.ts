/**
 * @fileoverview Public drought workflow rows, compact weekly runs and staging contracts.
 * @module services/drought/workflow-schema
 */
import { z } from '@cyanheads/mcp-ts-core';
import { AreaSchema, MetricSchema, StatisticsTypeSchema } from './types.js';

const nullableNumber = z.number().nullable();
/** Explicit named cumulative or categorical values, preserving missing buckets. */
export const CumulativeBucketsSchema = z
  .object({
    none: nullableNumber.describe('No drought.'),
    d0_d4: nullableNumber.describe('D0 through D4.'),
    d1_d4: nullableNumber.describe('D1 through D4.'),
    d2_d4: nullableNumber.describe('D2 through D4.'),
    d3_d4: nullableNumber.describe('D3 through D4.'),
    d4: nullableNumber.describe('D4.'),
  })
  .describe('Overlapping cumulative drought severity buckets.');
/** Exclusive drought severity buckets. */
export const CategoricalBucketsSchema = z
  .object({
    none: nullableNumber.describe('No drought.'),
    d0_only: nullableNumber.describe('D0 only.'),
    d1_only: nullableNumber.describe('D1 only.'),
    d2_only: nullableNumber.describe('D2 only.'),
    d3_only: nullableNumber.describe('D3 only.'),
    d4_only: nullableNumber.describe('D4 only.'),
  })
  .describe('Mutually exclusive drought severity buckets.');
/** Source bucket representation selected by statisticsType. */
export const BucketsSchema = z.union([CumulativeBucketsSchema, CategoricalBucketsSchema]);
/** Inclusive effective map-date bounds. */
export const RangeSchema = z.object({
  startDate: z.string().describe('First inclusive date.'),
  endDate: z.string().describe('Last inclusive date.'),
});
/** Lossless contiguous weekly dates. */
export const DateRunSchema = z
  .object({
    startMapDate: z.string().describe('First Tuesday.'),
    endMapDate: z.string().describe('Last Tuesday.'),
    stepDays: z.literal(7).describe('Seven-day step.'),
  })
  .describe('Inclusive run of Tuesday map dates separated by seven days.');
/** Joined weekly source observation. */
export const WeeklyRowSchema = AreaSchema.extend({
  row_id: z.number().int().describe('Stable one-based row index.'),
  mapDate: z.string().describe('Tuesday map date.'),
  validStart: z.string().describe('Full map validity start.'),
  validEnd: z.string().describe('Full map validity end.'),
  metric: MetricSchema.describe('Requested measure.'),
  statisticsType: StatisticsTypeSchema.describe('Bucket representation.'),
  unit: z.string().describe('Bucket units.'),
  buckets: BucketsSchema.describe('Named source buckets.'),
  dsci: nullableNumber.describe('Experimental upstream DSCI index, 0–500.'),
  dsciStatus: z.enum(['available', 'missing']).describe('Whether upstream DSCI is available.'),
}).describe('One geography and map week with source metric buckets and DSCI.');
/** Exact complete-table handle returned by the staging adapter. */
export const StageHandleSchema = z.object({
  canvas_id: z.string().describe('Canvas access token.'),
  table_name: z.string().describe('Registered table.'),
  row_count: z.number().int().describe('Complete row count.'),
  columns: z
    .array(
      z
        .object({
          name: z.string().describe('Column name.'),
          type: z.string().describe('SQL type.'),
          unit: z.string().nullable().describe('Physical unit or null.'),
        })
        .describe('One registered SQL column and its physical unit.'),
    )
    .describe('Explicit column schema.'),
  expires_at: z.string().describe('Actual table expiry.'),
  describe_tool: z.literal('drought_dataframe_describe').describe('Metadata reader.'),
  query_tool: z.literal('drought_dataframe_query').describe('Complete row reader.'),
});
/** Per-area missing component dates. */
export const MissingSchema = z
  .object({
    area: AreaSchema.describe('Requested area.'),
    component: z.enum(['metric', 'dsci']).describe('Missing source component.'),
    count: z.number().int().describe('Missing weekly observations.'),
    mapDateRuns: z.array(DateRunSchema).describe('Every missing date in lossless runs.'),
  })
  .describe('All absent weeks for one geography and source component.');
const PeakSchema = z.object({
  value: z.number().describe('Peak measured value.'),
  mapDateRuns: z.array(DateRunSchema).describe('Every tied peak date.'),
});
/** Summary over every joined observation, never just the preview. */
export const SummarySchema = z
  .object({
    area: AreaSchema.describe('Canonical area.'),
    observationCount: z.number().int().describe('Returned weekly rows.'),
    firstMapDate: z.string().nullable().describe('First observed week.'),
    lastMapDate: z.string().nullable().describe('Last observed week.'),
    peakDsci: PeakSchema.nullable().describe('Peak experimental index and all ties.'),
    peakD3D4: PeakSchema.extend({ unit: z.string().describe('Bucket measure unit.') })
      .nullable()
      .describe('Peak D3 through D4 and all ties.'),
  })
  .describe('Complete-series coverage and tied severity peaks for one area.');
/** Ranked severity value and exact optional baseline. */
export const ComparisonRowSchema = AreaSchema.extend({
  row_id: z.number().int().describe('Stable sorted row index.'),
  targetValue: z.number().describe('Target severity in output unit.'),
  baselineValue: nullableNumber.describe('Baseline severity or null.'),
  change: nullableNumber.describe('Target minus baseline in changeUnit.'),
  rankedValue: z.number().describe('Value used for ordering.'),
  rank: z.number().int().describe('Competition rank, preserving ties.'),
}).describe('One ranked area with target severity and optional exact baseline.');
/** Source-authoritative county durations. */
export const WeeksRowSchema = z
  .object({
    fips: z.string().describe('Five-digit county FIPS.'),
    county: z.string().describe('County name.'),
    state: z.string().describe('State postal code.'),
    startDate: z.string().optional().describe('Full consecutive streak start.'),
    endDate: z.string().optional().describe('Full consecutive streak Monday end.'),
    consecutiveWeeks: z.number().int().optional().describe('Consecutive map weeks.'),
    nonConsecutiveWeeks: z.number().int().optional().describe('Qualifying map-week count.'),
  })
  .describe('County drought duration reported by the official upstream source.');
export type WeeklyRow = z.infer<typeof WeeklyRowSchema>;
export type ComparisonRow = z.infer<typeof ComparisonRowSchema>;
export type DateRun = z.infer<typeof DateRunSchema>;
export type StageHandle = z.infer<typeof StageHandleSchema>;
