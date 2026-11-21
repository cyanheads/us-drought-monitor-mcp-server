/**
 * @fileoverview Lossless field/value rendering for source-controlled response schemas.
 * @module services/drought/format
 */
function backtickDelimiter(value: string, minimum: number): string {
  let length = minimum;
  for (const [run] of value.matchAll(/`+/g)) length = Math.max(length, run.length + 1);
  return '`'.repeat(length);
}
function fenced(value: string): string {
  const fence = backtickDelimiter(value, 3);
  return `${fence}\n${value}\n${fence}`;
}
function isUrl(value: unknown): value is string {
  return typeof value === 'string' && /^https:\/\/[^\s<>]+$/.test(value);
}
function urlLink(value: string, label: string, table = false): string {
  let target = value.replaceAll('\\', '\\\\').replaceAll('&', '&amp;');
  if (table) target = target.replaceAll('|', '\\|');
  return `[${label}](<${target}>)`;
}
function urlLabel(value: string): string {
  return value.replace(/[[\]\\`*_~]/g, '\\$&').replaceAll('&', '&amp;');
}
/** JSON cells preserve control characters and optional-property absence in GFM tables. */
function tableCell(value: unknown): string {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new TypeError('Table values must be JSON-serializable.');
  const delimiter = backtickDelimiter(encoded, 1);
  const code = `${delimiter} ${encoded.replaceAll('|', '\\|')} ${delimiter}`;
  if (isUrl(value)) return urlLink(value, code, true);
  const links = (item: unknown): string[] => {
    if (isUrl(item)) return [urlLink(item, 'URL', true)];
    return item !== null && typeof item === 'object' ? Object.values(item).flatMap(links) : [];
  };
  const nestedLinks = links(value);
  return nestedLinks.length ? `${code} ${nestedLinks.join(' ')}` : code;
}
/** Build an ordered table for JSON object rows, falling back to exact JSON for columnless rows. */
export function renderTable(
  rows: Record<string, unknown>[],
  columnUnit?: (column: string, rows: Record<string, unknown>[]) => string,
): string {
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  if (!columns.length) return fenced(JSON.stringify(rows));
  const header = columns.map((column) => {
    const unit = columnUnit?.(column, rows);
    return `${tableCell(column)}${unit ? ` (${unit})` : ''}`;
  });
  const lines = [
    `| ${header.join(' | ')} |`,
    `| ${columns.map(() => '---').join(' | ')} |`,
    ...rows.map(
      (row) =>
        `| ${columns.map((column) => (Object.hasOwn(row, column) ? tableCell(row[column]) : '')).join(' | ')} |`,
    ),
  ];
  return `Cells use JSON values; an empty cell means the optional field is absent.\n\n${lines.join('\n')}`;
}
/** Check the shape of an object collection before handing it to the table renderer. */
export function isObjectRow(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
/** Render every nested field; actual URL values remain clickable URLs. */
export function renderFields(value: unknown, prefix = ''): string {
  if (Array.isArray(value)) {
    if (!value.length) return `**${prefix}:** []`;
    if (/(^|\.)provenance\.sourceUrls$/.test(prefix) && value.every(isUrl))
      return `**${prefix}:**\n\n${value.map((url) => `- ${urlLink(url, urlLabel(url))}`).join('\n')}`;
    // The describe envelope addresses each table's metadata and columns separately.
    if (prefix !== 'tables' && value.every(isObjectRow))
      return `**${prefix}:**\n\n${renderTable(value)}`;
    return value.map((item, index) => renderFields(item, `${prefix}[${index}]`)).join('\n\n');
  }
  if (isObjectRow(value)) {
    const fields = Object.entries(value);
    return fields.length
      ? fields
          .map(([key, item]) => renderFields(item, prefix ? `${prefix}.${key}` : key))
          .join('\n\n')
      : `**${prefix}:** {}`;
  }
  if (isUrl(value)) return `**${prefix}:** ${urlLink(value, urlLabel(value))}`;
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  )
    return `**${prefix}:**\n${fenced(JSON.stringify(value))}`;
  throw new TypeError('Response scalar must be JSON-serializable.');
}
