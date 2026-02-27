import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, unlink } from 'fs/promises';
import { join } from 'path';
import { tmpdir, homedir } from 'os';

import {
  parseSince,
  extractCodeBlocks,
  projectName,
  loadMessages,
} from '../src/search.js';

// ── parseSince ──────────────────────────────────────────────────────────────

describe('parseSince', () => {
  test('null returns null', () => {
    assert.equal(parseSince(null), null);
  });

  test('ISO date string returns correct Date', () => {
    const result = parseSince('2024-01-15');
    assert.ok(result instanceof Date, 'should be a Date');
    // Use UTC methods — new Date('2024-01-15') parses as UTC midnight
    assert.equal(result.getUTCFullYear(), 2024);
    assert.equal(result.getUTCMonth(), 0);  // January
    assert.equal(result.getUTCDate(), 15);
  });

  test('"1 day ago" returns approximately 1 day in the past', () => {
    const before = Date.now();
    const result = parseSince('1 day ago');
    const after  = Date.now();
    const expectedMs = 24 * 60 * 60 * 1000;
    const delta = before - result.getTime();
    assert.ok(delta >= expectedMs - 1000, 'should be at least ~1 day ago');
    assert.ok(delta <= expectedMs + (after - before) + 1000, 'should not be more than 1 day ago');
  });

  test('"2 weeks ago" returns approximately 14 days in the past', () => {
    const result = parseSince('2 weeks ago');
    const expectedMs = 14 * 24 * 60 * 60 * 1000;
    const delta = Date.now() - result.getTime();
    assert.ok(delta >= expectedMs - 1000, 'should be at least ~2 weeks ago');
    assert.ok(delta <= expectedMs + 2000, 'should not be more than 2 weeks ago');
  });

  test('"3 months ago" moves month back by 3', () => {
    const result = parseSince('3 months ago');
    const expected = new Date();
    expected.setMonth(expected.getMonth() - 3);
    // Allow 1-second tolerance for slow machines
    assert.ok(Math.abs(result.getTime() - expected.getTime()) < 1000);
  });

  test('"2 hours ago" returns approximately 2 hours in the past', () => {
    const result = parseSince('2 hours ago');
    const expectedMs = 2 * 60 * 60 * 1000;
    const delta = Date.now() - result.getTime();
    assert.ok(delta >= expectedMs - 500);
    assert.ok(delta <= expectedMs + 2000);
  });

  test('plural form works ("2 days ago")', () => {
    const result = parseSince('2 days ago');
    const expectedMs = 2 * 24 * 60 * 60 * 1000;
    const delta = Date.now() - result.getTime();
    assert.ok(delta >= expectedMs - 500);
    assert.ok(delta <= expectedMs + 2000);
  });

  test('invalid string throws', () => {
    assert.throws(
      () => parseSince('last tuesday'),
      /Cannot parse --since value/,
    );
  });

  test('empty string returns null (treated as absent)', () => {
    // Empty string is falsy — same as not passing --since at all
    assert.equal(parseSince(''), null);
  });
});

// ── extractCodeBlocks ───────────────────────────────────────────────────────

describe('extractCodeBlocks', () => {
  test('returns empty array when no fenced blocks', () => {
    const blocks = extractCodeBlocks('Hello world, no code here.');
    assert.deepEqual(blocks, []);
  });

  test('single block with language tag', () => {
    const content = 'Here is some code:\n```python\nprint("hi")\n```\ndone';
    const blocks = extractCodeBlocks(content);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].lang, 'python');
    assert.equal(blocks[0].code, 'print("hi")');
  });

  test('block without language defaults to "text"', () => {
    const content = '```\nsome content\n```';
    const blocks = extractCodeBlocks(content);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].lang, 'text');
    assert.equal(blocks[0].code, 'some content');
  });

  test('multiple blocks extracted in order', () => {
    const content = [
      '```javascript',
      'const x = 1;',
      '```',
      'some text',
      '```typescript',
      'const y: number = 2;',
      '```',
    ].join('\n');
    const blocks = extractCodeBlocks(content);
    assert.equal(blocks.length, 2);
    assert.equal(blocks[0].lang, 'javascript');
    assert.equal(blocks[0].code, 'const x = 1;');
    assert.equal(blocks[1].lang, 'typescript');
    assert.equal(blocks[1].code, 'const y: number = 2;');
  });

  test('multi-line code blocks preserved', () => {
    const content = '```python\ndef foo():\n    return 42\n```';
    const blocks = extractCodeBlocks(content);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].code, 'def foo():\n    return 42');
  });

  test('accepts array content (multi-block message format)', () => {
    const content = [
      { type: 'text', text: 'Here:\n```js\nconsole.log(1);\n```' },
      { type: 'text', text: 'And:\n```bash\necho hi\n```' },
    ];
    const blocks = extractCodeBlocks(content);
    assert.equal(blocks.length, 2);
    assert.equal(blocks[0].lang, 'js');
    assert.equal(blocks[1].lang, 'bash');
  });

  test('non-text content blocks ignored', () => {
    const content = [
      { type: 'tool_use', name: 'bash', input: { command: 'ls' } },
      { type: 'text', text: 'No code here.' },
    ];
    const blocks = extractCodeBlocks(content);
    assert.deepEqual(blocks, []);
  });
});

