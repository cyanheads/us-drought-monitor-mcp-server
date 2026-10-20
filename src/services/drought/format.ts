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
/** Render every nested field; actual URL values remain clickable URLs. */
export function renderFields(value: unknown, prefix = ''): string {
  if (Array.isArray(value))
    return value.length
      ? value.map((item, index) => renderFields(item, `${prefix}[${index}]`)).join('\n\n')
      : `**${prefix}:** []`;
  if (value !== null && typeof value === 'object')
    return Object.entries(value)
      .map(([key, item]) => renderFields(item, prefix ? `${prefix}.${key}` : key))
      .join('\n\n');
  if (typeof value === 'string' && /^https:\/\/[^\s<>]+$/.test(value))
    return `**${prefix}:** [${value.replace(/[[\]\\]/g, '\\$&')}](<${value}>)`;
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  )
    return `**${prefix}:**\n${renderScalar(value)}`;
  throw new TypeError('Response scalar must be JSON-serializable.');
}
