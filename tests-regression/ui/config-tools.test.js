import test from 'node:test';
import assert from 'node:assert/strict';
import { extractChatGptUrls, mergeBulkUrls, parsePortableJson, parseStrictBoundedInteger } from '../../src/ui/config-tools.js';

test('bulk URL parser accepts lines numbered lists and whitespace while deduplicating normalized ChatGPT URLs', () => {
  const urls = extractChatGptUrls(`
1. https://chatgpt.com/c/aaa
2) https://www.chatgpt.com/c/bbb?x=1#y https://chatgpt.com/c/aaa/
not-a-url https://example.com/c/no
`);
  assert.deepEqual(urls, [
    'https://chatgpt.com/c/aaa',
    'https://chatgpt.com/c/bbb',
  ]);
});

test('bulk add preserves existing tasks and ignores duplicate URLs', () => {
  let sequence = 0;
  const existing = [{ id: 'old', enabled: true, label: 'Old', url: 'https://chatgpt.com/c/a', promptOverride: 'p' }];
  const result = mergeBulkUrls(existing, ['https://chatgpt.com/c/a', 'https://chatgpt.com/c/b'], {
    idFactory: () => `new-${++sequence}`,
  });
  assert.equal(result.tasks.length, 2);
  assert.equal(result.tasks[0].id, 'old');
  assert.equal(result.tasks[1].id, 'new-1');
  assert.equal(result.added, 1);
});

test('bulk replace preserves task identity and per-task prompt for URLs that remain', () => {
  const existing = [
    { id: 'a', enabled: true, label: 'A', url: 'https://chatgpt.com/c/a', promptOverride: 'unique A' },
    { id: 'b', enabled: true, label: 'B', url: 'https://chatgpt.com/c/b', promptOverride: 'unique B' },
  ];
  const result = mergeBulkUrls(existing, ['https://chatgpt.com/c/b', 'https://chatgpt.com/c/c'], {
    replace: true,
    idFactory: () => 'c',
  });
  assert.equal(result.tasks[0].id, 'b');
  assert.equal(result.tasks[0].promptOverride, 'unique B');
  assert.equal(result.tasks[1].id, 'c');
});

test('portable JSON parser rejects empty malformed and oversized input', () => {
  assert.throws(() => parsePortableJson(''), /порожній/);
  assert.throws(() => parsePortableJson('{no'), /JSON/);
  assert.deepEqual(parsePortableJson('{"format":"x"}'), { format: 'x' });
});

test('portable JSON parser accepts profiles larger than the old 2 MB cap', () => {
  const huge = 'x'.repeat(2 * 1024 * 1024 + 1000);
  const parsed = parsePortableJson(JSON.stringify({ format: 'x', prompt: huge }));
  assert.equal(parsed.prompt.length, huge.length);
});


test('strict orchestration integer parser requires an explicit bounded integer, including explicit zero', () => {
  assert.equal(parseStrictBoundedInteger('0', { min:0, max:100, label:'Ліміт' }), 0);
  assert.equal(parseStrictBoundedInteger(' 12 ', { min:0, max:100, label:'Ліміт' }), 12);
  assert.throws(() => parseStrictBoundedInteger('', { min:0, max:100, label:'Ліміт' }), /введіть ціле число/);
  assert.throws(() => parseStrictBoundedInteger(' ', { min:0, max:100, label:'Ліміт' }), /введіть ціле число/);
  assert.throws(() => parseStrictBoundedInteger('1e2', { min:0, max:100, label:'Ліміт' }), /введіть ціле число/);
  assert.throws(() => parseStrictBoundedInteger('1.5', { min:0, max:100, label:'Ліміт' }), /введіть ціле число/);
  assert.throws(() => parseStrictBoundedInteger('101', { min:0, max:100, label:'Ліміт' }), /0-100/);
});
