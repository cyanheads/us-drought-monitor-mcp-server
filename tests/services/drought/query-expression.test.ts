/**
 * @fileoverview Non-executing original SQL classification and delimiter preservation.
 * @module tests/services/drought/query-expression
 */
import { describe, expect, it } from 'vitest';
import { queryExpression } from '@/services/drought/query-expression.js';

describe('original SQL normalization', () => {
  it.each(['DROP TABLE drought', '/* comment */ DELETE FROM drought', 'UPDATE drought SET n=1'])(
    'classifies forbidden statements without executing SQL: %s',
    (sql) => {
      expect(() => queryExpression(sql)).toThrow(
        expect.objectContaining({
          data: expect.objectContaining({ reason: 'non_select_statement' }),
        }),
      );
    },
  );
  it.each([
    ["SELECT ';' AS v; -- comment", "SELECT ';' AS v -- comment"],
    [
      'SELECT $$; /* literal */$$ AS v; /* outer /* nested */ end */',
      'SELECT $$; /* literal */$$ AS v /* outer /* nested */ end */',
    ],
    ['SELECT $tag$; -- literal$tag$ AS v;', 'SELECT $tag$; -- literal$tag$ AS v'],
    ["SELECT E'escaped\\'; literal' AS v;", "SELECT E'escaped\\'; literal' AS v"],
  ])('removes exactly the terminal delimiter from %s', (sql, expected) => {
    expect(queryExpression(sql)).toBe(expected);
  });
  it.each(['SELECT 1; SELECT 2', 'SELECT 1;;', 'SELECT 1; /* middle */ VALUES (2)'])(
    'rejects multiple statements: %s',
    (sql) => {
      expect(() => queryExpression(sql)).toThrow(
        expect.objectContaining({ data: expect.objectContaining({ reason: 'multi_statement' }) }),
      );
    },
  );
  it.each([5000, 20000, 80000])('preserves scanner adversaries at %i characters', (size) => {
    for (const comment of [
      '/*'.repeat(size),
      '/*'.repeat(size) + '*/'.repeat(size),
      `--${'x'.repeat(size)}\n`,
      '--x\n'.repeat(size),
      '$tag'.repeat(size),
    ]) {
      const sql = `SELECT 1; /* ${comment} */`;
      expect(queryExpression(sql)).toBe(`SELECT 1 /* ${comment} */`);
    }
  });
});
