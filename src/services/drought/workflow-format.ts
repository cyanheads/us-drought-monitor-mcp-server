/**
 * @fileoverview Lossless ordinary response sections and complete compact row tables.
 * @module services/drought/workflow-format
 */
import { isObjectRow, renderFields, renderTable } from './format.js';

function columnUnit(
  column: string,
  rows: Record<string, unknown>[],
  envelope: Record<string, unknown>,
): string {
  if (column.startsWith('areaPercent')) return 'percent';
  if (column.startsWith('areaSqMiles')) return 'square miles';
  if (column === 'populationCountCumulative') return 'people';
  if (column === 'dsci' || column.startsWith('dsciChange')) return 'index';
  if (column === 'change')
    return typeof envelope.changeUnit === 'string' ? envelope.changeUnit : '';
  if (['buckets', 'targetValue', 'baselineValue', 'rankedValue'].includes(column)) {
    const units = [
      ...new Set(
        rows
          .map((row) => row.unit ?? envelope.unit)
          .filter((unit): unit is string => typeof unit === 'string'),
      ),
    ];
    return units.join(', ');
  }
  return '';
}

/** GFM tables encode present cells as JSON and leave absent optional cells empty. */
export function renderWorkflow(value: unknown): string {
  if (!isObjectRow(value)) return renderFields(value);
  return Object.entries(value)
    .map(([field, item]) => {
      if (Array.isArray(item) && ['rows', 'snapshots'].includes(field) && item.every(isObjectRow)) {
        if (!item.length) return `## ${field}\n\n[]`;
        return `## ${field}\n\n${renderTable(item, (column, rows) => columnUnit(column, rows, value))}`;
      }
      return `## ${field}\n\n${renderFields(item, field)}`;
    })
    .join('\n\n');
}
