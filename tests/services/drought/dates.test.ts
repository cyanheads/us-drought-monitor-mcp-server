/**
 * @fileoverview Calendar and map-week boundary regressions.
 * @module tests/services/drought/dates
 */
import { describe, expect, it } from 'vitest';
import {
  addDays,
  calendarDate,
  mapDate,
  mapRange,
  upstreamDate,
} from '@/services/drought/dates.js';

describe('USDM calendar semantics', () => {
  it.each(['2023-02-29', '2024-02-30', '2024-13-01', '2024-00-01', '2024-1-02', 'not a date'])(
    'rejects impossible or malformed %s',
    (date) => {
      expect(() => calendarDate(date)).toThrow();
    },
  );
  it('preserves leap days and crosses years in UTC', () => {
    expect(calendarDate('2024-02-29')).toBe('2024-02-29');
    expect(addDays('2024-02-28', 1)).toBe('2024-02-29');
    expect(addDays('2023-12-31', 1)).toBe('2024-01-01');
    expect(upstreamDate('2024-02-09')).toBe('2/9/2024');
  });
  it.each([
    '2024-02-27',
    '2024-02-28',
    '2024-02-29',
    '2024-03-01',
    '2024-03-02',
    '2024-03-03',
    '2024-03-04',
  ])('maps %s to the containing Tuesday', (date) => {
    expect(mapDate(date)).toBe('2024-02-27');
  });
  it('validates original ordering before snapping the range', () => {
    expect(mapRange('2024-02-29', '2024-03-05')).toEqual({
      startDate: '2024-02-27',
      endDate: '2024-03-05',
    });
    expect(() => mapRange('2024-03-04', '2024-03-03')).toThrow();
  });
});
