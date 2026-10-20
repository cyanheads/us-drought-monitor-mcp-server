/**
 * @fileoverview Reference tool public schema, error recovery and content fidelity.
 * @module tests/services/drought/reference-tool
 */
import { execFileSync } from 'node:child_process';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';
import { droughtListReferenceTool } from '@/mcp-server/tools/definitions/drought-list-reference.tool.js';
import { listReference } from '@/services/drought/reference-data.js';

describe('drought_list_reference public contract', () => {
  it.each([
    { topic: 'states', nameContains: 'zzzz-no-match', limit: 200 },
    { topic: 'states', nameContains: 'Alabama', limit: 200 },
    { topic: 'counties', state: 'TX', limit: 200 },
  ] as const)('returns a complete dual-surface page for %o', async (input) => {
    const result = await runToolContract(droughtListReferenceTool, input);
    expect(result.isError).not.toBe(true);
    const parsed = droughtListReferenceTool.output.parse(result.structuredContent);
    expect(parsed.records).toHaveLength(
      input.topic === 'counties' ? 200 : input.nameContains === 'Alabama' ? 1 : 0,
    );
    const blocks = await droughtListReferenceTool.format?.(parsed);
    const rendered = result.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n');
    expect(JSON.stringify(result.structuredContent).length).toBeLessThanOrEqual(80_000);
    expect(rendered.length).toBeLessThanOrEqual(80_000);
    for (const block of blocks ?? [])
      if (block.type === 'text') expect(rendered).toContain(block.text);
    for (const record of parsed.records) {
      expect(rendered).toContain(record.id);
      expect(rendered).toContain(record.name);
      if ('sourceVintage' in record) expect(rendered).toContain(record.sourceVintage);
    }
    expect(rendered).toContain(parsed.bundleVersion);
    for (const source of parsed.sourceMetadata) expect(rendered).toContain(source.sha256);
    if (!parsed.totalCount) expect(rendered).toContain('No reference names match these filters');
  });
  it('round-trips special reference values through a real Markdown parser', async () => {
    const name = 'Label | <tag> & `tick`\nnext line\r\nlast line';
    const description = '```\nembedded fence\n```';
    const url = 'https://example.org/reference?one=1&two=2';
    const data = droughtListReferenceTool.output.parse({
      ...listReference({ topic: 'categories' }),
      records: [{ id: 'special', name, description }],
      provenance: { ...listReference({ topic: 'coverage' }).provenance, sourceUrls: [url] },
    });
    const blocks = await droughtListReferenceTool.format?.(data);
    const markdown = (blocks ?? [])
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n');
    const html = execFileSync(
      'bun',
      ['-e', 'console.log(Bun.markdown.html(await Bun.stdin.text()))'],
      { input: markdown, encoding: 'utf8' },
    );
    const decode = (value: string) =>
      value
        .replace(/&#(x[\da-f]+|\d+);/gi, (_, code: string) =>
          String.fromCodePoint(
            code.startsWith('x') ? Number.parseInt(code.slice(1), 16) : Number(code),
          ),
        )
        .replace(
          /&(amp|lt|gt|quot|apos);/g,
          (_, entity: string) =>
            ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[entity] ?? '',
        );
    const scalarValues = [...html.matchAll(/<pre><code[^>]*>([\s\S]*?)<\/code><\/pre>/g)].map(
      (match) => JSON.parse(decode(match[1] ?? '')),
    );
    expect(scalarValues).toContain(name);
    expect(scalarValues).toContain(description);
    expect(html).toContain(`href="${url.replaceAll('&', '&amp;')}"`);
  });
  it('accepts blank optional form filters as omitted', async () => {
    const blank = await runToolContract(droughtListReferenceTool, {
      topic: 'states',
      nameContains: '',
      state: '',
      cursor: '',
    });
    const omitted = await runToolContract(droughtListReferenceTool, { topic: 'states' });
    expect(blank.isError).not.toBe(true);
    expect(blank.structuredContent).toEqual(omitted.structuredContent);
    expect(blank.content).toEqual(omitted.content);
  });
  it.each([
    [{ topic: 'states', state: 'TX' }, 'invalid_reference_filter'],
    [{ topic: 'huc' }, 'invalid_reference_filter'],
    [{ topic: 'states', cursor: 'bad' }, 'invalid_cursor'],
    [{ topic: 'counties', state: 'not a state' }, 'unknown_area'],
  ] as const)('mirrors %s error and recovery on both consumption paths', async (input, reason) => {
    const result = await runToolContract(droughtListReferenceTool, input);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { data: { reason, recovery: { hint: expect.any(String) } } },
    });
    const text = result.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n');
    const contract = droughtListReferenceTool.errors?.find((error) => error.reason === reason);
    expect(text).toContain(reason);
    expect(text).toContain(contract?.recovery);
  });
});
