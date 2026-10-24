/**
 * @fileoverview Lossless field/value rendering for source-controlled response schemas.
 * @module services/drought/format
 */
/** Render exact strings in a fence longer than every embedded backtick run. */
export function fenced(value: string): string {
  const longest = Math.max(2, ...[...value.matchAll(/`+/g)].map((match) => match[0].length));
  const fence = '`'.repeat(longest + 1);
  return `${fence}\n${value}\n${fence}`;
}
/** Encode one scalar once as JSON so Markdown cannot normalize its line endings. */
export function renderScalar(value: string | number | boolean | null): string {
  return fenced(JSON.stringify(value));
}
/** JSON cells preserve control characters and optional-property absence in GFM tables. */
export function tableCell(value: unknown): string {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new TypeError('Table values must be JSON-serializable.');
  const longest = Math.max(0, ...[...encoded.matchAll(/`+/g)].map((match) => match[0].length));
  const delimiter = '`'.repeat(longest + 1);
  const code = `${delimiter} ${encoded.replaceAll('|', '\\|')} ${delimiter}`;
  if (typeof value === 'string' && /^https:\/\/[^\s<>]+$/.test(value))
    return `[${code}](<${value.replaceAll('\\', '\\\\').replaceAll('|', '\\|').replaceAll('&', '&amp;')}>)`;
  const links = (item: unknown): string[] => {
    if (typeof item === 'string' && /^https:\/\/[^\s<>]+$/.test(item))
      return [
        `[URL](<${item.replaceAll('\\', '\\\\').replaceAll('|', '\\|').replaceAll('&', '&amp;')}>)`,
      ];
    return item !== null && typeof item === 'object' ? Object.values(item).flatMap(links) : [];
  };
  const nestedLinks = links(value);
  return nestedLinks.length ? `${code} ${nestedLinks.join(' ')}` : code;
}
/** Render every nested field; actual URL values remain clickable URLs. */
export function renderFields(value: unknown, prefix = ''): string {
  if (Array.isArray(value)) {
    if (
      ['records', 'rows', 'columns'].includes(prefix.split('.').at(-1) ?? '') &&
      value.length &&
      value.every((row) => row !== null && typeof row === 'object' && !Array.isArray(row))
    ) {
      const rows = value as Record<string, unknown>[];
      const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
      return `**${prefix}:**\n\nCells use JSON values; an empty cell means the optional field is absent.\n\n${[
        `| ${columns.map(tableCell).join(' | ')} |`,
        `| ${columns.map(() => '---').join(' | ')} |`,
        ...rows.map(
          (row) =>
            `| ${columns.map((column) => (Object.hasOwn(row, column) ? tableCell(row[column]) : '')).join(' | ')} |`,
        ),
      ].join('\n')}`;
    }
    return value.length
      ? value.map((item, index) => renderFields(item, `${prefix}[${index}]`)).join('\n\n')
      : `**${prefix}:** []`;
  }
  if (value !== null && typeof value === 'object')
    return Object.entries(value)
      .map(([key, item]) => renderFields(item, prefix ? `${prefix}.${key}` : key))
      .join('\n\n');
  if (typeof value === 'string' && /^https:\/\/[^\s<>]+$/.test(value))
    return `**${prefix}:** [${value.replace(/[[\]\\`*_~]/g, '\\$&').replaceAll('&', '&amp;')}](<${value.replaceAll('\\', '\\\\').replaceAll('&', '&amp;')}>)`;
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  )
    return `**${prefix}:**\n${renderScalar(value)}`;
  throw new TypeError('Response scalar must be JSON-serializable.');
}
