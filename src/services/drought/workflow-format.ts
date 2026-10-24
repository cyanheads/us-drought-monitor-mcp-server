/**
 * @fileoverview Lossless ordinary response sections and complete compact row tables.
 * @module services/drought/workflow-format
 */
import { tableCell as cell, renderFields } from './format.js';

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
  if (!value || typeof value !== 'object' || Array.isArray(value)) return renderFields(value);
  const envelope = value as Record<string, unknown>;
  return Object.entries(value)
    .map(([field, item]) => {
      if (Array.isArray(item) && ['rows', 'snapshots'].includes(field)) {
        if (!item.length) return `## ${field}\n\n[]`;
        const rows = item as Record<string, unknown>[];
        const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
        const header = columns.map((column) => {
          const unit = columnUnit(column, rows, envelope);
          return `${cell(column)}${unit ? ` (${unit})` : ''}`;
        });
        const lines = [
          `| ${header.join(' | ')} |`,
          `| ${columns.map(() => '---').join(' | ')} |`,
          ...rows.map(
            (row) =>
              `| ${columns.map((column) => (Object.hasOwn(row, column) ? cell(row[column]) : '')).join(' | ')} |`,
          ),
        ];
        return `## ${field}\n\nCells use JSON values; an empty cell means the optional field is absent.\n\n${lines.join('\n')}`;
      }
      return `## ${field}\n\n${renderFields(item, field)}`;
    })
    .join('\n\n');
}
