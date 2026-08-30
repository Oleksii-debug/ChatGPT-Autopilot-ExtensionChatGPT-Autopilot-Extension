import test from 'node:test';
import assert from 'node:assert/strict';
import { extractChatGptUrls, mergeBulkUrls, parsePortableJson } from '../../src/ui/config-tools.js';

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
