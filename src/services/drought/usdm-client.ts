/**
 * @fileoverview Bounded fixed-origin USDM acquisition and canonical observation parsing.
 * @module services/drought/usdm-client
 */
import { setTimeout as delay } from 'node:timers/promises';
import { z } from '@cyanheads/mcp-ts-core';
import { McpError, serviceUnavailable, validationError } from '@cyanheads/mcp-ts-core/errors';
import { addDays, calendarDate, sourceDate, upstreamDate } from './dates.js';
import { normalizeName, referenceBundle } from './reference-data.js';
import {
  type Area,
  type AreaType,
  type Buckets,
  type DsciObservation,
  type HucLevel,
  type Metric,
  type MetricObservation,
  metricUnit,
  type StatisticsType,
  type WeeksObservation,
} from './types.js';

/** Fixed official API origin; no caller-configurable URL surface. */
export const USDM_ORIGIN = 'https://usdmdataservices.unl.edu';
const MiB = 1024 * 1024;
const families: Record<AreaType, string> = {
  us: 'USStatistics',
  state: 'StateStatistics',
  county: 'CountyStatistics',
  huc: 'HUCStatistics',
  tribal: 'TribalStatistics',
  climate_division: 'ClimateDivisionStatistics',
};
const endpoints: Record<Metric, string> = {
  area_percent: 'GetDroughtSeverityStatisticsByAreaPercent',
  area_sq_miles: 'GetDroughtSeverityStatisticsByArea',
  population_percent: 'GetDroughtSeverityStatisticsByPopulationPercent',
  population_count: 'GetDroughtSeverityStatisticsByPopulation',
};
const RawRow = z
  .object({
    mapDate: z.string(),
    validStart: z.string().optional(),
    validEnd: z.string().optional(),
    name: z.string().nullable().optional(),
    state: z.string().nullable().optional(),
    stateAbbreviation: z.string().nullable().optional(),
    county: z.string().nullable().optional(),
    fips: z.string().nullable().optional(),
    hucid: z.string().nullable().optional(),
    hucId: z.string().nullable().optional(),
    huc: z.string().nullable().optional(),
    areaOfInterest: z.string().nullable().optional(),
    none: z.number().finite().nullable().optional(),
    d0: z.number().finite().nullable().optional(),
    d1: z.number().finite().nullable().optional(),
    d2: z.number().finite().nullable().optional(),
    d3: z.number().finite().nullable().optional(),
    d4: z.number().finite().nullable().optional(),
    dsci: z.number().int().min(0).max(500).nullable().optional(),
  })
  .passthrough();
type Raw = z.infer<typeof RawRow>;
function shape(
  message = 'USDM returned data incompatible with the requested geography or dates.',
): never {
  throw serviceUnavailable(message, { reason: 'upstream_shape_invalid', retryable: false });
}
function tooLarge(component: string): never {
  throw validationError(
    'USDM request exceeds its bounded dataset budget; narrow dates or areas and retry.',
    {
      reason: 'dataset_too_large',
      component,
      maxResponseBytes: 16 * MiB,
      maxWorkflowBytes: 64 * MiB,
    },
  );
}

/** Shared per-workflow cancellation, logical request count, bytes and source URLs. */
export class RequestBudget {
  readonly controller = new AbortController();
  readonly signal: AbortSignal;
  readonly sourceUrls = new Set<string>();
  readonly retrievedAt = new Date().toISOString();
  requests = 0;
  bytes = 0;
  normalizedRows = 0;
  normalizedBytes = 0;
  constructor(callerSignal: AbortSignal, plannedRequests = 1) {
    this.signal = AbortSignal.any([
      callerSignal,
      this.controller.signal,
      AbortSignal.timeout(40_000),
    ]);
    this.preflight(plannedRequests);
  }
  /** Reject a plan before the first network operation. */
  preflight(plannedRequests: number): void {
    if (plannedRequests > 64)
      throw validationError(
        'Request plan exceeds 64 upstream calls; use fewer explicit areas or a shorter drought_get_timeseries range.',
        { reason: 'dataset_too_large', plannedRequests, maxRequests: 64 },
      );
  }
  /** Account a logical request once, outside its retry loop. */
  claim(url: string): void {
    this.signal.throwIfAborted();
    if (++this.requests > 64) this.exceeded('request_plan');
    this.sourceUrls.add(url);
  }
  /** Account all source bytes, including discarded rows and retry bodies. */
  consume(bytes: number): void {
    this.bytes += bytes;
    if (this.bytes > 64 * MiB) this.exceeded('upstream_bytes');
  }
  /** Bound retained normalized observations across every call in this workflow. */
  retain(row: unknown): void {
    this.signal.throwIfAborted();
    this.normalizedRows++;
    this.normalizedBytes += Buffer.byteLength(JSON.stringify(row));
    if (this.normalizedRows > 250_000 || this.normalizedBytes > 64 * MiB)
      this.exceeded('normalized_data');
  }
  /** Abort sibling work with the same actionable dataset error. */
  exceeded(component: string): never {
    try {
      tooLarge(component);
    } catch (error) {
      this.controller.abort(error);
      throw error;
    }
  }
}
/** One selector request, with the exact canonical identities allowed in its response. */
export interface ObservationQuery {
  aoi: string;
  areas: Area[];
  areaType: AreaType;
  endDate: string;
  filterToRequested?: boolean;
  hucLevel?: HucLevel;
  startDate: string;
}
/** Metrics add only the documented metric and statistics representation. */
export interface MetricQuery extends ObservationQuery {
  metric: Metric;
  statisticsType: StatisticsType;
}
/** County threshold request, scoped to explicit supported state postal selectors. */
export interface WeeksQuery {
  endDate: string;
  minCategory: 'D0' | 'D1' | 'D2' | 'D3' | 'D4';
  minWeeks: number;
  mode: 'consecutive' | 'non_consecutive';
  startDate: string;
  states: string[];
}

