/**
 * @fileoverview Bounded inline snapshots and authenticated producer continuation.
 * @module services/drought/producer-pagination
 */
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Context } from '@cyanheads/mcp-ts-core';
import { McpError, validationError } from '@cyanheads/mcp-ts-core/errors';
import { getCanvas } from '../canvas-accessor.js';
import type { DroughtService } from './drought-service.js';

type Results = {
  timeseries: Awaited<ReturnType<DroughtService['timeseries']>>;
  comparison: Awaited<ReturnType<DroughtService['compare']>>;
};
type Kind = keyof Results;
type Snapshot<K extends Kind = Kind> = {
  kind: K;
  tenant: string;
  binding: string;
  result: Results[K];
  limit: number;
  bytes: number;
  expiresAt: number;
};
type Page = { nextCursor?: string | null; hasMore?: boolean };
const snapshots = new Map<string, Snapshot>();
const signingKey = randomBytes(32);
const retentionMs = 300_000;
const maxEntries = 32;
const maxBytes = 64 * 1024 * 1024;
let retainedBytes = 0;

function invalidCursor(): never {
  throw validationError('Producer cursor is invalid, expired, or the filters changed.', {
    reason: 'invalid_cursor',
  });
}
function remove(id: string, snapshot: Snapshot) {
  snapshots.delete(id);
  retainedBytes -= snapshot.bytes;
}
function prune() {
  const now = Date.now();
  for (const [id, snapshot] of snapshots) if (snapshot.expiresAt <= now) remove(id, snapshot);
}
function signature(position: string) {
  return createHmac('sha256', signingKey).update(position).digest('base64url');
}
function readPosition(cursor: string) {
  const match = /^([a-f0-9-]{36})\.([1-9][0-9]{0,5})\.([A-Za-z0-9_-]{43})$/.exec(cursor);
  const [, id, offset, mac] = match ?? [];
  if (!id || !offset || !mac) invalidCursor();
  if (!timingSafeEqual(Buffer.from(mac), Buffer.from(signature(`${id}.${offset}`))))
    invalidCursor();
  return { id, offset: Number(offset) };
}
function isSnapshotOf<K extends Kind>(
  snapshot: Snapshot | undefined,
  kind: K,
): snapshot is Snapshot<K> {
  return snapshot?.kind === kind;
}
function page<Result extends { rows: unknown[] }>(
  result: Result,
  limit: number,
  offset: number,
  id?: string,
): Result & Page {
  const rows = result.rows.slice(offset, offset + limit);
  const next = offset + rows.length;
  const position = id && next < result.rows.length ? `${id}.${next}` : null;
  return {
    ...result,
    rows,
    nextCursor: position ? `${position}.${signature(position)}` : null,
    hasMore: position !== null,
  };
}
/** Use a staged exact preview or page an inline snapshot without reacquiring its rows. */
export async function pageProducer<K extends Kind>(
  kind: K,
  input: { cursor?: string | undefined; canvas_id?: string | undefined },
  limit: number | undefined,
  ctx: Context,
  bind: () => string,
  acquire: () => Promise<Results[K]>,
): Promise<{ result: Results[K] & Page; effective: number | undefined }> {
  const tenant = ctx.tenantId ?? 'default';
  const hasProvider = getCanvas() !== undefined;
  if (input.cursor !== undefined && (hasProvider || !input.canvas_id)) {
    ctx.signal.throwIfAborted();
    if (hasProvider) invalidCursor();
    prune();
    const { id, offset } = readPosition(input.cursor);
    const snapshot = snapshots.get(id);
    if (
      !isSnapshotOf(snapshot, kind) ||
      snapshot.tenant !== tenant ||
      offset >= snapshot.result.rows.length
    )
      invalidCursor();
    let binding: string;
    try {
      binding = bind();
    } catch (error) {
      if (error instanceof McpError) invalidCursor();
      throw error;
    }
    if (binding !== snapshot.binding) invalidCursor();
    snapshots.delete(id);
    snapshots.set(id, snapshot);
    const effective = limit ?? snapshot.limit;
    return { result: page(snapshot.result, effective, offset, id), effective };
  }
  const inline = limit !== undefined && !hasProvider && !input.canvas_id;
  const result = await acquire();
  if (!inline) return { result, effective: limit };
  ctx.signal.throwIfAborted();
  if (result.rows.length <= limit) return { result: page(result, limit, 0), effective: limit };
  const entry = {
    kind,
    tenant,
    binding: bind(),
    result,
    limit,
    expiresAt: Date.now() + retentionMs,
  };
  const bytes = Buffer.byteLength(JSON.stringify(entry));
  if (bytes > maxBytes)
    throw validationError('The complete snapshot exceeds retention capacity.', {
      reason: 'dataset_too_large',
      component: 'producer_snapshot',
    });
  prune();
  for (const [id, snapshot] of snapshots) {
    if (snapshots.size < maxEntries && retainedBytes + bytes <= maxBytes) break;
    remove(id, snapshot);
  }
  const id = randomUUID();
  snapshots.set(id, { ...entry, bytes });
  retainedBytes += bytes;
  return { result: page(result, limit, 0, id), effective: limit };
}
