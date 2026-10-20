/**
 * @fileoverview Complete reference paging and geography resolution boundaries.
 * @module tests/services/drought/reference-data
 */
import { describe, expect, it } from 'vitest';
import {
  listReference,
  referenceBundle,
  resolveGeography,
  resolveState,
} from '@/services/drought/reference-data.js';

describe('official references', () => {
  it('resolves state aliases and scoped counties while retaining zeroes', () => {
    for (const aoi of ['AL', 'al', '01', ' Alabama ']) expect(resolveState(aoi).id).toBe('01');
    expect(
      resolveGeography({ areaType: 'county', aoi: 'Autauga County, Alabama' }).areas[0]?.id,
    ).toBe('01001');
    expect(resolveGeography({ areaType: 'county', aoi: '01001' }).requiresLookup).toBe(false);
    expect(() => resolveGeography({ areaType: 'county', aoi: 'Washington County' })).toThrow();
  });
  it('retains current and historical Connecticut identifiers', () => {
    const rows = referenceBundle.counties.filter((row) => row.state === 'CT');
    expect(rows.some((row) => row.currentUsdm === true)).toBe(true);
    expect(rows.some((row) => row.currentUsdm === false)).toBe(true);
    for (const row of rows)
      expect(resolveGeography({ areaType: 'county', aoi: row.id }).areas[0]?.id).toBe(row.id);
  });
  it.each([2, 4, 6, 8] as const)('preserves HUC width %i', (hucLevel) => {
    const row = referenceBundle.huc.find(
      (item) => item.hucLevel === hucLevel && item.id.startsWith('0'),
    );
    if (!row) throw new Error('Missing leading-zero HUC');
    expect(resolveGeography({ areaType: 'huc', aoi: row.id, hucLevel }).areas[0]?.id).toBe(row.id);
    expect(() => resolveGeography({ areaType: 'huc', aoi: row.id.slice(1), hucLevel })).toThrow();
  });
  it('distinguishes malformed from unknown numeric identifiers', () => {
    expect(resolveGeography({ areaType: 'county', aoi: '99999' })).toMatchObject({
      requiresLookup: true,
      areas: [{ id: '99999' }],
    });
    expect(resolveGeography({ areaType: 'state', aoi: '99' }).requiresLookup).toBe(true);
    for (const aoi of ['1001', '010001'])
      expect(() => resolveGeography({ areaType: 'county', aoi })).toThrow();
  });
  it('filters complete families before pagination and traverses each record once', () => {
    const expected = referenceBundle.counties.filter((row) => row.state === 'TX');
    const ids: string[] = [];
    let cursor: string | undefined;
    do {
      const page = listReference({
        topic: 'counties',
        state: 'Texas',
        limit: 7,
        ...(cursor ? { cursor } : {}),
      });
      expect(page.totalCount).toBe(expected.length);
      ids.push(...page.records.map((row) => row.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(ids).toEqual(expected.map((row) => row.id));
    expect(new Set(ids).size).toBe(ids.length);
    const last = expected.at(-1);
    if (!last) throw new Error('Missing Texas county');
    expect(
      listReference({ topic: 'counties', state: 'TX', nameContains: last.name, limit: 1 }).records,
    ).toContainEqual(last);
  });
  it('binds continuation to normalized filters and validates its offset', () => {
    const first = listReference({ topic: 'counties', state: 'TX', limit: 1 });
    const cursor = first.nextCursor;
    if (!cursor) throw new Error('Expected continuation');
    expect(
      listReference({ topic: 'counties', state: 'Texas', limit: 2, cursor }).records,
    ).toHaveLength(2);
    for (const state of ['WA', 'CA'])
      expect(() => listReference({ topic: 'counties', state, cursor })).toThrow();
    expect(() => listReference({ topic: 'states', cursor })).toThrow();
    const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString());
    for (const offset of [-1, 1.5, first.totalCount, Number.MAX_VALUE])
      expect(() =>
        listReference({
          topic: 'counties',
          state: 'TX',
          cursor: Buffer.from(JSON.stringify({ ...decoded, offset })).toString('base64url'),
        }),
      ).toThrow();
    expect(() => listReference({ topic: 'counties', cursor: 'invalid' })).toThrow();
  });
  it('rejects irrelevant filters and returns an empty matching family honestly', () => {
    expect(() => listReference({ topic: 'states', state: 'WA' })).toThrow();
    expect(() => listReference({ topic: 'counties', hucLevel: 2 })).toThrow();
    expect(() => listReference({ topic: 'huc' })).toThrow();
    expect(listReference({ topic: 'states', nameContains: 'No such reference qzx' })).toMatchObject(
      { records: [], totalCount: 0, hasMore: false, nextCursor: null },
    );
  });
  it('rejects ambiguous normalized county names rather than selecting the first identifier', () => {
    const fixture = {
      areaType: 'county' as const,
      id: '01999',
      name: 'Autauga County',
      state: 'AL',
      sourceVintage: 'Ambiguity fixture',
    };
    referenceBundle.counties.push(fixture);
    try {
      expect(() => resolveGeography({ areaType: 'county', aoi: 'Autauga County, AL' })).toThrow(
        expect.objectContaining({ data: expect.objectContaining({ reason: 'ambiguous_area' }) }),
      );
    } finally {
      referenceBundle.counties.splice(referenceBundle.counties.indexOf(fixture), 1);
    }
  });
  it('rejects a single oversized reference record instead of returning a nonadvancing cursor', () => {
    const fixture = {
      areaType: 'county' as const,
      id: '01999',
      name: 'Oversized fixture '.repeat(6000),
      state: 'AL',
      sourceVintage: 'Budget fixture',
    };
    referenceBundle.counties.push(fixture);
    try {
      expect(() =>
        listReference({ topic: 'counties', nameContains: 'Oversized fixture', limit: 1 }),
      ).toThrow(
        expect.objectContaining({ data: expect.objectContaining({ reason: 'dataset_too_large' }) }),
      );
    } finally {
      referenceBundle.counties.splice(referenceBundle.counties.indexOf(fixture), 1);
    }
  });
});
