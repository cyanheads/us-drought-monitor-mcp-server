/**
 * @fileoverview Bundle pruning preserves runtime modules beside dependency agent docs.
 * @module tests/scripts/packaging-doc-entries
 */
import { describe, expect, it } from 'vitest';
import {
  AGENT_DOC_ENTRY as cleanerPattern,
  filterAgentDocEntries,
} from '../../scripts/clean-mcpb.js';
import {
  checkBundleEntries,
  AGENT_DOC_ENTRY as linterPattern,
} from '../../scripts/lint-packaging.js';

const retained = [
  'skills/us-drought-monitor-guide/SKILL.md',
  'node_modules/@modelcontextprotocol/server/dist/ext/skills/index.mjs',
  'node_modules/@modelcontextprotocol/server/dist/ext/skills/loader.mjs',
  'node_modules/outer/node_modules/@modelcontextprotocol/server/dist/ext/skills/index.mjs',
  'node_modules/other/dist/skills/runtime.js',
  'node_modules/@scope/other/build/framework-skills/runtime.js',
];
const removed = [
  'node_modules/plain/skills/guide/SKILL.md',
  'node_modules/@scope/pkg/skills/guide/reference.txt',
  'node_modules/plain/framework-skills/guide/reference.txt',
  'node_modules/@scope/pkg/.claude/settings.json',
  'node_modules/plain/.agents/config.json',
  'node_modules/plain/node_modules/inner/skills/guide/reference.txt',
  'node_modules/@outer/pkg/node_modules/@inner/pkg/framework-skills/guide/reference.txt',
  'node_modules/@outer/pkg/node_modules/@inner/pkg/.claude/settings.json',
  'node_modules/plain/node_modules/inner/.agents/config.json',
  'node_modules/@scope/pkg/SKILL.md',
  'node_modules/plain/docs/nested/SKILL.md',
];

describe('dependency agent-doc pruning', () => {
  it.each([
    ['cleaner', filterAgentDocEntries],
    ['linter', (entries: string[]) => checkBundleEntries(entries, 'bundle.mcpb')],
  ] as const)('%s preserves runtime skills modules and the published root skill', (_, check) => {
    expect(check(retained)).toEqual([]);
  });

  it('removes package-root agent trees and stray SKILL.md at every dependency depth', () => {
    expect(filterAgentDocEntries(removed)).toEqual(removed);
    expect(checkBundleEntries(removed, 'bundle.mcpb')).toEqual([
      expect.stringContaining(`${removed.length} node_modules agent-doc entries`),
    ]);
    expect(linterPattern.source).toBe(cleanerPattern.source);
    expect(linterPattern.flags).toBe(cleanerPattern.flags);
  });

  it('bounds thread CPU across long package paths', () => {
    const shapes = [
      [(size: number) => `node_modules/pkg/${'1'.repeat(size)}`, false],
      [
        (size: number) =>
          `node_modules/${'pkg/node_modules/'.repeat(Math.ceil(size / 17))}pkg/runtime.js`,
        false,
      ],
      [
        (size: number) => `node_modules/pkg/${'skills/'.repeat(Math.ceil(size / 7))}runtime.js`,
        true,
      ],
      [(size: number) => `node_modules/pkg/${'§1 x'.repeat(Math.ceil(size / 4))}\ny`, false],
      [(size: number) => `node_modules/pkg/${'  \r\n'.repeat(Math.ceil(size / 4))}`, false],
    ] as const;
    for (const [shape, matches] of shapes) {
      let initialCpuUs = 0;
      for (let size = 5_000; size <= 320_000; size *= 2) {
        const path = shape(size);
        let cleanerMatches = 0;
        let linterMatches = 0;
        const start = process.threadCpuUsage();
        for (let attempt = 0; attempt < 128; attempt++) {
          if (cleanerPattern.test(path)) cleanerMatches++;
          if (linterPattern.test(path)) linterMatches++;
        }
        const elapsed = process.threadCpuUsage(start);
        const cpuUs = elapsed.user + elapsed.system;
        expect(cleanerMatches).toBe(matches ? 128 : 0);
        expect(linterMatches).toBe(matches ? 128 : 0);
        expect(cpuUs).toBeLessThan(250_000);
        if (size === 5_000) initialCpuUs = cpuUs;
        if (size === 320_000) expect(cpuUs / Math.max(initialCpuUs, 1)).toBeLessThan(256);
      }
    }
  });
});
