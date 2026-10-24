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
  it('filters generated climate divisions by every state alias including USDM Alaska', () => {
    expect(referenceBundle.climateDivisions.every((row) => typeof row.state === 'string')).toBe(
      true,
    );
    const states =
      'AL AZ AR CA CO CT DE FL GA ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY AK'.split(
        ' ',
      );
    for (const division of referenceBundle.climateDivisions)
      expect(division.state).toBe(states[Number(division.id.slice(0, 2)) - 1]);
    expect(new Set(referenceBundle.climateDivisions.map((row) => row.id.slice(0, 2))).size).toBe(
      49,
    );
    for (const state of ['WA', '53', 'Washington']) {
      const page = listReference({ topic: 'climate_divisions', state });
      expect(page.records.map((row) => row.id).sort()).toEqual([
        '4501',
        '4502',
        '4503',
        '4504',
        '4505',
        '4506',
        '4507',
        '4508',
        '4509',
        '4510',
      ]);
    }
    const alaska = listReference({ topic: 'climate_divisions', state: 'AK' }).records;
    expect(alaska).toHaveLength(13);
    expect(alaska.every((row) => row.id.startsWith('49'))).toBe(true);
  });
  it('pages descendants at multiple HUC depths and binds normalized parent filters', () => {
    for (const [parentHuc, hucLevel] of [
      ['17', 4],
      ['1703', 6],
      ['1703', 8],
    ] as const) {
      const ids: string[] = [];
      let cursor: string | undefined;
      do {
        const page = listReference({
          topic: 'huc',
          parentHuc,
          hucLevel,
          limit: 1,
          ...(cursor ? { cursor } : {}),
        });
        ids.push(...page.records.map((row) => row.id));
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      expect(ids).toEqual(
        referenceBundle.huc
          .filter((row) => row.hucLevel === hucLevel && row.id.startsWith(parentHuc))
          .map((row) => row.id),
      );
    }
    expect(
      listReference({ topic: 'huc', parentHuc: '1703', hucLevel: 8 }).records.map((row) => row.id),
    ).toEqual(['17030001', '17030002', '17030003']);
    for (const parentHuc of ['17030001', '170300', '9999', '17x'])
      expect(() => listReference({ topic: 'huc', parentHuc, hucLevel: 6 })).toThrow();
    expect(() => listReference({ topic: 'states', parentHuc: '17' })).toThrow();
    const first = listReference({ topic: 'huc', parentHuc: '17', hucLevel: 8, limit: 1 });
    expect(() =>
      listReference({
        topic: 'huc',
        parentHuc: '1703',
        hucLevel: 8,
        cursor: first.nextCursor ?? '',
      }),
    ).toThrow();
  });
  it('selects the same source dependencies for metadata and provenance', () => {
    const page = listReference({ topic: 'counties', state: 'CT' });
    expect(page.sourceMetadata.map((source) => source.url)).toEqual(page.provenance.sourceUrls);
    expect(page.sourceMetadata.some((source) => source.url.includes('national_county2020'))).toBe(
      true,
    );
    expect(page.sourceMetadata.some((source) => source.url.includes('CountyStatistics'))).toBe(
      true,
    );
    expect(page.sourceMetadata.some((source) => source.url.includes('state.txt'))).toBe(true);
    expect(page.sourceMetadata.some((source) => source.url.includes('huc'))).toBe(false);
  });
  it('resolves unique suffix-free counties after exact identities', () => {
    expect(resolveGeography({ areaType: 'county', aoi: 'King, WA' }).areas[0]?.id).toBe('53033');
    expect(resolveGeography({ areaType: 'county', aoi: 'King, WA' }).areas[0]?.name).toBe(
      'King County',
    );
    const fixture = {
      areaType: 'county' as const,
      id: '53999',
      name: 'King Parish',
      state: 'WA',
      sourceVintage: 'Alias ambiguity fixture',
    };
    referenceBundle.counties.push(fixture);
    try {
      expect(resolveGeography({ areaType: 'county', aoi: 'King County, WA' }).areas[0]?.id).toBe(
        '53033',
      );
      expect(() => resolveGeography({ areaType: 'county', aoi: 'King, WA' })).toThrow(
        expect.objectContaining({ data: expect.objectContaining({ reason: 'ambiguous_area' }) }),
      );
    } finally {
      referenceBundle.counties.splice(referenceBundle.counties.indexOf(fixture), 1);
    }
  });
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
