/**
 * @fileoverview Bounded published-week drought workflows and complete analytical producers.
 * @module services/drought/drought-service
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  configurationError,
  notFound,
  serviceUnavailable,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import { AVAILABLE_FROM, addDays, calendarDate, mapDate, mapRange } from './dates.js';
import { referenceBundle, resolveGeography, resolveState } from './reference-data.js';
import {
  type Area,
  type Geography,
  type Metric,
  type MetricObservation,
  metricUnit,
  provenance,
  type StatisticsType,
  type WeeksObservation,
} from './types.js';
import {
  type ObservationQuery,
  RequestBudget,
  type UsdmClient,
  usdmClient,
} from './usdm-client.js';
import { renderWorkflow } from './workflow-format.js';
import type { ComparisonRow, DateRun, StageHandle, WeeklyRow } from './workflow-schema.js';
import { CategoricalBucketsSchema, CumulativeBucketsSchema } from './workflow-schema.js';

/** Complete producer rows cross this boundary before preview selection or staging. */
export interface StageRequest {
  canvas_id?: string;
  kind: 'timeseries' | 'comparison';
  limit?: number;
  metadata: Record<string, unknown>;
  rows: WeeklyRow[] | ComparisonRow[];
  signal: AbortSignal;
}
/** Wave-three adapter returns a fitting preview and a handle to every original row. */
export type StageProducer = (
  request: StageRequest,
) => Promise<{ rows: WeeklyRow[] | ComparisonRow[]; staging: StageHandle | null }>;
/** Losslessly encode dates without merging gaps. */
export function dateRuns(dates: string[]): DateRun[] {
  const runs: DateRun[] = [];
  for (const date of [...new Set(dates)].sort()) {
    const last = runs.at(-1);
    if (last && addDays(last.endMapDate, 7) === date) last.endMapDate = date;
    else runs.push({ startMapDate: date, endMapDate: date, stepDays: 7 });
  }
  return runs;
}
const key = (area: Area, date: string) => `${area.areaType}:${area.id}:${date}`;
function rangeWeeks(start: string, end: string): number {
  return Math.floor((Date.parse(end) - Date.parse(start)) / 604800000) + 1;
}
function failLarge(component: string): never {
  throw validationError(
    'The complete response exceeds its budget; use fewer areas or a shorter date range in the same drought tool.',
    { reason: 'dataset_too_large', component },
  );
}
function metadataBound(metadata: unknown): void {
  if (JSON.stringify(metadata).length > 40_000) failLarge('response_metadata');
}
function envelopeBound<T>(value: T): T {
  if (JSON.stringify(value).length > 80_000 || renderWorkflow(value).length > 80_000)
    failLarge('response_envelope');
  return value;
}
const inlineProducer: StageProducer = (request) => {
  if (
    JSON.stringify(request.rows).length > 40_000 ||
    (request.limit !== undefined && request.rows.length > request.limit)
  )
    throw configurationError(
      'This complete result requires analytical staging; enable the drought dataframe installation and retry the same request.',
      { reason: 'canvas_unavailable' },
    );
  return Promise.resolve({ rows: request.rows, staging: null });
};
/** Inputs use canonical public names; blank optional strings are unset. */
export interface TimeseriesInput {
  areas: Geography[];
  canvas_id?: string | undefined;
  endDate: string;
  metric?: Metric | undefined;
  startDate: string;
  statisticsType?: StatisticsType | undefined;
}
export interface CompareInput {
  baselineDate?: string | undefined;
  canvas_id?: string | undefined;
  date?: string | undefined;
  direction?: 'asc' | 'desc' | undefined;
  limit?: number | undefined;
  metric?: 'dsci' | 'd2_d4' | 'd3_d4' | undefined;
  scope: 'states' | 'counties';
  state?: string | undefined;
}
export interface WeeksInput {
  county?: string | undefined;
  cursor?: string | undefined;
  endDate: string;
  limit?: number | undefined;
  minCategory: 'D0' | 'D1' | 'D2' | 'D3' | 'D4';
  minWeeks: number;
  mode?: 'consecutive' | 'non_consecutive' | undefined;
  startDate: string;
  states?: string[] | undefined;
}
type LatestPublication = { date: string; expires: number; urls: string[]; retrievedAt: string };
/** Orchestrates immutable references and the fixed upstream client, without user-store writes. */
export class DroughtService {
  private latestCache: LatestPublication | undefined;
  private latestFlight:
    | {
        controller: AbortController;
        budget: RequestBudget;
        users: number;
        promise: Promise<LatestPublication>;
      }
    | undefined;
  private readonly weeksCache = new Map<
    string,
    {
      binding: string;
      expires: number;
      bytes: number;
      result: Awaited<ReturnType<DroughtService['fetchWeeks']>>;
    }
  >();
  constructor(
    private readonly client: UsdmClient = usdmClient,
    private readonly stage: StageProducer = inlineProducer,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private async latest(budget: RequestBudget): Promise<string> {
    budget.signal.throwIfAborted();
    if (!this.latestCache || this.latestCache.expires <= this.now().getTime()) {
      if (!this.latestFlight) {
        const controller = new AbortController();
        const sharedBudget = new RequestBudget(controller.signal);
        const promise = (async () => {
          const today = this.now().toISOString().slice(0, 10);
          const rows = await this.client.dsci(
            {
              areaType: 'us',
              aoi: 'conus',
              areas: [{ areaType: 'us', id: 'conus', name: 'CONUS' }],
              startDate: addDays(today, -14),
              endDate: today,
            },
            sharedBudget,
          );
          const date = rows
            .map((row) => row.mapDate)
            .sort()
            .at(-1);
          if (!date)
            throw serviceUnavailable(
              'USDM has no usable latest publication; retry drought_get_current_severity later.',
              { reason: 'publication_unavailable', retryable: true },
            );
          return {
            date,
            expires: this.now().getTime() + 300_000,
            urls: [...sharedBudget.sourceUrls],
            retrievedAt: sharedBudget.retrievedAt,
          };
        })();
        this.latestFlight = { controller, budget: sharedBudget, users: 0, promise };
      }
      const flight = this.latestFlight;
      flight.users++;
      try {
        const publication = await new Promise<LatestPublication>((resolve, reject) => {
          const abort = () => reject(budget.signal.reason);
          budget.signal.addEventListener('abort', abort, { once: true });
          flight.promise.then(
            (value) => {
              budget.signal.removeEventListener('abort', abort);
              resolve(value);
            },
            (error: unknown) => {
              budget.signal.removeEventListener('abort', abort);
              reject(error);
            },
          );
        });
        budget.signal.throwIfAborted();
        for (const url of publication.urls) budget.claim(url);
        budget.consume(flight.budget.bytes);
        this.latestCache = publication;
      } finally {
        if (--flight.users === 0 && this.latestFlight === flight) {
          this.latestFlight = undefined;
          flight.controller.abort();
        }
      }
    }
    budget.signal.throwIfAborted();
    for (const url of this.latestCache.urls) budget.sourceUrls.add(url);
    return this.latestCache.date;
  }
  private resolve(inputs: Geography[]): Area[] {
    if (!inputs.length || inputs.length > 100)
      throw validationError('Supply one to 100 explicit areas.', { reason: 'invalid_area' });
    const first = inputs[0];
    if (
      !first ||
      inputs.some(
        (area) =>
          area.areaType !== first.areaType ||
          (area.areaType === 'huc' && first.areaType === 'huc' && area.hucLevel !== first.hucLevel),
      )
    )
      throw validationError('All areas must share their geography type and HUC level.', {
        reason: 'invalid_area',
      });
    return [
      ...new Map(
        inputs.flatMap((area) => resolveGeography(area).areas).map((area) => [area.id, area]),
      ).values(),
    ].sort((a, b) => a.id.localeCompare(b.id));
  }
  private queries(areas: Area[], startDate: string, endDate: string): ObservationQuery[] {
    const first = areas[0];
    if (!first) return [];
    const query = (
      selected: Area[],
      aoi: string,
      start = startDate,
      end = endDate,
    ): ObservationQuery => ({
      areaType: first.areaType,
      areas: selected,
      aoi,
      startDate: start,
      endDate: end,
      ...(first.hucLevel ? { hucLevel: first.hucLevel } : {}),
    });
    if (first.areaType === 'state' || first.areaType === 'us')
      return [query(areas, areas.map((area) => area.id).join(','))];
    if (first.areaType !== 'county' || areas.length === 1)
      return areas.map((area) => query([area], area.id));
    const known = areas.filter((area) => area.state);
    const states = [...new Set(known.map((area) => area.state as string))];
    const count = referenceBundle.counties.filter((area) =>
      states.includes(area.state ?? ''),
    ).length;
    const windowWeeks = Math.max(1, Math.floor((8 * 1024 * 1024) / (Math.max(1, count) * 1024)));
    const queries: ObservationQuery[] = [];
    if (known.length)
      for (let start = startDate; start <= endDate; start = addDays(start, windowWeeks * 7))
        queries.push({
          ...query(
            known,
            states.join(','),
            start,
            [endDate, addDays(start, (windowWeeks - 1) * 7)].sort()[0],
          ),
          filterToRequested: true,
        });
    queries.push(...areas.filter((area) => !area.state).map((area) => query([area], area.id)));
    return queries;
  }
  private clipped(startDate: string, endDate: string, latest: string) {
    const start = startDate < AVAILABLE_FROM ? AVAILABLE_FROM : startDate;
    const end = endDate > latest ? latest : endDate;
    return start <= end ? { startDate: start, endDate: end } : null;
  }
  private source(budget: RequestBudget) {
    return provenance([...budget.sourceUrls], budget.retrievedAt);
  }

  /** Full normalized series producer, before staging or preview selection. */
  async produceTimeseries(input: TimeseriesInput, signal: AbortSignal) {
    const areas = this.resolve(input.areas);
    const metric = input.metric ?? 'area_percent';
    const statisticsType = input.statisticsType ?? 'cumulative';
    if (
      metric.startsWith('population_') &&
      !['us', 'state', 'county'].includes(areas[0]?.areaType ?? '')
    )
      throw validationError('Population is available only for US, states and counties.', {
        reason: 'unsupported_metric',
      });
    const snapped = mapRange(input.startDate, input.endDate);
    const budget = new RequestBudget(signal);
    const preliminary = this.queries(
      areas,
      snapped.startDate < AVAILABLE_FROM ? AVAILABLE_FROM : snapped.startDate,
      snapped.endDate,
    );
    budget.preflight(1 + preliminary.length * 2);
    const latestMapDate = await this.latest(budget);
    const effectiveRange = this.clipped(snapped.startDate, snapped.endDate, latestMapDate);
    const queries = effectiveRange
      ? this.queries(areas, effectiveRange.startDate, effectiveRange.endDate)
      : [];
    budget.preflight(budget.requests + queries.length * 2);
    const parts = await Promise.all(
      queries.map(async (query) =>
        Promise.all([
          this.client.metric({ ...query, metric, statisticsType }, budget),
          this.client.dsci(query, budget),
        ]),
      ),
    );
    const metrics = parts.flatMap(([rows]) => rows);
    const indexes = new Map(
      parts.flatMap(([, rows]) => rows).map((row) => [key(row, row.mapDate), row.dsci]),
    );
    const rows: WeeklyRow[] = metrics
      .sort((a, b) => a.id.localeCompare(b.id) || a.mapDate.localeCompare(b.mapDate))
      .map((row, index) => {
        const dsci = indexes.get(key(row, row.mapDate)) ?? null;
        return {
          ...row,
          row_id: index + 1,
          dsci,
          dsciStatus: dsci === null ? 'missing' : 'available',
        };
      });
    const observed = new Set(rows.map((row) => key(row, row.mapDate)));
    const missingObservations: {
      area: Area;
      component: 'metric' | 'dsci';
      count: number;
      mapDateRuns: DateRun[];
    }[] = [];
    if (effectiveRange)
      for (const area of areas)
        for (const component of ['metric', 'dsci'] as const) {
          const dates: string[] = [];
          for (
            let date = effectiveRange.startDate;
            date <= effectiveRange.endDate;
            date = addDays(date, 7)
          )
            if (
              component === 'metric'
                ? !observed.has(key(area, date))
                : indexes.get(key(area, date)) == null
            )
              dates.push(date);
          if (dates.length)
            missingObservations.push({
              area,
              component,
              count: dates.length,
              mapDateRuns: dateRuns(dates),
            });
        }
    const peak = (values: { date: string; value: number | null }[]) => {
      const available = values.filter(
        (item): item is { date: string; value: number } => item.value !== null,
      );
      if (!available.length) return null;
      const value = Math.max(...available.map((item) => item.value));
      return {
        value,
        mapDateRuns: dateRuns(
          available.filter((item) => item.value === value).map((item) => item.date),
        ),
      };
    };
    const summary = areas.map((area) => {
      const selected = rows.filter((row) => row.id === area.id);
      const severity = peak(
        selected.map((row) => ({
          date: row.mapDate,
          value:
            'd3_d4' in row.buckets
              ? row.buckets.d3_d4
              : row.buckets.d3_only === null || row.buckets.d4_only === null
                ? null
                : row.buckets.d3_only + row.buckets.d4_only,
        })),
      );
      return {
        area,
        observationCount: selected.length,
        firstMapDate: selected[0]?.mapDate ?? null,
        lastMapDate: selected.at(-1)?.mapDate ?? null,
        peakDsci: peak(selected.map((row) => ({ date: row.mapDate, value: row.dsci }))),
        peakD3D4: severity ? { ...severity, unit: metricUnit(metric) } : null,
      };
    });
    const metadata = {
      areas,
      requestedRange: { startDate: input.startDate, endDate: input.endDate },
      effectiveRange,
      latestMapDate,
      metric,
      statisticsType,
      unit: metricUnit(metric),
      rowCount: rows.length,
      missingAreas: areas.filter((area) => !rows.some((row) => row.id === area.id)),
      missingObservations,
      summary,
      provenance: this.source(budget),
    };
    metadataBound(metadata);
    return { rows, metadata, signal: budget.signal };
  }
  /** Stage complete rows only when needed; otherwise return every inline observation. */
  async timeseries(input: TimeseriesInput, signal: AbortSignal, stage: StageProducer = this.stage) {
    const full = await this.produceTimeseries(input, signal);
    const staged = await stage({
      kind: 'timeseries',
      ...full,
      ...(input.canvas_id ? { canvas_id: input.canvas_id } : {}),
    });
    return envelopeBound({
      ...full.metadata,
      rows: staged.rows as WeeklyRow[],
      staging: staged.staging,
    });
  }

  /** Exact-week snapshot with authoritative 4/52-week DSCI baselines. */
  async current(input: { area: Geography; date?: string | undefined }, signal: AbortSignal) {
    const areas = this.resolve([input.area]);
    if (input.date) calendarDate(input.date);
    const budget = new RequestBudget(signal, 7);
    const latestMapDate = await this.latest(budget);
    const effectiveMapDate = input.date ? mapDate(input.date) : latestMapDate;
    const base = {
      found: false,
      requestedArea: input.area,
      resolvedAreas: areas,
      requestedDate: input.date || null,
      effectiveMapDate,
      latestMapDate,
      availableFrom: AVAILABLE_FROM,
    };
    if (effectiveMapDate < AVAILABLE_FROM || effectiveMapDate > latestMapDate)
      return envelopeBound({
        ...base,
        snapshots: [],
        guidance: `Published maps span ${AVAILABLE_FROM} through ${latestMapDate}; call drought_list_reference with topic coverage.`,
        provenance: this.source(budget),
      });
    const queries = this.queries(areas, effectiveMapDate, effectiveMapDate);
    const populationSupported = ['us', 'state', 'county'].includes(input.area.areaType);
    budget.preflight(budget.requests + queries.length * (populationSupported ? 5 : 4));
    const components = await Promise.all(
      queries.map(async (query) => {
        const [cumulative, categorical, miles, population, dsci] = await Promise.all([
          this.client.metric(
            { ...query, metric: 'area_percent', statisticsType: 'cumulative' },
            budget,
          ),
          this.client.metric(
            { ...query, metric: 'area_percent', statisticsType: 'categorical' },
            budget,
          ),
          this.client.metric(
            { ...query, metric: 'area_sq_miles', statisticsType: 'cumulative' },
            budget,
          ),
          populationSupported
            ? this.client.metric(
                { ...query, metric: 'population_count', statisticsType: 'cumulative' },
                budget,
              )
            : Promise.resolve([] as MetricObservation[]),
          this.client.dsci(
            {
              ...query,
              startDate:
                addDays(effectiveMapDate, -364) < AVAILABLE_FROM
                  ? AVAILABLE_FROM
                  : addDays(effectiveMapDate, -364),
            },
            budget,
          ),
        ]);
        return { cumulative, categorical, miles, population, dsci };
      }),
    );
    const missing: string[] = [];
    const snapshots = areas.flatMap((area) => {
      const match = (name: 'cumulative' | 'categorical' | 'miles' | 'population') =>
        components
          .flatMap((part) => part[name])
          .find((row) => row.id === area.id && row.mapDate === effectiveMapDate);
      const cumulative = match('cumulative');
      const categorical = match('categorical');
      const miles = match('miles');
      for (const [name, row] of [
        ['areaPercentCumulative', cumulative],
        ['areaPercentCategorical', categorical],
        ['areaSqMilesCumulative', miles],
      ] as const)
        if (!row) missing.push(`${area.id}: ${name}`);
      if (!cumulative || !categorical || !miles) return [];
      const dsciRows = components.flatMap((part) => part.dsci);
      const dsci =
        dsciRows.find((row) => row.id === area.id && row.mapDate === effectiveMapDate)?.dsci ??
        null;
      const population = match('population');
      const delta = (days: number) => {
        const baselineMapDate = addDays(effectiveMapDate, -days);
        const baselineDsci =
          baselineMapDate < AVAILABLE_FROM
            ? null
            : (dsciRows.find((row) => row.id === area.id && row.mapDate === baselineMapDate)
                ?.dsci ?? null);
        return {
          baselineMapDate,
          baselineDsci,
          delta: dsci !== null && baselineDsci !== null ? dsci - baselineDsci : null,
          status:
            baselineMapDate < AVAILABLE_FROM
              ? ('before_coverage' as const)
              : dsci === null || baselineDsci === null
                ? ('missing' as const)
                : ('available' as const),
        };
      };
      return [
        {
          ...area,
          mapDate: effectiveMapDate,
          validStart: effectiveMapDate,
          validEnd: addDays(effectiveMapDate, 6),
          areaPercentCumulative: CumulativeBucketsSchema.parse(cumulative.buckets),
          areaPercentCategorical: CategoricalBucketsSchema.parse(categorical.buckets),
          areaSqMilesCumulative: CumulativeBucketsSchema.parse(miles.buckets),
          populationCountCumulative: population
            ? CumulativeBucketsSchema.parse(population.buckets)
            : null,
          populationStatus: !populationSupported
            ? ('unsupported' as const)
            : population
              ? ('available' as const)
              : ('missing' as const),
          dsci,
          dsciStatus: dsci === null ? ('missing' as const) : ('available' as const),
          dsciChange4Weeks: delta(28),
          dsciChange52Weeks: delta(364),
        },
      ];
    });
    return envelopeBound({
      ...base,
      found: snapshots.length > 0,
      snapshots,
      guidance: missing.length
        ? `Missing required observations: ${missing.join('; ')}. Missing data does not mean no drought; call drought_list_reference for the geography type.`
        : snapshots.length
          ? null
          : 'No snapshot observations are available for this geography and week; call drought_list_reference for the geography type.',
      provenance: this.source(budget),
    });
  }

  /** Produce the entire comparable population before any top-limit preview. */
  async produceComparison(input: CompareInput, signal: AbortSignal) {
    if (input.scope === 'states' && input.state)
      throw validationError('state is valid only for county scope.', { reason: 'invalid_area' });
    const state = input.state ? resolveState(input.state).state : undefined;
    const includedStates = referenceBundle.states
      .map((area) => area.state)
      .filter((value): value is string => !!value && (!state || value === state));
    const areas: Area[] = (
      input.scope === 'states' ? referenceBundle.states : referenceBundle.counties
    ).filter((area) => !state || area.state === state);
    if (input.date) calendarDate(input.date);
    if (input.baselineDate) calendarDate(input.baselineDate);
    if (input.date && input.baselineDate && input.baselineDate > input.date)
      throw validationError('baselineDate must not follow date.', { reason: 'invalid_date_range' });
    const budget = new RequestBudget(signal, input.baselineDate ? 3 : 2);
    const latestMapDate = await this.latest(budget);
    const targetMapDate = input.date ? mapDate(input.date) : latestMapDate;
    const baselineMapDate = input.baselineDate ? mapDate(input.baselineDate) : null;
    if (baselineMapDate && baselineMapDate > targetMapDate)
      throw validationError('baselineDate must not follow the target.', {
        reason: 'invalid_date_range',
      });
    const metric = input.metric ?? 'dsci';
    const acquire = async (date: string) => {
      if (date < AVAILABLE_FROM || date > latestMapDate) return new Map<string, number | null>();
      const query: ObservationQuery = {
        areaType: input.scope === 'states' ? 'state' : 'county',
        aoi:
          input.scope === 'states'
            ? areas.map((area) => area.id).join(',')
            : includedStates.join(','),
        areas,
        startDate: date,
        endDate: date,
      };
      const rows =
        metric === 'dsci'
          ? await this.client.dsci(query, budget)
          : await this.client.metric(
              { ...query, metric: 'area_percent', statisticsType: 'cumulative' },
              budget,
            );
      return new Map(
        rows.map((row) => [
          row.id,
          'dsci' in row
            ? row.dsci
            : 'd2_d4' in row.buckets
              ? row.buckets[metric === 'd2_d4' ? 'd2_d4' : 'd3_d4']
              : null,
        ]),
      );
    };
    const publishedDates =
      targetMapDate >= AVAILABLE_FROM &&
      targetMapDate <= latestMapDate &&
      (baselineMapDate === null ||
        (baselineMapDate >= AVAILABLE_FROM && baselineMapDate <= latestMapDate));
    const [target, baseline] = publishedDates
      ? await Promise.all([
          acquire(targetMapDate),
          baselineMapDate
            ? acquire(baselineMapDate)
            : Promise.resolve(new Map<string, number | null>()),
        ])
      : [new Map<string, number | null>(), new Map<string, number | null>()];
    const excludedAreas: { area: Area; missing: ('target' | 'baseline')[] }[] = [];
    const rows: ComparisonRow[] = [];
    for (const area of publishedDates ? areas : []) {
      const targetValue = target.get(area.id) ?? null;
      const baselineValue = baseline.get(area.id) ?? null;
      const missing: ('target' | 'baseline')[] = [];
      if (targetValue === null) missing.push('target');
      if (baselineMapDate && baselineValue === null) missing.push('baseline');
      if (missing.length) {
        excludedAreas.push({ area, missing });
        continue;
      }
      if (targetValue === null) continue;
      const change = baselineValue === null ? null : targetValue - baselineValue;
      rows.push({
        ...area,
        row_id: 0,
        targetValue,
        baselineValue,
        change,
        rankedValue: baselineMapDate ? (change as number) : targetValue,
        rank: 0,
      });
    }
    rows.sort(
      (a, b) =>
        (input.direction === 'asc' ? 1 : -1) * (a.rankedValue - b.rankedValue) ||
        a.id.localeCompare(b.id),
    );
    rows.forEach((row, index) => {
      row.row_id = index + 1;
      row.rank =
        index > 0 && rows[index - 1]?.rankedValue === row.rankedValue
          ? (rows[index - 1]?.rank as number)
          : index + 1;
    });
    const metadata = {
      scope: input.scope,
      state: state ?? null,
      includedStates,
      metric,
      unit: metric === 'dsci' ? ('index' as const) : ('percent' as const),
      changeUnit: metric === 'dsci' ? ('index' as const) : ('percentage_points' as const),
      targetMapDate,
      baselineMapDate,
      comparedCount: rows.length,
      excludedAreas,
      provenance: this.source(budget),
    };
    metadataBound(metadata);
    return { rows, metadata, signal: budget.signal };
  }
  /** Return complete ranked rows inline, or pass all rows to the staging adapter. */
  async compare(input: CompareInput, signal: AbortSignal, stage: StageProducer = this.stage) {
    const full = await this.produceComparison(input, signal);
    const staged = await stage({
      kind: 'comparison',
      ...full,
      limit: input.limit ?? 20,
      ...(input.canvas_id ? { canvas_id: input.canvas_id } : {}),
    });
    return envelopeBound({
      ...full.metadata,
      rows: staged.rows as ComparisonRow[],
      staging: staged.staging,
    });
  }

  private async fetchWeeks(input: WeeksInput, signal: AbortSignal) {
    if (input.states?.length && input.county)
      throw validationError('Supply states or county, never both.', { reason: 'invalid_area' });
    const resolvedCounty = input.county
      ? this.resolve([{ areaType: 'county', aoi: input.county }])[0]
      : undefined;
    const countyState =
      resolvedCounty?.state ??
      referenceBundle.states.find((area) => area.id === resolvedCounty?.id.slice(0, 2))?.state;
    const county =
      resolvedCounty && countyState ? { ...resolvedCounty, state: countyState } : resolvedCounty;
    if (county && !county.state)
      throw notFound(
        'County state cannot be resolved; use a supported county identifier from drought_list_reference.',
        { reason: 'unknown_area' },
      );
    const states = [
      ...new Set(
        county
          ? [county.state as string]
          : input.states?.length
            ? input.states.map((state) => resolveState(state).state as string)
            : referenceBundle.states.map((state) => state.state as string),
      ),
    ].sort();
    const snapped = mapRange(input.startDate, input.endDate);
    if (input.minWeeks > rangeWeeks(snapped.startDate, snapped.endDate))
      throw validationError('minWeeks exceeds the inclusive requested map weeks.', {
        reason: 'invalid_date_range',
      });
    const budget = new RequestBudget(signal, 2);
    const latestMapDate = await this.latest(budget);
    const effectiveRange = this.clipped(snapped.startDate, snapped.endDate, latestMapDate);
    const mode = input.mode ?? 'consecutive';
    const rows =
      effectiveRange &&
      input.minWeeks <= rangeWeeks(effectiveRange.startDate, effectiveRange.endDate)
        ? await this.client.weeks(
            {
              states,
              ...effectiveRange,
              minCategory: input.minCategory,
              minWeeks: input.minWeeks,
              mode,
            },
            budget,
          )
        : [];
    const filtered = rows
      .filter((row) => !county || row.fips === county.id)
      .sort(
        (a, b) =>
          a.fips.localeCompare(b.fips) || (a.startDate ?? '').localeCompare(b.startDate ?? ''),
      );
    const metadata = {
      mode,
      minCategory: input.minCategory,
      minWeeks: input.minWeeks,
      thresholdRule: 'any_area_at_or_above' as const,
      states,
      county: county ?? null,
      requestedRange: { startDate: input.startDate, endDate: input.endDate },
      effectiveRange,
      latestMapDate,
      totalCount: filtered.length,
      provenance: this.source(budget),
    };
    metadataBound(metadata);
    return { metadata, rows: filtered };
  }
  /** Immutable five-minute query-bound paging; cursors never refresh publication windows. */
  async weeks(input: WeeksInput, signal: AbortSignal) {
    const binding = createHash('sha256')
      .update(
        JSON.stringify({
          ...input,
          cursor: undefined,
          limit: undefined,
          mode: input.mode ?? 'consecutive',
          states: input.states?.map((state) => resolveState(state).id).sort(),
          county: input.county
            ? this.resolve([{ areaType: 'county', aoi: input.county }])[0]?.id
            : undefined,
        }),
      )
      .digest('hex');
    const now = this.now().getTime();
    for (const [id, entry] of this.weeksCache) if (entry.expires <= now) this.weeksCache.delete(id);
    let id: string;
    let offset = 0;
    let cached: {
      binding: string;
      expires: number;
      bytes: number;
      result: Awaited<ReturnType<DroughtService['fetchWeeks']>>;
    };
    if (input.cursor) {
      try {
        const cursor: unknown = JSON.parse(Buffer.from(input.cursor, 'base64url').toString());
        if (
          !cursor ||
          typeof cursor !== 'object' ||
          !('id' in cursor) ||
          typeof cursor.id !== 'string' ||
          !('offset' in cursor) ||
          typeof cursor.offset !== 'number' ||
          !Number.isSafeInteger(cursor.offset) ||
          cursor.offset < 0
        )
          throw new Error('cursor');
        const entry = this.weeksCache.get(cursor.id);
        if (!entry || entry.binding !== binding || cursor.offset >= entry.result.rows.length)
          throw new Error('cursor');
        id = cursor.id;
        offset = cursor.offset;
        cached = entry;
        this.weeksCache.delete(id);
        this.weeksCache.set(id, entry);
      } catch {
        throw validationError(
          'Weeks cursor is invalid, expired or its filters changed; restart without cursor.',
          { reason: 'invalid_cursor' },
        );
      }
    } else {
      const result = await this.fetchWeeks(input, signal);
      const bytes = Buffer.byteLength(JSON.stringify(result));
      if (bytes > 64 * 1024 * 1024) failLarge('weeks_cache');
      while (
        this.weeksCache.size >= 32 ||
        [...this.weeksCache.values()].reduce((sum, entry) => sum + entry.bytes, 0) + bytes >
          64 * 1024 * 1024
      ) {
        const oldest = this.weeksCache.keys().next().value;
        if (oldest) this.weeksCache.delete(oldest);
        else break;
      }
      id = randomUUID();
      cached = { binding, expires: now + 300_000, bytes, result };
      this.weeksCache.set(id, cached);
    }
    const rows: WeeksObservation[] = [];
    let characters = 0;
    for (const row of cached.result.rows.slice(offset, offset + (input.limit ?? 50))) {
      const size = JSON.stringify(row).length;
      if (characters + size > 40_000) {
        if (!rows.length) failLarge('weeks_record');
        break;
      }
      rows.push(row);
      characters += size;
    }
    const result = () => ({
      ...cached.result.metadata,
      rows,
      nextCursor:
        offset + rows.length < cached.result.rows.length
          ? Buffer.from(JSON.stringify({ id, offset: offset + rows.length })).toString('base64url')
          : null,
      hasMore: offset + rows.length < cached.result.rows.length,
    });
    while (JSON.stringify(result()).length > 80_000 || renderWorkflow(result()).length > 80_000) {
      rows.pop();
      if (!rows.length) failLarge('weeks_record');
    }
    signal.throwIfAborted();
    return result();
  }
}
/** Process-local workflow service, with no persistent user state. */
export const droughtService = new DroughtService();
