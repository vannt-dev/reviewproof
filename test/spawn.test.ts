import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { runCapture } from '../src/spawn.ts';

const node = process.execPath;

// gh writes notices to stderr on success; a caller parsing JSON must get stdout alone.
test('stdout comes back on its own; output keeps both streams for logs', () => {
  const r = runCapture([node, '-e', 'process.stdout.write("{}"); process.stderr.write("notice")'], os.tmpdir());
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '{}');
  assert.equal(r.output, '{}notice');
});

test('extra environment variables reach the child next to the inherited ones', () => {
  const script = 'process.stdout.write(`${process.env.RP_EXTRA}/${process.env.PATH ? "path" : "none"}`)';
  const r = runCapture([node, '-e', script], os.tmpdir(), { RP_EXTRA: '1' });
  assert.equal(r.stdout, '1/path');
});