// ── projectName ─────────────────────────────────────────────────────────────

describe('projectName', () => {
  const home = homedir();
  // Construct a fake sessionsDir and filePath that mirrors Claude's slug format.
  // Claude stores sessions at: ~/.claude/projects/<slug>/<session-id>.jsonl
  // Slug = absolute path with every '/' replaced by '-', e.g.
  //   /Users/piyushk/Projects/my-app  →  -Users-piyushk-Projects-my-app
  const sessionsDir = join(home, '.claude', 'projects');

  function makeSlug(absPath) {
    return absPath.slice(1).replace(/\//g, '-');
  }

  test('strips home-dir prefix and returns project folder name', () => {
    const projectPath = join(home, 'Projects', 'my-app');
    const slug        = '-' + makeSlug(projectPath);
    const filePath    = join(sessionsDir, slug, 'abc123.jsonl');

    const result = projectName(sessionsDir, filePath);
    assert.equal(result, 'Projects-my-app');
  });

  test('hyphenated project names are preserved', () => {
    const projectPath = join(home, 'Projects', 'super-cool-app');
    const slug        = '-' + makeSlug(projectPath);
    const filePath    = join(sessionsDir, slug, 'abc123.jsonl');

    const result = projectName(sessionsDir, filePath);
    assert.equal(result, 'Projects-super-cool-app');
  });

  test('single-segment project (no sub-dir) still works', () => {
    const projectPath = join(home, 'myproject');
    const slug        = '-' + makeSlug(projectPath);
    const filePath    = join(sessionsDir, slug, 'abc123.jsonl');

    const result = projectName(sessionsDir, filePath);
    assert.equal(result, 'myproject');
  });
});

// ── loadMessages ────────────────────────────────────────────────────────────

describe('loadMessages', () => {
  async function writeTmp(name, content) {
    const filePath = join(tmpdir(), `claude-search-test-${name}-${Date.now()}.jsonl`);
    await writeFile(filePath, content, 'utf8');
    return filePath;
  }

  test('parses valid JSONL lines', async () => {
    const lines = [
      JSON.stringify({ type: 'user',      message: { role: 'user',      content: 'hello' } }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'world' } }),
    ].join('\n');
    const fp = await writeTmp('valid', lines);
    try {
      const { records, messages } = await loadMessages(fp);
      assert.equal(records.length, 2);
      assert.equal(messages.length, 2);
    } finally {
      await unlink(fp);
    }
  });

  test('skips corrupt lines, keeps valid ones', async () => {
    const lines = [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'good line' } }),
      '{this is not valid json!!!',
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'also good' } }),
    ].join('\n');
    const fp = await writeTmp('corrupt', lines);
    try {
      const { records, messages } = await loadMessages(fp);
      assert.equal(records.length, 2, 'corrupt line should be skipped');
      assert.equal(messages.length, 2);
    } finally {
      await unlink(fp);
    }
  });

  test('empty file returns empty arrays', async () => {
    const fp = await writeTmp('empty', '');
    try {
      const { records, messages } = await loadMessages(fp);
      assert.equal(records.length, 0);
      assert.equal(messages.length, 0);
    } finally {
      await unlink(fp);
    }
  });

  test('blank lines are ignored', async () => {
    const lines = [
      '',
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }),
      '',
      '',
    ].join('\n');
    const fp = await writeTmp('blanks', lines);
    try {
      const { records } = await loadMessages(fp);
      assert.equal(records.length, 1);
    } finally {
      await unlink(fp);
    }
  });

  test('non-message records included in records but not messages', async () => {
    const lines = [
      JSON.stringify({ type: 'system',    data: 'metadata' }),
      JSON.stringify({ type: 'user',      message: { role: 'user', content: 'hi' } }),
      JSON.stringify({ type: 'tool_use',  name: 'bash' }),
    ].join('\n');
    const fp = await writeTmp('mixed', lines);
    try {
      const { records, messages } = await loadMessages(fp);
      assert.equal(records.length, 3, 'all parseable lines in records');
      assert.equal(messages.length, 1, 'only user/assistant in messages');
    } finally {
      await unlink(fp);
    }
  });

  test('file with only corrupt lines returns empty arrays', async () => {
    const lines = [
      '{broken',
      'not json at all',
      '}}}}',
    ].join('\n');
    const fp = await writeTmp('allcorrupt', lines);
    try {
      const { records, messages } = await loadMessages(fp);
      assert.equal(records.length, 0);
      assert.equal(messages.length, 0);
    } finally {
      await unlink(fp);
    }
  });
});
