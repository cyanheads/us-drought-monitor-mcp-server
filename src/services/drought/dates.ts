/**
 * @fileoverview UTC calendar validation and USDM map-week arithmetic.
 * @module services/drought/dates
 */
import { validationError } from '@cyanheads/mcp-ts-core/errors';

/** First published USDM map date. */
export const AVAILABLE_FROM = '2000-01-04';
/** Validate a calendar date without Date overflow repair. */
export function calendarDate(value: string): string {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    !Number.isFinite(Date.parse(`${value}T00:00:00Z`)) ||
    new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value
  ) {
    throw validationError('Supply a real calendar date in YYYY-MM-DD format.', {
      reason: 'invalid_date_range',
    });
  }
  return value;
}
/** Add integral UTC days. */
export function addDays(value: string, days: number): string {
  const date = new Date(`${calendarDate(value)}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
/** Tuesday beginning the containing map week. */
export function mapDate(value: string): string {
  return addDays(value, -((new Date(`${calendarDate(value)}T00:00:00Z`).getUTCDay() + 5) % 7));
}
/** Documented upstream date encoding. */
export function upstreamDate(value: string): string {
  const [year, month, day] = calendarDate(value).split('-');
  return `${Number(month)}/${Number(day)}/${year}`;
}
/** Normalize an upstream timestamp to its date component. */
export function sourceDate(value: string): string {
  return calendarDate(value.slice(0, 10));
}
/** Validate ordered dates and snap both endpoints. */
export function mapRange(
  startDate: string,
  endDate: string,
): { startDate: string; endDate: string } {
  calendarDate(startDate);
  calendarDate(endDate);
  if (startDate > endDate)
    throw validationError('startDate must not be after endDate.', { reason: 'invalid_date_range' });
  return { startDate: mapDate(startDate), endDate: mapDate(endDate) };
}
