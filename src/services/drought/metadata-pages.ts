/**
 * @fileoverview Lossless bounded first pages of retained time-series metadata.
 * @module services/drought/metadata-pages
 */
/** Metadata collections retrievable from an immutable staged snapshot. */
export const METADATA_FIELDS = ['areas', 'summary', 'missingAreas', 'missingObservations'] as const;
export type MetadataField = (typeof METADATA_FIELDS)[number];
/** Keep fitting metadata unchanged; shorten only collection prefixes on overflow. */
export function boundedMetadata(
  metadata: Record<string, unknown>,
  fits: (value: Record<string, unknown>) => boolean,
): Record<string, unknown> {
  if (fits(metadata)) return metadata;
  const result = { ...metadata };
  const pages: Record<string, { total: number; returned: number; next_offset: number | null }> = {};
  for (const field of METADATA_FIELDS) {
    const items = metadata[field];
    if (Array.isArray(items)) {
      result[field] = items.slice();
      pages[field] = { total: items.length, returned: items.length, next_offset: null };
    }
  }
  result.metadata_pages = pages;
  while (!fits(result)) {
    const field = METADATA_FIELDS.filter(
      (field) => Array.isArray(result[field]) && (result[field] as unknown[]).length > 1,
    ).sort((a, b) => JSON.stringify(result[b]).length - JSON.stringify(result[a]).length)[0];
    if (!field) break;
    const items = result[field] as unknown[];
    result[field] = items.slice(0, Math.max(1, Math.floor(items.length / 2)));
    const returned = (result[field] as unknown[]).length;
    const total = (metadata[field] as unknown[]).length;
    pages[field] = { total, returned, next_offset: returned < total ? returned : null };
  }
  return result;
}
