/**
 * @fileoverview Explicit maintainer acquisition of complete official reference tables.
 * @module scripts/update-reference-data
 */
import { createHash } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { z } from '@cyanheads/mcp-ts-core';
import { sourceDate } from '../src/services/drought/dates.js';
import { encodeReferenceBundle } from '../src/services/drought/reference-bundle.js';
import {
  type GeographyRecord,
  ReferenceBundleSchema,
} from '../src/services/drought/reference-schema.js';

const census = 'https://www2.census.gov/geo/docs/reference/';
const aoi = 'https://droughtmonitor.unl.edu/DmData/DataDownload/AoiValues.aspx?';
const supported =
  'AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY PR'.split(
    ' ',
  );
const sourceMetadata: {
  url: string;
  fetchedAt: string;
  sha256: string;
  recordCount: number;
  vintage: string;
}[] = [];
const captureIndex = process.argv.indexOf('--captures');
const captures = captureIndex >= 0 ? process.argv[captureIndex + 1] : undefined;
if (captureIndex >= 0 && !captures) throw new Error('--captures requires a directory');
const fetchedAt = new Date().toISOString();
let fetches = 0;
async function source(file: string, url: string): Promise<string> {
  if (captures) return readFile(`${captures}/${file}`, 'utf8');
  if (++fetches > 12) throw new Error('Reference acquisition exceeds 12 public requests');
  const response = await fetch(url, {
    headers: { Accept: 'application/json' },
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Official reference source returned HTTP ${response.status}`);
  return response.text();
}
function evidence(url: string, text: string, recordCount: number, vintage: string): void {
  sourceMetadata.push({
    url,
    fetchedAt,
    sha256: createHash('sha256').update(text).digest('hex'),
    recordCount,
    vintage,
  });
}
/** Parse complete Census pipe records, preserving code widths. */
export function parsePipe(text: string): Record<string, string>[] {
  const [header, ...lines] = text.trim().split(/\r?\n/);
  if (!header) throw new Error('Empty Census source');
  const keys = header.split('|');
  return lines.map((line) => {
    const values = line.split('|');
    if (values.length !== keys.length) throw new Error('Malformed Census record');
    return Object.fromEntries(keys.map((key, index) => [key, values[index] ?? '']));
  });
}
function decode(text: string): string {
  return text
    .replace(/<[^>]*>/g, '')
    .replace(/&#(x[\da-f]+|\d+);/gi, (_, code: string) =>
      String.fromCodePoint(
        code.startsWith('x') ? Number.parseInt(code.slice(1), 16) : Number(code),
      ),
    )
    .replace(
      /&(amp|quot|apos|lt|gt|nbsp);/g,
      (_, name: string) =>
        ({ amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' })[name] ?? '',
    )
    .trim();
}
/** Parse the official Area / AOI Value table, without taking unrelated layout cells. */
export function parseAoi(text: string): { id: string; name: string }[] {
  const table = [...text.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)].find((match) =>
    /<th[^>]*>\s*Area\s*<\/th>[\s\S]*?<th[^>]*>\s*AOI Value\s*<\/th>/i.test(match[1] ?? ''),
  )?.[1];
  if (!table) throw new Error('Official AOI table headers were not found');
  const rows = [...table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].flatMap((row) => {
    const cells = [...(row[1] ?? '').matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((cell) =>
      decode(cell[1] ?? ''),
    );
    if (!cells.length) return [];
    if (cells.length !== 2 || !cells[0] || !cells[1]) throw new Error('Malformed AOI table row');
    return [{ name: cells[0], id: cells[1] }];
  });
  if (!rows.length || new Set(rows.map((row) => row.id)).size !== rows.length)
    throw new Error('Empty or duplicate AOI identifiers');
  return rows;
}
async function generate(): Promise<void> {
  const stateUrl = `${census}state.txt`;
  const stateText = await source('states.txt', stateUrl);
  const states: GeographyRecord[] = parsePipe(stateText)
    .filter((row) => supported.includes(row.STUSAB ?? ''))
    .map((row) => ({
      areaType: 'state',
      id: row.STATE ?? '',
      state: row.STUSAB ?? '',
      name: row.STATE_NAME ?? '',
      sourceVintage: 'Census state codes',
    }));
  if (
    states.length !== supported.length ||
    states.some((state) => !/^\d{2}$/.test(state.id) || !state.name)
  )
    throw new Error('Incomplete supported state code table');
  evidence(stateUrl, stateText, states.length, 'Census state codes');
  const countyUrl = `${census}codes2020/national_county2020.txt`;
  const countyText = await source('county.txt', countyUrl);
  const counties: GeographyRecord[] = parsePipe(countyText)
    .filter((row) => supported.includes(row.STATE ?? ''))
    .map((row) => ({
      areaType: 'county',
      id: `${row.STATEFP}${row.COUNTYFP}`,
      name: row.COUNTYNAME ?? '',
      state: row.STATE ?? '',
      sourceVintage: 'Census 2020',
      currentUsdm: false,
    }));
  if (!counties.length || counties.some((row) => !/^\d{5}$/.test(row.id) || !row.name))
    throw new Error('Malformed Census county codes');
  evidence(countyUrl, countyText, counties.length, 'Census 2020');
  let currentText: string;
  let currentUrl: string;
  if (captures) {
    currentText = await readFile(`${captures}/current-counties.json`, 'utf8');
    const rows = z.array(z.object({ mapDate: z.string() })).parse(JSON.parse(currentText));
    const capturedLatest =
      rows
        .map((row) => row.mapDate.slice(0, 10))
        .sort()
        .at(-1) ?? '';
    const [year, month, day] = capturedLatest.split('-');
    const date = `${Number(month)}/${Number(day)}/${year}`;
    currentUrl = `https://usdmdataservices.unl.edu/api/CountyStatistics/GetDSCI?aoi=${supported.join(',')}&startdate=${date}&enddate=${date}`;
  } else {
    const today = new Date();
    const end = `${today.getUTCMonth() + 1}/${today.getUTCDate()}/${today.getUTCFullYear()}`;
    today.setUTCDate(today.getUTCDate() - 14);
    const start = `${today.getUTCMonth() + 1}/${today.getUTCDate()}/${today.getUTCFullYear()}`;
    currentUrl = `https://usdmdataservices.unl.edu/api/CountyStatistics/GetDSCI?aoi=${supported.join(',')}&startdate=${start}&enddate=${end}`;
    currentText = await source('current-counties.json', currentUrl);
  }
  const acquiredCounties = z
    .array(
      z.object({
        fips: z.string().regex(/^\d{5}$/),
        county: z.string().min(1),
        state: z.string(),
        mapDate: z.string(),
      }),
    )
    .parse(JSON.parse(currentText));
  const latest =
    acquiredCounties
      .map((row) => sourceDate(row.mapDate))
      .sort()
      .at(-1) ?? '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(latest)) throw new Error('No latest published county map');
  const current = acquiredCounties.filter((row) => row.mapDate.slice(0, 10) === latest);
  if (
    !current.length ||
    new Set(current.map((row) => row.fips)).size !== current.length ||
    current.some((row) => row.mapDate.slice(0, 10) !== latest || !supported.includes(row.state))
  )
    throw new Error('Incomplete or duplicate current county records');
  for (const row of current) {
    const old = counties.find((county) => county.id === row.fips);
    if (old) {
      old.currentUsdm = true;
      old.name = row.county;
      old.sourceVintage = `Census 2020; USDM ${latest}`;
    } else
      counties.push({
        areaType: 'county',
        id: row.fips,
        name: row.county,
        state: row.state,
        sourceVintage: `USDM ${latest}`,
        currentUsdm: true,
      });
  }
  evidence(currentUrl, currentText, current.length, latest);
  async function aoiRecords(
    topic: string,
    areaType: 'tribal' | 'climate_division' | 'huc',
    width?: 2 | 4 | 6 | 8,
  ): Promise<GeographyRecord[]> {
    const url = `${aoi}${topic}`;
    const text = await source(`${topic}.html`, url);
    const rows = parseAoi(text);
    if (
      rows.some(
        (row) =>
          !(areaType === 'tribal' ? /^\d{4}[A-Z]$/ : new RegExp(`^\\d{${width ?? 4}}$`)).test(
            row.id,
          ),
      )
    )
      throw new Error(`Invalid ${topic} identifier width`);
    evidence(url, text, rows.length, `USDM AOI ${fetchedAt.slice(0, 10)}`);
    return rows.map((row) => ({
      ...row,
      areaType,
      ...(width ? { hucLevel: width } : {}),
      sourceVintage: `USDM AOI ${fetchedAt.slice(0, 10)}`,
    }));
  }
  const tribal = await aoiRecords('tribal', 'tribal');
  const climateDivisions = await aoiRecords('climdiv', 'climate_division');
  const huc: GeographyRecord[] = [];
  for (const level of [2, 4, 6, 8] as const)
    huc.push(...(await aoiRecords(`huc${level}`, 'huc', level)));
  for (const [file, url] of [
    [
      'classification.html',
      'https://droughtmonitor.unl.edu/About/AbouttheData/DroughtClassification.aspx',
    ],
    ['dsci.html', 'https://droughtmonitor.unl.edu/About/AbouttheData/DSCI.aspx'],
    ['permission.html', 'https://droughtmonitor.unl.edu/About/Permission.aspx'],
  ] as const) {
    const text = await source(file, url);
    if (!/<html[\s>]/i.test(text)) throw new Error('Invalid official explanatory source');
    evidence(url, text, 1, fetchedAt.slice(0, 10));
  }
  if (new Set(counties.map((row) => row.id)).size !== counties.length)
    throw new Error('Duplicate county identifiers');
  const bundle = ReferenceBundleSchema.parse({
    schemaVersion: 1,
    bundleVersion: `${fetchedAt.slice(0, 10)}-${latest}`,
    sourceMetadata,
    states,
    counties,
    tribal,
    climateDivisions,
    huc,
  });
  const target = fileURLToPath(new URL('../src/data/reference.json', import.meta.url));
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(encodeReferenceBundle(bundle), null, 2)}\n`);
  await rename(temporary, target);
  console.log(
    JSON.stringify({
      states: states.length,
      counties: counties.length,
      currentCounties: current.length,
      tribal: tribal.length,
      climateDivisions: climateDivisions.length,
      huc: Object.fromEntries(
        [2, 4, 6, 8].map((level) => [level, huc.filter((row) => row.hucLevel === level).length]),
      ),
      bundleVersion: bundle.bundleVersion,
    }),
  );
}
if (import.meta.main) await generate();
