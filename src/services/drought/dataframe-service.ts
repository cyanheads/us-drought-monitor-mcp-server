/**
 * @fileoverview Bounded caller-scoped analytical staging, lifecycle metadata and SQL paging.
 * @module services/drought/dataframe-service
 */
import { randomUUID } from 'node:crypto';
import type { Context } from '@cyanheads/mcp-ts-core';
import {
  CANVAS_IDENTIFIER_REGEX,
  type CanvasInstance,
  type ColumnSchema,
  SQL_GATE_REASONS,
} from '@cyanheads/mcp-ts-core/canvas';
import {
  configurationError,
  JsonRpcErrorCode,
  McpError,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import { getCanvas } from '../canvas-accessor.js';
import type { StageProducer, StageRequest } from './drought-service.js';
import { renderFields } from './format.js';
import { boundedMetadata, type MetadataField } from './metadata-pages.js';
import { queryExpression } from './query-expression.js';
import { renderWorkflow } from './workflow-format.js';
import type { StageHandle } from './workflow-schema.js';

type Caller = Context;
type Registration = {
  rows: number;
  bytes: number;
  metadata: Record<string, unknown>;
  expiresAt: string;
};
type Ledger = {
  inFlight: number;
  canvases: Map<
    string,
    { instance: CanvasInstance; owned: boolean; tables: Map<string, Registration> }
  >;
};
const MAX_ROWS = 250_000;
const MAX_BYTES = 64 * 1024 * 1024;
const CANVAS_RECOVERY =
  'Use the npm or Docker analytical installation with @duckdb/node-api and CANVAS_PROVIDER_TYPE=duckdb; MCPB supports inline results only.';
function capacity(expiresAt?: string): never {
  throw new McpError(
    JsonRpcErrorCode.RateLimited,
    'Retained analytical capacity is occupied; reuse a returned canvas_id with a free table slot, or retry after table expiry.',
    {
      reason: 'staging_capacity_exhausted',
      retryable: true,
      ...(expiresAt ? { earliestExpiry: expiresAt } : {}),
    },
  );
}
function busy(): never {
  throw new McpError(
    JsonRpcErrorCode.RateLimited,
    'Analytical work is busy; retry after active workflows or queries complete.',
    { reason: 'staging_busy', retryable: true },
  );
}
function large(component: string): never {
  throw validationError(
    'Narrow dates or areas in drought_get_timeseries or drought_compare_areas and retry.',
    { reason: 'dataset_too_large', component },
  );
}
function reasonOf(error: unknown): string | undefined {
  return error instanceof McpError && typeof error.data?.reason === 'string'
    ? error.data.reason
    : undefined;
}
/** Remove engine payloads, causes and path-bearing binder details at the public boundary. */
function safeError(error: unknown, dropping = false): never {
  const reason = reasonOf(error);
  if (error instanceof Error && error.name === 'AbortError')
    throw new McpError(JsonRpcErrorCode.RequestCancelled, 'Analytical operation cancelled.');
  if (error instanceof Error && error.name === 'TimeoutError')
    throw new McpError(JsonRpcErrorCode.Timeout, 'Analytical operation timed out.');
  if (
    error instanceof Error &&
    'code' in error &&
    ['ERR_MODULE_NOT_FOUND', 'MODULE_NOT_FOUND'].includes(String(error.code))
  )
    throw configurationError(CANVAS_RECOVERY, { reason: 'canvas_unavailable' });
  if (reason === 'canvas_not_found')
    throw new McpError(
      JsonRpcErrorCode.NotFound,
      dropping
        ? 'Nothing remains to remove; use drought_dataframe_describe only with another canvas_id already returned to you.'
        : 'Canvas is unavailable; re-run drought_get_timeseries or drought_compare_areas and use its canvas_id.',
      { reason },
    );
  if (reason === 'canvas_capacity_exhausted')
    throw new McpError(
      JsonRpcErrorCode.RateLimited,
      'Reuse a canvas_id already returned by drought_get_timeseries or drought_compare_areas, or retry after expiry.',
      { reason, retryable: true },
    );
  if (reason === 'missing_table')
    throw new McpError(
      JsonRpcErrorCode.NotFound,
      'Call drought_dataframe_describe with the same canvas_id, or re-stage the data.',
      { reason },
    );
  if (reason === 'invalid_sql' || reason === 'sql_parse_error')
    throw validationError(
      'SQL could not bind or parse; inspect columns with drought_dataframe_describe and retry.',
      { reason: 'invalid_sql' },
    );
  if (reason === 'sql_execution_error')
    throw validationError(
      'SQL could not evaluate these rows; retry using TRY_CAST or a narrower filter.',
      { reason },
    );
  if (reason === 'sql_read_only' || Object.values(SQL_GATE_REASONS).some((item) => item === reason))
    throw validationError('Query only staged tables using a single read expression.', {
      reason: 'sql_read_only',
      category: reason,
    });
  if (
    error instanceof McpError &&
    [JsonRpcErrorCode.RequestCancelled, JsonRpcErrorCode.Timeout].includes(error.code)
  )
    throw new McpError(
      error.code,
      error.code === JsonRpcErrorCode.Timeout
        ? 'Analytical operation timed out.'
        : 'Analytical operation cancelled.',
    );
  if (error instanceof McpError && error.code === JsonRpcErrorCode.ConfigurationError)
    throw configurationError(CANVAS_RECOVERY, { reason: 'canvas_unavailable' });
  throw new McpError(
    JsonRpcErrorCode.DatabaseError,
    'The analytical engine could not complete the operation; retry with a smaller query.',
  );
}
function engine() {
  const canvas = getCanvas();
  if (!canvas) throw configurationError(CANVAS_RECOVERY, { reason: 'canvas_unavailable' });
  return canvas;
}
function fits(value: unknown, render: (value: unknown) => string = renderWorkflow): boolean {
  return JSON.stringify(value).length <= 80_000 && render(value).length <= 80_000;
}
function identifier(value: string): void {
  if (!CANVAS_IDENTIFIER_REGEX.test(value))
    throw validationError('Use a table_name returned by drought_dataframe_describe.', {
      reason: 'missing_table',
    });
}

/** Process-local quotas; no user store or hidden caller context is involved. */
export class DataframeService {
  private readonly tenants = new Map<string, Ledger>();
  private inFlight = 0;
  private queries = 0;
  private descriptions = 0;
  private tail: Promise<void> = Promise.resolve();

  private async locked<T>(work: () => Promise<T> | T): Promise<T> {
    const previous = this.tail;
    const { promise, resolve: unlock } = Promise.withResolvers<void>();
    this.tail = promise;
    await previous;
    try {
      return await work();
    } finally {
      unlock();
    }
  }
  private prune(): void {
    for (const [tenant, ledger] of this.tenants)
      if (!ledger.inFlight && !ledger.canvases.size) this.tenants.delete(tenant);
  }
  private touch(tenant: string | undefined, id: string): void {
    const canvases = this.tenants.get(tenant ?? 'default')?.canvases;
    const entry = canvases?.get(id);
    if (canvases && entry) {
      canvases.delete(id);
      canvases.set(id, entry);
    }
  }
  private async reconcile(): Promise<void> {
    for (const ledger of this.tenants.values())
      for (const [id, entry] of ledger.canvases) {
        // Once empty, bookkeeping must not slide a borrowed canvas's idle expiry.
        if (!entry.tables.size && Date.now() < Date.parse(entry.instance.expiresAt)) continue;
        try {
          const tables = await entry.instance.describe();
          const names = new Set(tables.map((table) => table.name));
          for (const name of entry.tables.keys()) if (!names.has(name)) entry.tables.delete(name);
          for (const table of tables) {
            const retained = entry.tables.get(table.name);
            if (retained && table.expiresAt) retained.expiresAt = table.expiresAt;
          }
        } catch (error) {
          if (reasonOf(error) === 'canvas_not_found') ledger.canvases.delete(id);
          else safeError(error);
        }
      }
    this.prune();
  }
  private async reclaimEmpty(ctx: Caller): Promise<void> {
    for (const [tenant, ledger] of this.tenants)
      for (const [id, entry] of ledger.canvases) {
        if (
          !entry.owned ||
          entry.tables.size ||
          this.queries ||
          this.descriptions ||
          ledger.inFlight > (tenant === (ctx.tenantId ?? 'default') ? 1 : 0)
        )
          continue;
        try {
          if ((await entry.instance.describe()).length) continue;
          if (this.queries || this.descriptions) continue;
          await engine().drop(id, { ...ctx, tenantId: tenant });
          ledger.canvases.delete(id);
        } catch (error) {
          if (reasonOf(error) === 'canvas_not_found') ledger.canvases.delete(id);
          else safeError(error);
        }
      }
    this.prune();
  }
  /** Admit before any domain fetch, releasing the slot even for inline and empty output. */
  async withAdmission<T>(ctx: Caller, work: (stage: StageProducer) => Promise<T>): Promise<T> {
    ctx.signal.throwIfAborted();
    await this.locked(async () => {
      await this.reconcile();
      let ledger = this.tenants.get(ctx.tenantId ?? 'default');
      if (
        this.inFlight >= 2 ||
        (ledger?.inFlight ?? 0) >= 2 ||
        (!ledger && this.tenants.size >= 128)
      )
        busy();
      if (!ledger) {
        ledger = { inFlight: 0, canvases: new Map() };
        this.tenants.set(ctx.tenantId ?? 'default', ledger);
      }
      ledger.inFlight++;
      this.inFlight++;
    });
    try {
      ctx.signal.throwIfAborted();
      return await work((request) => this.stage(request, ctx));
    } finally {
      await this.locked(() => {
        const ledger = this.tenants.get(ctx.tenantId ?? 'default');
        if (ledger) ledger.inFlight--;
        this.inFlight--;
        this.prune();
      });
    }
  }
  /** Stage complete rows only inside withAdmission; selection never alters stored data. */
  async stage(request: StageRequest, ctx: Caller): ReturnType<StageProducer> {
    request.signal.throwIfAborted();
    const metadata = JSON.parse(JSON.stringify(request.metadata)) as Record<string, unknown>;
    if (request.kind === 'timeseries')
      metadata.bucketColumnMapping = Object.fromEntries(
        [
          ...new Set(
            request.rows.flatMap((row) => ('buckets' in row ? Object.keys(row.buckets) : [])),
          ),
        ].map((name) => [`buckets.${name}`, name]),
      );
    let responseMetadata =
      request.kind === 'timeseries'
        ? boundedMetadata(
            metadata,
            (value) =>
              JSON.stringify(value).length <= 40_000 && fits({ ...value, rows: [], staging: null }),
          )
        : metadata;
    if (JSON.stringify(responseMetadata).length > 40_000) large('table_metadata');
    if (!fits({ ...responseMetadata, rows: [], staging: null })) large('response_metadata');
    const metadataBytes = Buffer.byteLength(JSON.stringify(metadata));
    let bytes = 2;
    let characters = 2;
    for (const [index, row] of request.rows.entries()) {
      const json = JSON.stringify(row);
      bytes += Buffer.byteLength(json) + (index ? 1 : 0);
      characters += json.length + (index ? 1 : 0);
      if (index >= MAX_ROWS || bytes > MAX_BYTES) large('table_rows');
    }
    let previewCount = 0;
    let previewCharacters = 2;
    for (const row of request.rows) {
      const size = JSON.stringify(row).length + (previewCount ? 1 : 0);
      if (
        previewCount >= (request.limit ?? request.rows.length) ||
        previewCharacters + size > 40_000
      )
        break;
      previewCount++;
      previewCharacters += size;
    }
    const rows = request.rows.slice(0, previewCount);
    while (
      rows.length &&
      (JSON.stringify(rows).length > 40_000 || !fits({ ...responseMetadata, rows, staging: null }))
    )
      rows.pop();
    if (
      responseMetadata === metadata &&
      (!request.rows.length || (characters <= 40_000 && rows.length === request.rows.length))
    )
      return { rows: request.rows, staging: null };
    return await this.locked(async () => {
      await this.reconcile();
      if (!request.canvas_id) await this.reclaimEmpty(ctx);
      const ledger = this.tenants.get(ctx.tenantId ?? 'default');
      if (!ledger?.inFlight) throw new Error('Staging requires an admitted workflow.');
      let retainedRows = 0;
      let retainedBytes = 0;
      const earliestExpiry = [...ledger.canvases.values()]
        .flatMap((entry) => [...entry.tables.values()].map((table) => table.expiresAt))
        .sort()[0];
      for (const entry of ledger.canvases.values())
        for (const table of entry.tables.values()) {
          retainedRows += table.rows;
          retainedBytes += table.bytes;
        }
      if (
        retainedRows + request.rows.length > MAX_ROWS ||
        retainedBytes + bytes + metadataBytes > MAX_BYTES
      )
        capacity(earliestExpiry);
      let reuseId = request.canvas_id;
      if (
        !reuseId &&
        [...this.tenants.values()].reduce((count, tenant) => count + tenant.canvases.size, 0) >= 4
      ) {
        for (const [id, entry] of [...ledger.canvases].reverse()) {
          if (entry.owned && (await entry.instance.describe()).length < 8) {
            reuseId = id;
            break;
          }
        }
        if (!reuseId)
          capacity(
            [...this.tenants.values()]
              .flatMap((tenant) =>
                [...tenant.canvases.values()].flatMap((entry) =>
                  [...entry.tables.values()].map((table) => table.expiresAt),
                ),
              )
              .sort()[0],
          );
      }
      const canvas = engine();
      let instance: CanvasInstance | undefined;
      const name = `drought_${randomUUID().replaceAll('-', '')}`;
      const keys = [
        ...new Set(
          request.rows.flatMap((row) => [
            ...Object.keys(row).filter((key) => key !== 'buckets'),
            ...('buckets' in row ? Object.keys(row.buckets) : []),
          ]),
        ),
      ];
      if (!keys.length) keys.push('row_id');
      const schema: ColumnSchema[] = keys.map((key) => ({
        name: key,
        type: ['row_id', 'rank', 'dsci', 'hucLevel'].includes(key)
          ? 'INTEGER'
          : ['mapDate', 'validStart', 'validEnd'].includes(key)
            ? 'DATE'
            : [
                  'targetValue',
                  'baselineValue',
                  'change',
                  'rankedValue',
                  'none',
                  'd0_d4',
                  'd1_d4',
                  'd2_d4',
                  'd3_d4',
                  'd4',
                  'd0_only',
                  'd1_only',
                  'd2_only',
                  'd3_only',
                  'd4_only',
                ].includes(key)
              ? 'DOUBLE'
              : 'VARCHAR',
        nullable: true,
      }));
      const handleFields = {
        table_name: name,
        row_count: request.rows.length,
        columns: schema.map((column) => ({
          name: column.name,
          type: column.type,
          unit:
            column.name === 'dsci'
              ? 'index'
              : column.type === 'DOUBLE'
                ? column.name === 'change' && typeof metadata.changeUnit === 'string'
                  ? metadata.changeUnit
                  : typeof metadata.unit === 'string'
                    ? metadata.unit
                    : null
                : null,
        })),
        describe_tool: 'drought_dataframe_describe' as const,
        query_tool: 'drought_dataframe_query' as const,
      };
      // Registry IDs are ten characters; ISO expiries have a fixed encoded width.
      const plannedHandle = {
        ...handleFields,
        canvas_id: request.canvas_id ?? '0000000000',
        expires_at: new Date().toISOString(),
      };
      if (request.kind === 'timeseries')
        responseMetadata = boundedMetadata(
          metadata,
          (value) =>
            JSON.stringify({ ...value, staging: plannedHandle }).length <= 40_000 &&
            fits({ ...value, rows: [], staging: plannedHandle }),
        );
      if (JSON.stringify({ ...responseMetadata, staging: plannedHandle }).length > 40_000)
        large('response_metadata');
      try {
        instance = await canvas.acquire(reuseId, ctx, { signal: request.signal });
        const reused = ledger.canvases.get(instance.canvasId);
        if (reused && request.canvas_id) reused.owned = false;
        const existing = await instance.describe();
        if (existing.length >= 8) capacity(earliestExpiry);
        const flat = request.rows.map((row) => {
          if (!('buckets' in row)) return { ...row };
          const { buckets, ...fields } = row;
          return { ...fields, ...buckets };
        });
        await instance.registerTable(name, flat, {
          schema,
          signal: request.signal,
          ttlMs: 1_800_000,
        });
        request.signal.throwIfAborted();
        const table = (await instance.describe({ tableName: name }))[0];
        if (!table?.expiresAt) throw new Error('Registered table lacks its required expiry.');
        const staging: StageHandle = {
          ...handleFields,
          canvas_id: instance.canvasId,
          expires_at: table.expiresAt,
        };
        while (rows.length && !fits({ ...responseMetadata, rows, staging })) rows.pop();
        if (!fits({ ...responseMetadata, rows, staging })) large('response_envelope');
        let entry = ledger.canvases.get(instance.canvasId);
        if (!entry) {
          entry = { instance, owned: instance.isNew, tables: new Map() };
          ledger.canvases.set(instance.canvasId, entry);
        }
        entry.tables.set(name, {
          rows: request.rows.length,
          bytes: bytes + metadataBytes,
          metadata,
          expiresAt: table.expiresAt,
        });
        ledger.canvases.delete(instance.canvasId);
        ledger.canvases.set(instance.canvasId, entry);
        return {
          rows,
          staging,
          ...(responseMetadata === metadata ? {} : { metadata: responseMetadata }),
        };
      } catch (error) {
        if (instance) {
          try {
            await instance.drop(name);
          } catch {
            /* Expired or failed registrations may already be gone. */
          }
          if (instance.isNew) {
            try {
              if (!(await instance.describe()).length) await canvas.drop(instance.canvasId, ctx);
            } catch {
              /* Registry expiry also releases the new canvas. */
            }
          }
        }
        if (['staging_capacity_exhausted', 'dataset_too_large'].includes(reasonOf(error) ?? ''))
          throw error;
        safeError(error);
      }
    });
  }
  private metadata(tenant: string | undefined, id: string, name: string): Record<string, unknown> {
    return (
      this.tenants
        .get(tenant ?? 'default')
        ?.canvases.get(id)
        ?.tables.get(name)?.metadata ?? {}
    );
  }
  /** Describe only the caller-supplied token; full metadata requires one table. */
  async describe(
    input: {
      canvas_id: string;
      table_name?: string;
      metadata_field?: MetadataField;
      metadata_offset?: number;
      metadata_limit?: number;
    },
    ctx: Caller,
  ) {
    if (input.metadata_field && !input.table_name)
      throw validationError(
        'Supply table_name with metadata_field to page one retained snapshot.',
        { reason: 'invalid_metadata_page' },
      );
    const offset = input.metadata_offset ?? 0;
    const limit = input.metadata_limit ?? 20;
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100
    )
      throw validationError(
        'Use a nonnegative metadata_offset and metadata_limit from 1 through 100.',
        { reason: 'invalid_metadata_page' },
      );
    if (input.table_name) identifier(input.table_name);
    this.descriptions++;
    try {
      const instance = await engine().acquire(input.canvas_id, ctx, { signal: ctx.signal });
      const tables = await instance.describe(
        input.table_name ? { tableName: input.table_name } : {},
      );
      if (input.table_name && !tables.length)
        throw new McpError(JsonRpcErrorCode.NotFound, 'Table is absent.', {
          reason: 'missing_table',
        });
      const result: {
        canvas_id: string;
        expires_at: string;
        tables: {
          name: string;
          kind: 'table' | 'view';
          rowCount: number;
          columns: ColumnSchema[];
          expiresAt: string | null;
          metadata: Record<string, unknown>;
        }[];
        metadata_page?: {
          field: MetadataField;
          items: unknown[];
          total: number;
          offset: number;
          next_offset: number | null;
        };
      } = {
        canvas_id: instance.canvasId,
        expires_at: instance.expiresAt,
        tables: tables.map((table) => ({
          name: table.name,
          kind: table.kind,
          rowCount: table.rowCount,
          columns: table.columns,
          expiresAt: table.expiresAt ?? null,
          metadata: input.table_name
            ? this.metadata(ctx.tenantId, instance.canvasId, table.name)
            : {},
        })),
      };
      if (input.metadata_field && input.table_name) {
        const full = this.metadata(ctx.tenantId, instance.canvasId, input.table_name)[
          input.metadata_field
        ];
        if (!Array.isArray(full))
          throw validationError(
            'The named table has no retained collection for this metadata_field.',
            { reason: 'invalid_metadata_page' },
          );
        result.tables.forEach((table) => {
          table.metadata = {};
        });
        const items = full.slice(offset, offset + limit);
        const page = {
          field: input.metadata_field,
          items,
          total: full.length,
          offset,
          next_offset: null as number | null,
        };
        result.metadata_page = page;
        const pageFits = () =>
          fits(result, renderFields) &&
          JSON.stringify({ tables: result.tables, metadata_page: page }).length <= 40_000;
        while (items.length) {
          page.next_offset = offset + items.length < full.length ? offset + items.length : null;
          if (pageFits()) break;
          items.pop();
        }
        if (offset < full.length && !items.length) large('metadata_page_item');
        page.next_offset = offset + items.length < full.length ? offset + items.length : null;
        if (!pageFits()) large('metadata_page');
      } else if (
        !fits(result, renderFields) ||
        JSON.stringify(result.tables.map((table) => table.metadata)).length > 40_000
      ) {
        for (const table of result.tables) {
          const full = table.metadata;
          table.metadata = boundedMetadata(full, (value) => {
            table.metadata = value;
            return fits(result, renderFields) && JSON.stringify(value).length <= 40_000;
          });
        }
      }
      if (!fits(result, renderFields)) large('table_metadata');
      this.touch(ctx.tenantId, instance.canvasId);
      return result;
    } catch (error) {
      if (['dataset_too_large', 'invalid_metadata_page'].includes(reasonOf(error) ?? ''))
        throw error;
      safeError(error);
    } finally {
      this.descriptions--;
    }
  }
  /** Run the wrapped, sentinel-bounded query through every provider SQL gate. */
  async query(
    input: { canvas_id: string; sql: string; limit: number; offset: number },
    ctx: Caller,
  ) {
    if (this.queries >= 2) busy();
    this.queries++;
    const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(5_000)]);
    try {
      const instance = await engine().acquire(input.canvas_id, ctx, { signal });
      // Original text gates run before the provider parses and checks the wrapped read plan.
      const result = await instance.query(
        `SELECT * FROM (${queryExpression(input.sql)}\n) AS drought_result LIMIT ${input.limit + 1} OFFSET ${input.offset}`,
        { rowLimit: input.limit + 1, denySystemCatalogs: true, signal },
      );
      const tables = await instance.describe();
      const tableMetadata = tables.map((table) => {
        const metadata = this.metadata(ctx.tenantId, instance.canvasId, table.name);
        return { name: table.name, provenance: metadata.provenance ?? null };
      });
      const rows: Record<string, unknown>[] = [];
      let characters = 2;
      for (const row of result.rows.slice(0, input.limit)) {
        const size = JSON.stringify(row).length + (rows.length ? 1 : 0);
        if (characters + size > 40_000) break;
        rows.push(row);
        characters += size;
      }
      const output = () => {
        const has_more = rows.length < result.rows.length || result.truncated === true;
        return {
          canvas_id: instance.canvasId,
          columns: result.columns,
          rows,
          returnedCount: rows.length,
          offset: input.offset,
          next_offset: has_more ? input.offset + rows.length : null,
          has_more,
          countIsExact: input.offset === 0 && !has_more,
          tableMetadata,
        };
      };
      if (JSON.stringify({ ...output(), rows: [] }).length > 40_000)
        throw validationError(
          'Re-stage the needed dataset in a new canvas, then query that canvas.',
          { reason: 'dataset_too_large', component: 'query_metadata' },
        );
      while (rows.length && !fits(output(), renderFields)) rows.pop();
      if ((result.rows.length && !rows.length) || !fits(output(), renderFields))
        throw validationError(
          'Project smaller values with drought_dataframe_query after inspecting columns with drought_dataframe_describe.',
          { reason: 'query_row_too_large' },
        );
      signal.throwIfAborted();
      this.touch(ctx.tenantId, instance.canvasId);
      return output();
    } catch (error) {
      if (['query_row_too_large', 'dataset_too_large'].includes(reasonOf(error) ?? '')) throw error;
      safeError(error);
    } finally {
      this.queries--;
    }
  }
  /** Remove one disposable table; never delete a caller canvas. */
  async drop(input: { canvas_id: string; table_name: string }, ctx: Caller) {
    identifier(input.table_name);
    return await this.locked(async () => {
      try {
        const instance = await engine().acquire(input.canvas_id, ctx, { signal: ctx.signal });
        const dropped = await instance.drop(input.table_name);
        this.tenants
          .get(ctx.tenantId ?? 'default')
          ?.canvases.get(instance.canvasId)
          ?.tables.delete(input.table_name);
        return { canvas_id: instance.canvasId, table_name: input.table_name, dropped };
      } catch (error) {
        safeError(error, true);
      }
    });
  }
}
/** One ledger for all workflows and queries in this process. */
export const dataframeService = new DataframeService();
