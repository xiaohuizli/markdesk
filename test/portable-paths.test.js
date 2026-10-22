import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRelative } from '../src/search.js';
test('Windows ripgrep paths remain usable by the tree and HTTP document API', () => {
  assert.equal(normalizeRelative('.\\notes\\中文.md', 'win32'), 'notes/中文.md');
  assert.equal(normalizeRelative('notes/中文.md', 'win32'), 'notes/中文.md');
  assert.equal(normalizeRelative('./notes/中文.md', 'darwin'), 'notes/中文.md');
  assert.equal(normalizeRelative('./literal\\name.md', 'darwin'), 'literal\\name.md');
});
