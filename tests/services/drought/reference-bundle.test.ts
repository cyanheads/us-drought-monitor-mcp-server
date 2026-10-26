/**
 * @fileoverview Lossless compact reference storage and invalid metadata rejection.
 * @module tests/services/drought/reference-bundle
 */
import { describe, expect, it } from 'vitest';
import {
  decodeReferenceBundle,
  encodeReferenceBundle,
} from '@/services/drought/reference-bundle.js';
import { referenceBundle } from '@/services/drought/reference-data.js';

describe('compact reference bundle codec', () => {
  it('ships authoritative RFC identities and acquisition evidence through the codec', () => {
    const hydrated = decodeReferenceBundle(encodeReferenceBundle(referenceBundle));
    expect(hydrated.riverForecastCenters.map(({ id, name }) => ({ id, name }))).toEqual([
      { id: 'AKRFC', name: 'Alaska' },
      { id: 'ABRFC', name: 'Arkansas Red Basin' },
      { id: 'CNRFC', name: 'California Nevada' },
      { id: 'CBRFC', name: 'Colorado Basin' },
      { id: 'LMRFC', name: 'Lower Mississippi' },
      { id: 'MARFC', name: 'Middle Atlantic' },
      { id: 'MBRFC', name: 'Missouri Basin' },
      { id: 'NCRFC', name: 'North Central' },
      { id: 'NERFC', name: 'Northeast' },
      { id: 'NWRFC', name: 'Northwest' },
      { id: 'OHRFC', name: 'Ohio' },
      { id: 'SERFC', name: 'Southeast' },
      { id: 'WGRFC', name: 'West Gulf' },
    ]);
    expect(
      hydrated.riverForecastCenters.every((row) => row.areaType === 'river_forecast_center'),
    ).toBe(true);
    expect(hydrated.sourceMetadata.find((source) => source.url.endsWith('?rfc'))).toMatchObject({
      recordCount: 13,
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });
  it('round-trips every real record and all acquisition evidence exactly', () => {
    const stored = encodeReferenceBundle(referenceBundle);
    expect(stored.schemaVersion).toBe(2);
    expect(decodeReferenceBundle(JSON.parse(JSON.stringify(stored)))).toEqual(referenceBundle);
    expect(Buffer.byteLength(JSON.stringify(stored, null, 2))).toBeLessThan(1024 * 1024);
    expect(decodeReferenceBundle(stored).sourceMetadata).toEqual(referenceBundle.sourceMetadata);
  });
  it('hydrates every family and HUC level, preserving historical and current county metadata', () => {
    const hydrated = decodeReferenceBundle(encodeReferenceBundle(referenceBundle));
    for (const collection of ['states', 'counties', 'tribal', 'climateDivisions', 'huc'] as const) {
      expect(hydrated[collection]).toEqual(referenceBundle[collection]);
      expect(hydrated[collection].length).toBeGreaterThan(0);
    }
    for (const level of [2, 4, 6, 8])
      expect(hydrated.huc.some((row) => row.hucLevel === level)).toBe(true);
    expect(hydrated.counties.find((row) => row.id === '01001')).toEqual(
      referenceBundle.counties.find((row) => row.id === '01001'),
    );
    const connecticut = hydrated.counties.filter((row) => row.state === 'CT');
    expect(connecticut.some((row) => row.currentUsdm === true)).toBe(true);
    expect(connecticut.some((row) => row.currentUsdm === false)).toBe(true);
    expect(connecticut.every((row) => row.sourceVintage.length > 0)).toBe(true);
  });
  it.each([-1, 0.5, 1_000_000, '0', null])(
    'rejects invalid vintage reference %s',
    (sourceVintage) => {
      const stored = JSON.parse(JSON.stringify(encodeReferenceBundle(referenceBundle)));
      stored.counties[0].sourceVintage = sourceVintage;
      expect(() => decodeReferenceBundle(stored)).toThrow();
    },
  );
  it('rejects an absent vintage table and conflicting stored identity fields', () => {
    const missing = JSON.parse(JSON.stringify(encodeReferenceBundle(referenceBundle)));
    delete missing.vintages;
    expect(() => decodeReferenceBundle(missing)).toThrow();
    const conflicting = JSON.parse(JSON.stringify(encodeReferenceBundle(referenceBundle)));
    conflicting.states[0].areaType = 'county';
    expect(() => decodeReferenceBundle(conflicting)).toThrow();
  });
  it('deduplicates vintage strings without altering their record assignments', () => {
    const stored = encodeReferenceBundle(referenceBundle);
    expect(new Set(stored.vintages).size).toBe(stored.vintages.length);
    const hydrated = decodeReferenceBundle(stored);
    for (const collection of ['states', 'counties', 'tribal', 'climateDivisions', 'huc'] as const) {
      for (const [index, row] of stored[collection].entries()) {
        expect(row).not.toHaveProperty('areaType');
        expect(hydrated[collection][index]?.sourceVintage).toBe(stored.vintages[row.sourceVintage]);
      }
    }
  });
});
