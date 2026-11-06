import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { withLock } from '../src/lock.ts';
import { runNode } from './e2e-helper.ts';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-lock-'));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

let cases = 0;
// A lock in a folder of its own that does not exist yet: withLock makes it.
const lockFile = (): string => path.join(root, `case-${++cases}`, 'ledger.lock');

function held(pid: number, at = new Date()): string {
  const file = lockFile();
  fs.mkdirSync(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify({ pid, at: at.toISOString() }));
  return file;
}

const lockUrl = pathToFileURL(path.join(import.meta.dirname, '..', 'src', 'lock.ts')).href;

// Read, pause, write: without the lock two processes overwrite each other's increments.
const counter = `
import fs from 'node:fs';
import { withLock } from ${JSON.stringify(lockUrl)};
const [file, lock] = process.argv.slice(1);
const pause = new Int32Array(new SharedArrayBuffer(4));
for (let i = 0; i < 25; i++) {
  withLock(lock, () => {
    const n = Number(fs.readFileSync(file, 'utf8'));
    Atomics.wait(pause, 0, 0, 2);
    fs.writeFileSync(file, String(n + 1));
  });
}
`;

test('two processes doing 25 locked increments each end at 50', async () => {
  const lock = lockFile();
  const file = path.join(root, 'counter');
  fs.writeFileSync(file, '0');
  const args = ['--input-type=module', '-e', counter, file, lock];
  const runs = await Promise.all([runNode(args), runNode(args)]);
  for (const r of runs) assert.equal(r.code, 0, r.err);
  assert.equal(fs.readFileSync(file, 'utf8'), '50');
  assert.equal(fs.existsSync(lock), false);
});

test('a lock left by a dead process is taken over at once', () => {
  const dead = spawnSync(process.execPath, ['-e', '0']).pid;
  const lock = held(dead);
  assert.equal(withLock(lock, () => 'ran', { timeoutMs: 200 }), 'ran');
  assert.equal(fs.existsSync(lock), false);
});

test('a fresh lock of a live process makes the call fail after the timeout and stays', () => {
  const lock = held(process.pid);
  let ran = false;
  const started = Date.now();
  assert.throws(
    () => withLock(lock, () => (ran = true), { timeoutMs: 200 }),
    /^Error: .+[\\/]ledger\.lock is locked by pid \d+ since \d{4}-\d\d-\d\dT[\d:.]+Z; try again$/,
  );
  assert.ok(Date.now() - started >= 150, 'it waited for the holder first');
  assert.equal(ran, false);
  assert.ok(fs.existsSync(lock));
});

test('a live lock older than staleMs is taken over', () => {
  const lock = held(process.pid, new Date(Date.now() - 60_000));
  assert.equal(withLock(lock, () => 1, { timeoutMs: 200 }), 1);
  assert.equal(withLock(held(process.pid, new Date(Date.now() - 500)), () => 2, { timeoutMs: 200, staleMs: 100 }), 2);
});

test('the lock is removed when fn throws, but not once another process has taken it over', () => {
  const lock = lockFile();
  assert.throws(() => withLock(lock, () => { throw new Error('boom'); }), /^Error: boom$/);
  assert.equal(fs.existsSync(lock), false);
  const other = JSON.stringify({ pid: process.pid, at: 'taken over' });
  withLock(lock, () => fs.writeFileSync(lock, other));
  assert.equal(fs.readFileSync(lock, 'utf8'), other);
});
