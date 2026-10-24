/**
 * @fileoverview Original SQL text gates and terminal delimiter normalization.
 * @module services/drought/query-expression
 */
import {
  assertNoDeniedFunctions,
  assertNoSystemCatalogs,
  SQL_GATE_REASONS,
} from '@cyanheads/mcp-ts-core/canvas';
import { validationError } from '@cyanheads/mcp-ts-core/errors';
/** Remove one terminal delimiter outside quoted values and nested comments. */
export function queryExpression(sql: string): string {
  assertNoDeniedFunctions(sql);
  assertNoSystemCatalogs(sql);
  let last = -1;
  let first = -1;
  const delimiters: number[] = [];
  let index = 0;
  while (index < sql.length) {
    const char = sql[index];
    const next = sql[index + 1];
    if (char === '-' && next === '-') {
      index += 2;
      while (index < sql.length && sql[index] !== '\n' && sql[index] !== '\r') index++;
      continue;
    }
    if (char === '/' && next === '*') {
      index += 2;
      let depth = 1;
      while (index < sql.length && depth) {
        if (sql[index] === '/' && sql[index + 1] === '*') {
          depth++;
          index += 2;
        } else if (sql[index] === '*' && sql[index + 1] === '/') {
          depth--;
          index += 2;
        } else index++;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      if (first < 0) first = index;
      const quote = char;
      const escaped =
        quote === "'" &&
        /[eE]/.test(sql[index - 1] ?? '') &&
        !/[A-Za-z0-9_]/.test(sql[index - 2] ?? '');
      index++;
      while (index < sql.length) {
        if (escaped && sql[index] === '\\') {
          index += 2;
          continue;
        }
        if (sql[index++] !== quote) continue;
        if (sql[index] !== quote) break;
        index++;
      }
      last = index - 1;
      continue;
    }
    if (char === '$') {
      if (first < 0) first = index;
      let end = index + 1;
      while (end < sql.length && /[A-Za-z0-9_]/.test(sql.charAt(end))) end++;
      if (sql[end] === '$' && (end === index + 1 || /[A-Za-z_]/.test(sql.charAt(index + 1)))) {
        const delimiter = sql.slice(index, end + 1);
        const closing = sql.indexOf(delimiter, end + 1);
        index = closing < 0 ? sql.length : closing + delimiter.length;
        last = index - 1;
        continue;
      }
      // The tag candidate has already been consumed; never rescan overlapping prefixes.
      last = end - 1;
      index = end;
      continue;
    }
    if (char !== ' ' && char !== '\t' && char !== '\n' && char !== '\r' && char !== '\f') {
      if (first < 0) first = index;
      if (char === ';') delimiters.push(index);
      last = index;
    }
    index++;
  }
  if (delimiters.length > 1 || (delimiters.length === 1 && delimiters[0] !== last))
    throw validationError('Supply exactly one SQL read expression.', {
      reason: SQL_GATE_REASONS.multiStatement,
    });
  const command = /^[A-Za-z]+/.exec(sql.slice(first))?.[0]?.toUpperCase();
  if (
    command &&
    [
      'DROP',
      'DELETE',
      'INSERT',
      'UPDATE',
      'ALTER',
      'CREATE',
      'COPY',
      'ATTACH',
      'DETACH',
      'INSTALL',
      'LOAD',
      'PRAGMA',
      'SET',
      'RESET',
      'CALL',
      'VACUUM',
      'TRUNCATE',
      'EXPORT',
      'IMPORT',
      'GRANT',
      'REVOKE',
      'CHECKPOINT',
    ].includes(command)
  )
    throw validationError('Use a read expression over staged drought tables.', {
      reason: SQL_GATE_REASONS.nonSelectStatement,
    });
  return sql[last] === ';' ? sql.slice(0, last) + sql.slice(last + 1) : sql;
}
