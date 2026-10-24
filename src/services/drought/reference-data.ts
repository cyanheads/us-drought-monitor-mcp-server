/**
 * @fileoverview Immutable official references, exact resolution and bound pagination.
 * @module services/drought/reference-data
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { notFound, validationError } from '@cyanheads/mcp-ts-core/errors';
import { renderFields } from './format.js';
import { decodeReferenceBundle } from './reference-bundle.js';
import type { GeographyRecord, ReferenceRecord, ReferenceTopic } from './reference-schema.js';
import type { Area, Geography, HucLevel } from './types.js';
import { provenance } from './types.js';

/** Load assets relative to the module, independently of the caller's cwd. */
export const referenceBundle = decodeReferenceBundle(
  JSON.parse(readFileSync(new URL('../../data/reference.json', import.meta.url), 'utf8')),
);
/** Exact-name normalization; does not infer boundaries or fuzzy-match. */
export function normalizeName(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}
function uniqueMatch(
  rows: GeographyRecord[],
  value: string,
  name: (row: GeographyRecord) => string = (row) => row.name,
): GeographyRecord | undefined {
  const matches = rows.filter((row) => normalizeName(name(row)) === normalizeName(value));
  if (matches.length > 1)
    throw validationError(
      'The exact geography name matches multiple identifiers; supply its identifier.',
      { reason: 'ambiguous_area' },
    );
  return matches[0];
}
/** Resolve a state postal code, exact full name or two-digit FIPS. */
export function resolveState(value: string): GeographyRecord {
  const key = value.trim();
  const row =
    referenceBundle.states.find((state) => state.id === key || state.state === key.toUpperCase()) ??
    uniqueMatch(referenceBundle.states, key);
  if (!row)
    throw notFound('State is not in the supported reference set.', { reason: 'unknown_area' });
  return row;
}
/** A shape-valid identifier outside the bundle requires direct upstream lookup. */
export interface AreaResolution {
  areas: Area[];
  requiresLookup: boolean;
}
/** Resolve exact names and codes; never reject a new shape-valid numeric id permanently. */
export function resolveGeography(input: Geography): AreaResolution {
  const value = input.aoi.trim();
  const unknown = (): AreaResolution => ({
    areas: [
      {
        areaType: input.areaType,
        id: value,
        name: value,
        ...(input.areaType === 'huc' ? { hucLevel: input.hucLevel } : {}),
      },
    ],
    requiresLookup: true,
  });
  const invalid = (): never => {
    throw validationError('Geography does not match its documented identifier format.', {
      reason: 'invalid_area',
    });
  };
  if (input.areaType === 'us') {
    const selector = value.toLowerCase();
    if (!['us', 'conus', 'total'].includes(selector)) return invalid();
    return {
      areas: (selector === 'us' ? ['conus', 'total'] : [selector]).map((id) => ({
        areaType: 'us',
        id,
        name: id === 'conus' ? 'CONUS' : 'Total',
      })),
      requiresLookup: false,
    };
  }
  if (input.areaType === 'state') {
    if (/^\d+$/.test(value) && !/^\d{2}$/.test(value)) return invalid();
    if (/^\d{2}$/.test(value) && !referenceBundle.states.some((row) => row.id === value))
      return unknown();
    return { areas: [resolveState(value)], requiresLookup: false };
  }
  if (input.areaType === 'county') {
    if (/^\d+$/.test(value)) {
      if (!/^\d{5}$/.test(value)) return invalid();
      const row = referenceBundle.counties.find((county) => county.id === value);
      return row ? { areas: [row], requiresLookup: false } : unknown();
    }
    const comma = value.lastIndexOf(',');
    if (comma < 1) return invalid();
    const state = resolveState(value.slice(comma + 1));
    const counties = referenceBundle.counties.filter((county) => county.state === state.state);
    const name = value.slice(0, comma);
    const row =
      uniqueMatch(counties, name) ??
      uniqueMatch(counties, name, (county) =>
        county.name.replace(
          / (?:City and Borough|Census Area|County|Parish|Borough|Municipality|Municipio)$/i,
          '',
        ),
      );
    if (!row)
      throw notFound('County name is not in the reference set for the specified state.', {
        reason: 'unknown_area',
      });
    return { areas: [row], requiresLookup: false };
  }
  if (input.areaType === 'huc') {
    if (!new RegExp(`^\\d{${input.hucLevel}}$`).test(value)) return invalid();
    const row = referenceBundle.huc.find(
      (huc) => huc.id === value && huc.hucLevel === input.hucLevel,
    );
    return row ? { areas: [row], requiresLookup: false } : unknown();
  }
  if (input.areaType === 'climate_division') {
    if (!/^\d{4}$/.test(value)) return invalid();
    const row = referenceBundle.climateDivisions.find((division) => division.id === value);
    return row ? { areas: [row], requiresLookup: false } : unknown();
  }
  if (!/^\d{4}[A-Za-z]$/.test(value)) return invalid();
  const row = referenceBundle.tribal.find((tribal) => tribal.id === value.toUpperCase());
  return row
    ? { areas: [row], requiresLookup: false }
    : {
        areas: [{ areaType: 'tribal', id: value.toUpperCase(), name: value.toUpperCase() }],
        requiresLookup: true,
      };
}
const allMetrics = ['area_percent', 'area_sq_miles', 'population_percent', 'population_count'];
const definitions: Partial<Record<ReferenceTopic, ReferenceRecord[]>> = {
  categories: [
    ...[
      ['None', 'Normal or wet conditions', '30.01 or Above', '-0.49 or above'],
      ['D0', 'Abnormally Dry', '20.01 to 30.00', '-0.5 to -0.79'],
      ['D1', 'Moderate Drought', '10.01 to 20.00', '-0.8 to -1.29'],
      ['D2', 'Severe Drought', '5.01 to 10.00', '-1.3 to -1.59'],
      ['D3', 'Extreme Drought', '2.01 to 5.00', '-1.6 to -1.99'],
      ['D4', 'Exceptional Drought', '0.00 to 2.00', '-2.0 or less'],
    ].map(([id, description, percentile, spiSpei]) => ({
      id: id ?? '',
      name: id ?? '',
      description: description ?? '',
      percentile: percentile ?? '',
      spiSpei: spiSpei ?? '',
    })),
    {
      id: 'S',
      name: 'Short-term impacts',
      description: 'Typically less than 6 months; agriculture and grasslands.',
    },
    {
      id: 'L',
      name: 'Long-term impacts',
      description: 'Typically more than 6 months; hydrology and ecology.',
    },
    {
      id: 'SL',
      name: 'Short- and long-term impacts',
      description: 'Both short- and long-term drought impacts.',
    },
  ],
  dsci: [
    {
      id: 'dsci',
      name: 'Drought Severity and Coverage Index',
      description:
        'Experimental upstream integer index from 0 to 500. Formulas describe the index; returned DSCI is always the authoritative upstream value.',
      cumulativeFormula: 'D0-D4 + D1-D4 + D2-D4 + D3-D4 + D4',
      categoricalFormula: '1 × D0-only + 2 × D1-only + 3 × D2-only + 4 × D3-only + 5 × D4-only',
    },
  ],
  coverage: [
    {
      id: 'coverage',
      name: 'Published weekly coverage',
      description:
        'Coverage begins 2000-01-04. Maps represent Tuesday through Monday and are usually published Thursday. This offline reference does not determine the latest published map.',
    },
  ],
  area_types: (['us', 'state', 'county', 'huc', 'tribal', 'climate_division'] as const).map(
    (id) => ({
      id,
      name: id,
      description:
        id === 'us'
          ? 'us returns both conus and total.'
          : 'Exact identifiers preserve leading zeroes; no fuzzy name or boundary substitution.',
      identifierFormat: {
        us: 'us | conus | total',
        state: 'postal code | two-digit FIPS | exact full name',
        county: 'five-digit FIPS | exact or unique suffix-free county name, state',
        huc: 'exact 2/4/6/8 digits plus matching hucLevel',
        tribal: 'bundled GEOID including suffix',
        climate_division: 'four-digit bundled AOI id (not state FIPS)',
      }[id],
      metrics: ['us', 'state', 'county'].includes(id) ? allMetrics : allMetrics.slice(0, 2),
    }),
  ),
};
/** Local filtering and cursor inputs. */
export interface ReferenceQuery {
  cursor?: string;
  hucLevel?: HucLevel;
  limit?: number;
  nameContains?: string;
  parentHuc?: string;
  state?: string;
  topic: ReferenceTopic;
}
/** Filter the complete family before applying a query-bound continuation. */
export function listReference(input: ReferenceQuery) {
  const parentHuc = input.parentHuc?.trim() || undefined;
  if (
    (input.state && !['counties', 'climate_divisions'].includes(input.topic)) ||
    (parentHuc && input.topic !== 'huc') ||
    (input.hucLevel !== undefined && input.topic !== 'huc') ||
    (input.topic === 'huc' && input.hucLevel === undefined)
  )
    throw validationError(
      'Use state for counties or climate_divisions; huc requires hucLevel 2, 4, 6 or 8.',
      {
        reason: 'invalid_reference_filter',
      },
    );
  const state = input.state ? resolveState(input.state).state : undefined;
  if (
    parentHuc &&
    (!/^(?:\d{2}|\d{4}|\d{6})$/.test(parentHuc) ||
      !input.hucLevel ||
      parentHuc.length >= input.hucLevel ||
      !referenceBundle.huc.some((row) => row.id === parentHuc && row.hucLevel === parentHuc.length))
  )
    throw validationError(
      'parentHuc must identify an existing HUC at level 2, 4 or 6, shorter than hucLevel.',
      { reason: 'invalid_reference_filter' },
    );
  const tokens = normalizeName(input.nameContains ?? '')
    .split(' ')
    .filter(Boolean);
  const family =
    (
      {
        states: referenceBundle.states,
        counties: referenceBundle.counties,
        tribal: referenceBundle.tribal,
        climate_divisions: referenceBundle.climateDivisions,
        huc: referenceBundle.huc,
      } as Partial<Record<ReferenceTopic, ReferenceRecord[]>>
    )[input.topic] ??
    definitions[input.topic] ??
    [];
  const rows = family.filter(
    (row) =>
      (!state || ('state' in row && row.state === state)) &&
      (input.hucLevel === undefined || ('hucLevel' in row && row.hucLevel === input.hucLevel)) &&
      (!parentHuc || row.id.startsWith(parentHuc)) &&
      tokens.every((token) => normalizeName(row.name).includes(token)),
  );
  const binding = createHash('sha256')
    .update(
      JSON.stringify({
        topic: input.topic,
        tokens,
        state,
        hucLevel: input.hucLevel,
        parentHuc,
        version: referenceBundle.bundleVersion,
      }),
    )
    .digest('hex');
  let offset = 0;
  if (input.cursor) {
    try {
      const decoded: unknown = JSON.parse(Buffer.from(input.cursor, 'base64url').toString());
      if (
        !decoded ||
        typeof decoded !== 'object' ||
        !('binding' in decoded) ||
        decoded.binding !== binding ||
        !('offset' in decoded) ||
        typeof decoded.offset !== 'number' ||
        !Number.isSafeInteger(decoded.offset) ||
        decoded.offset < 0 ||
        decoded.offset >= rows.length
      )
        throw new Error('cursor');
      offset = decoded.offset;
    } catch {
      throw validationError('Reference cursor is invalid or its filters changed.', {
        reason: 'invalid_cursor',
      });
    }
  }
  const records: ReferenceRecord[] = [];
  let bytes = 0;
  for (const row of rows.slice(offset, offset + (input.limit ?? 50))) {
    const size = JSON.stringify(row).length;
    if (bytes + size > 30_000) break;
    records.push(row);
    bytes += size;
  }
  if (rows[offset] && !records.length)
    throw validationError('A reference record cannot fit the response budget.', {
      reason: 'dataset_too_large',
      component: 'reference_record',
    });
  const sourceMetadata = referenceBundle.sourceMetadata.filter((source) => {
    const url = source.url;
    if (url.endsWith('/Permission.aspx') || url.endsWith('/DSCI.aspx')) return true;
    switch (input.topic) {
      case 'states':
        return url.endsWith('/state.txt');
      case 'counties':
        return (
          url.endsWith('/state.txt') ||
          url.includes('national_county2020') ||
          url.includes('/CountyStatistics/')
        );
      case 'climate_divisions':
        return (
          url.endsWith('/state.txt') ||
          url.includes('?climdiv') ||
          url.includes('/usclimdivs/') ||
          url.includes('/ClimateDivisionStatistics/')
        );
      case 'tribal':
        return url.endsWith('?tribal');
      case 'huc':
        return url.endsWith(`?huc${input.hucLevel}`);
      case 'dsci':
        return url.endsWith('/DSCI.aspx');
      case 'categories':
        return url.endsWith('/DroughtClassification.aspx');
      case 'coverage':
        return false;
      case 'area_types':
        return true;
      default: {
        const unhandled: never = input.topic;
        throw new TypeError(`Unhandled reference topic: ${unhandled}`);
      }
    }
  });
  const result = {
    topic: input.topic,
    records,
    totalCount: rows.length,
    nextCursor: null as string | null,
    hasMore: false,
    bundleVersion: referenceBundle.bundleVersion,
    sourceMetadata,
    provenance: provenance(
      sourceMetadata.map((source) => source.url),
      sourceMetadata[0]?.fetchedAt,
    ),
  };
  function continuation(): void {
    const next = offset + records.length;
    result.hasMore = next < rows.length;
    result.nextCursor = result.hasMore
      ? Buffer.from(JSON.stringify({ binding, offset: next })).toString('base64url')
      : null;
  }
  continuation();
  while (JSON.stringify(result).length > 80_000 || renderFields(result).length > 80_000) {
    records.pop();
    continuation();
    if (!records.length)
      throw validationError('A reference record cannot fit the response budget.', {
        reason: 'dataset_too_large',
        component: 'reference_record',
      });
  }
  return result;
}