let active = 0;
const waiters: (() => void)[] = [];
async function slot(signal: AbortSignal): Promise<() => void> {
  while (active >= 3) {
    await new Promise<void>((resolve, reject) => {
      const wake = () => {
        signal.removeEventListener('abort', abort);
        resolve();
      };
      const abort = () => {
        const index = waiters.indexOf(wake);
        if (index >= 0) waiters.splice(index, 1);
        reject(signal.reason);
      };
      signal.throwIfAborted();
      waiters.push(wake);
      signal.addEventListener('abort', abort, { once: true });
    });
  }
  signal.throwIfAborted();
  active++;
  return () => {
    active--;
    waiters.shift()?.();
  };
}
/** Small typed boundary replacing repeated upstream path, query and identity logic. */
export class UsdmClient {
  constructor(private readonly fetcher: typeof fetch = fetch) {}

  private async request(
    path: string,
    parameters: Record<string, string>,
    budget: RequestBudget,
  ): Promise<unknown[]> {
    const url = new URL(`/api/${path}`, USDM_ORIGIN);
    for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, value);
    budget.claim(url.href);
    const release = await slot(budget.signal);
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const attemptController = new AbortController();
        const signal = AbortSignal.any([
          budget.signal,
          attemptController.signal,
          AbortSignal.timeout(15_000),
        ]);
        let retryAfterMs = 500;
        try {
          const response = await this.fetcher(url, {
            headers: { Accept: 'application/json' },
            redirect: 'error',
            signal,
          });
          const retryAfter = response.headers.get('retry-after');
          if (retryAfter) {
            const seconds = Number(retryAfter);
            retryAfterMs = Number.isFinite(seconds)
              ? Math.max(500, seconds * 1000)
              : Math.max(500, Date.parse(retryAfter) - Date.now());
          }
          const reader = response.body?.getReader();
          const chunks: Uint8Array[] = [];
          let bytes = 0;
          if (reader) {
            try {
              while (true) {
                signal.throwIfAborted();
                const chunk = await reader.read();
                if (chunk.done) break;
                bytes += chunk.value.byteLength;
                budget.consume(chunk.value.byteLength);
                if (bytes > 16 * MiB) budget.exceeded('upstream_response');
                chunks.push(chunk.value);
              }
            } finally {
              await reader.cancel().catch(() => undefined);
              reader.releaseLock();
            }
          }
          const body = Buffer.concat(chunks).toString('utf8');
          if (!response.ok) {
            if (response.status === 429 || response.status >= 500)
              throw serviceUnavailable(
                `USDM returned HTTP ${response.status}; retry the drought tool later.`,
                { retryable: true },
              );
            throw validationError(
              `USDM rejected the selector or date request (HTTP ${response.status}); check the drought reference identifiers.`,
              { retryable: false },
            );
          }
          if (/^\s*<(?:!doctype\s+html|html[\s>])/i.test(body))
            throw serviceUnavailable(
              'USDM returned an HTML response; retry the drought tool later.',
              { retryable: true },
            );
          let json: unknown;
          try {
            json = JSON.parse(body);
          } catch {
            return shape('USDM returned malformed JSON.');
          }
          if (!Array.isArray(json)) return shape('USDM success response was not an array.');
          return json;
        } catch (error) {
          budget.signal.throwIfAborted();
          const retryable = error instanceof McpError ? error.data?.retryable === true : true;
          if (!retryable || attempt === 1) {
            if (error instanceof McpError) throw error;
            throw serviceUnavailable(
              'USDM could not complete the request; retry the drought tool later.',
              { retryable: true },
            );
          }
          await delay(Math.min(retryAfterMs, 40_000), undefined, { signal: budget.signal });
        }
      }
      throw new Error('Unreachable retry state');
    } finally {
      release();
    }
  }
  private parameters(query: ObservationQuery): Record<string, string> {
    calendarDate(query.startDate);
    calendarDate(query.endDate);
    if (query.startDate > query.endDate)
      throw validationError('startDate must not follow endDate.', { reason: 'invalid_date_range' });
    if (
      !query.aoi ||
      query.aoi.length > 2048 ||
      !query.areas.length ||
      query.areas.some((area) => area.areaType !== query.areaType)
    )
      throw validationError('A canonical selector and its resolved areas are required.', {
        reason: 'invalid_area',
      });
    if (query.areaType === 'huc' && !query.hucLevel)
      throw validationError('HUC calls require hucLevel.', { reason: 'invalid_area' });
    return {
      aoi: query.aoi,
      startdate: upstreamDate(query.startDate),
      enddate: upstreamDate(query.endDate),
      ...(query.areaType === 'huc' ? { hucLevel: String(query.hucLevel) } : {}),
    };
  }
  private identity(raw: Raw, query: ObservationQuery): Area | undefined {
    let id: string | undefined;
    if (query.areaType === 'us') id = (raw.areaOfInterest ?? raw.name)?.toLowerCase();
    else if (query.areaType === 'county') id = raw.fips ?? undefined;
    else if (query.areaType === 'huc') id = raw.hucid ?? raw.hucId ?? undefined;
    else if (query.areaType === 'state') {
      const label = raw.stateAbbreviation ?? raw.name ?? raw.state;
      const state = referenceBundle.states.find(
        (area) =>
          area.id === label ||
          area.state === label ||
          (label && normalizeName(area.name) === normalizeName(label)),
      );
      if (!state) return shape('USDM returned an unmatched state label.');
      id = state.id;
    } else {
      if (query.areas.length !== 1)
        return shape('Tribal and climate division requests require a single canonical selector.');
      id = query.areas[0]?.id;
    }
    if (!id) return shape('USDM omitted the geography identity.');
    const area = query.areas.find((area) => area.id === id);
    if (!area) {
      if (
        query.areaType === 'county' &&
        query.filterToRequested &&
        /^\d{5}$/.test(id) &&
        raw.state &&
        query.aoi.split(',').includes(raw.state)
      )
        return undefined;
      return shape();
    }
    const tribalName = typeof raw.tribalName === 'string' ? raw.tribalName : undefined;
    const climateName = typeof raw.region === 'string' ? raw.region : undefined;
    return {
      ...area,
      name:
        raw.county ??
        (query.areaType === 'state'
          ? area.name
          : (raw.huc ?? raw.name ?? tribalName ?? climateName)) ??
        area.name,
      ...(raw.state ? { state: raw.state } : {}),
    };
  }
  private normalize<T>(
    rows: unknown[],
    query: ObservationQuery,
    budget: RequestBudget,
    project: (raw: Raw, area: Area, date: string) => T,
  ): T[] {
    const seen = new Set<string>();
    const output: T[] = [];
    for (const value of rows) {
      budget.signal.throwIfAborted();
      const parsed = RawRow.safeParse(value);
      if (!parsed.success) return shape();
      const raw = parsed.data;
      let date: string;
      try {
        date = sourceDate(raw.mapDate);
      } catch {
        return shape();
      }
      if (
        date < query.startDate ||
        date > query.endDate ||
        new Date(`${date}T00:00:00Z`).getUTCDay() !== 2
      )
        return shape();
      const area = this.identity(raw, query);
      if (!area) continue;
      const key = `${area.id}:${date}`;
      if (seen.has(key)) return shape('USDM returned duplicate geography/date observations.');
      seen.add(key);
      const row = project(raw, area, date);
      budget.retain(row);
      output.push(row);
    }
    return output;
  }
  /** Fetch metric observations with explicit bucket names and units. */
  async metric(query: MetricQuery, budget: RequestBudget): Promise<MetricObservation[]> {
    if (
      query.metric.startsWith('population_') &&
      !['us', 'state', 'county'].includes(query.areaType)
    )
      throw validationError('Population is supported only for US, state and county areas.', {
        reason: 'unsupported_metric',
      });
    const rows = await this.request(
      `${families[query.areaType]}/${endpoints[query.metric]}`,
      {
        ...this.parameters(query),
        statisticsType: query.statisticsType === 'cumulative' ? '1' : '2',
      },
      budget,
    );
    return this.normalize(rows, query, budget, (raw, area, date) => {
      if (['none', 'd0', 'd1', 'd2', 'd3', 'd4'].some((key) => !Object.hasOwn(raw, key)))
        return shape('USDM omitted required metric buckets.');
      try {
        if (
          (raw.validStart && sourceDate(raw.validStart) !== date) ||
          (raw.validEnd && sourceDate(raw.validEnd) !== addDays(date, 6))
        )
          return shape('USDM returned an incompatible map validity interval.');
      } catch {
        return shape('USDM returned a malformed map validity interval.');
      }
      const values = [raw.none, raw.d0, raw.d1, raw.d2, raw.d3, raw.d4].map(
        (value) => value ?? null,
      );
      if (
        values.some(
          (value) =>
            value !== null && (value < 0 || (query.metric.endsWith('percent') && value > 100)),
        )
      )
        return shape();
      const keys =
        query.statisticsType === 'cumulative'
          ? ['none', 'd0_d4', 'd1_d4', 'd2_d4', 'd3_d4', 'd4']
          : ['none', 'd0_only', 'd1_only', 'd2_only', 'd3_only', 'd4_only'];
      return {
        ...area,
        mapDate: date,
        validStart: date,
        validEnd: addDays(date, 6),
        metric: query.metric,
        statisticsType: query.statisticsType,
        unit: metricUnit(query.metric),
        buckets: Object.fromEntries(keys.map((key, index) => [key, values[index]])) as Buckets,
      };
    });
  }
  /** Fetch upstream DSCI, never derive an index from rounded buckets. */
  async dsci(query: ObservationQuery, budget: RequestBudget): Promise<DsciObservation[]> {
    const rows = await this.request(
      `${families[query.areaType]}/GetDSCI`,
      this.parameters(query),
      budget,
    );
    return this.normalize(rows, query, budget, (raw, area, date) => ({
      ...area,
      mapDate: date,
      dsci: raw.dsci ?? null,
    }));
  }
  /** Fetch authoritative county week counts or full streaks. */
  async weeks(query: WeeksQuery, budget: RequestBudget): Promise<WeeksObservation[]> {
    calendarDate(query.startDate);
    calendarDate(query.endDate);
    if (query.startDate > query.endDate)
      throw validationError('startDate must not follow endDate.', { reason: 'invalid_date_range' });
    if (
      !query.states.length ||
      query.states.some((state) => !referenceBundle.states.some((row) => row.state === state)) ||
      !Number.isSafeInteger(query.minWeeks) ||
      query.minWeeks < 1
    )
      throw validationError('Supply supported state postal codes and a positive minWeeks.', {
        reason: 'invalid_area',
      });
    const consecutive = query.mode === 'consecutive';
    const rows = await this.request(
      `ConsecutiveNonConsecutiveStatistics/${consecutive ? 'GetConsecutiveWeeksCounty' : 'GetNonConsecutiveStatisticsCounty'}`,
      {
        aoi: query.states.join(','),
        startdate: upstreamDate(query.startDate),
        enddate: upstreamDate(query.endDate),
        dx: query.minCategory.slice(1),
        minimumweeks: String(query.minWeeks),
      },
      budget,
    );
    const schema = z.object({
      fips: z.string().regex(/^\d{5}$/),
      county: z.string(),
      state: z.string(),
      ...(consecutive
        ? {
            startDate: z.string(),
            endDate: z.string(),
            consecutiveWeeks: z.number().int().positive(),
          }
        : { nonConsecutiveWeeks: z.number().int().positive() }),
    });
    const seen = new Set<string>();
    return rows.map((row) => {
      const parsed = schema.safeParse(row);
      if (!parsed.success) return shape();
      const raw = parsed.data;
      if (!query.states.includes(raw.state)) return shape();
      const item: WeeksObservation = { fips: raw.fips, county: raw.county, state: raw.state };
      if (
        'startDate' in raw &&
        typeof raw.startDate === 'string' &&
        'endDate' in raw &&
        typeof raw.endDate === 'string' &&
        'consecutiveWeeks' in raw &&
        typeof raw.consecutiveWeeks === 'number'
      ) {
        try {
          item.startDate = sourceDate(raw.startDate);
          item.endDate = sourceDate(raw.endDate);
        } catch {
          return shape();
        }
        item.consecutiveWeeks = raw.consecutiveWeeks;
        if (
          item.startDate < query.startDate ||
          item.endDate > addDays(query.endDate, 6) ||
          item.endDate < item.startDate ||
          addDays(item.startDate, raw.consecutiveWeeks * 7 - 1) !== item.endDate
        )
          return shape();
      }
      if ('nonConsecutiveWeeks' in raw && typeof raw.nonConsecutiveWeeks === 'number')
        item.nonConsecutiveWeeks = raw.nonConsecutiveWeeks;
      const key = `${item.fips}:${item.startDate ?? ''}`;
      if (seen.has(key)) return shape();
      seen.add(key);
      budget.retain(item);
      return item;
    });
  }
}
/** Process-shared default client; tests can inject fetch through the constructor. */
export const usdmClient = new UsdmClient();
