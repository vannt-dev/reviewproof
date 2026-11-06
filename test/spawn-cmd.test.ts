import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCapture } from '../src/spawn.ts';

const win = process.platform === 'win32';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-cmd-'));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

// A .cmd shim on PATH is only found by the cmd.exe retry; it prints the arguments it received.
fs.writeFileSync(path.join(dir, 'show.js'), 'console.log(JSON.stringify(process.argv.slice(2)))\n');
fs.writeFileSync(path.join(dir, 'showargs.cmd'), `@"${process.execPath}" "%~dp0show.js" %*\r\n`);
const oldPath = process.env.PATH;
process.env.PATH = `${dir}${path.delimiter}${oldPath ?? ''}`;
test.after(() => {
  process.env.PATH = oldPath;
});
const env = {};

test('cmd retry: a trailing backslash does not swallow the closing quote', { skip: !win }, () => {
  const r = runCapture(['showargs', 'a b\\', 'c'], dir, env);
  assert.deepEqual(JSON.parse(r.stdout), ['a b\\', 'c']);
});

test('cmd retry: & in an argument does not start a second command', { skip: !win }, () => {
  const r = runCapture(['showargs', 'x&echo INJECT'], dir, env);
  assert.deepEqual(JSON.parse(r.stdout), ['x&echo INJECT']);
  assert.ok(!r.output.split(/\r?\n/).includes('INJECT'));
});
