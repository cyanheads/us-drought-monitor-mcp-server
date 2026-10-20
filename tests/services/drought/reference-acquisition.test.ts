/**
 * @fileoverview Official reference parsing and cwd-independent bundle lookup.
 * @module tests/services/drought/reference-acquisition
 */
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseAoi, parsePipe } from '../../../scripts/update-reference-data.js';

describe('official reference acquisition boundaries', () => {
  it('preserves pipe-delimited leading zeroes and rejects malformed records', () => {
    expect(parsePipe('STATE|STATEFP|COUNTYFP|COUNTYNAME\r\nAL|01|001|Autauga County\r\n')).toEqual([
      { STATE: 'AL', STATEFP: '01', COUNTYFP: '001', COUNTYNAME: 'Autauga County' },
    ]);
    expect(() => parsePipe('STATE|STATEFP\nAL')).toThrow('Malformed Census record');
  });
  it('extracts only the official AOI table and decodes names losslessly', () => {
    const text =
      '<table><tr><td>unrelated</td></tr></table><table><tr><th>Area</th><th>AOI Value</th></tr><tr><td>Saint &amp; River &#233;</td><td>0101</td></tr><tr><td>Same name</td><td>0102</td></tr></table>';
    expect(parseAoi(text)).toEqual([
      { name: 'Saint & River é', id: '0101' },
      { name: 'Same name', id: '0102' },
    ]);
    expect(() => parseAoi(text.replace('0102', '0101'))).toThrow('duplicate');
    expect(() => parseAoi('<table><tr><th>Not AOI</th></tr></table>')).toThrow('headers');
  });
  it('loads the shipped source bundle relative to the module from another cwd', () => {
    const modulePath = fileURLToPath(
      new URL('../../../src/services/drought/reference-data.ts', import.meta.url),
    );
    const output = execFileSync(
      'bun',
      [
        '-e',
        `const {resolveState} = await import(${JSON.stringify(modulePath)}); console.log(resolveState('AL').id);`,
      ],
      { cwd: tmpdir(), encoding: 'utf8' },
    );
    expect(output.trim()).toBe('01');
  });
});
