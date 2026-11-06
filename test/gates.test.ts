import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LedgerStore } from '../src/store.ts';
import { gateState, notChecked, runGate } from '../src/gates.ts';
import type { PrRef, Round } from '../src/types.ts';

const tmp: string[] = [];
test.after(() => {
  for (const d of tmp) fs.rmSync(d, { recursive: true, force: true });
});

const ref: PrRef = { host: 'github', hostname: 'github.com', project: 'o/r', number: 1 };
const node = process.execPath;

function setup() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-gates-'));
  tmp.push(home);
  const round: Round = { n: 1, head: 'h', base: 'b', from: 'b', startedAt: '', gates: [], reads: [], skips: [] };
  return { store: new LedgerStore(home), round, home };
}

test('a failed then a passing attempt keeps both logs and the last one decides', () => {
  const { store, round, home } = setup();
  const a1 = runGate(store, ref, round, 'test', [node, '-e', 'process.exit(1)'], home);
  const a2 = runGate(store, ref, round, 'test', [node, '-e', '0'], home);
  assert.deepEqual([a1.attempt, a1.result, a1.exitCode], [1, 'fail', 1]);
  assert.deepEqual([a2.attempt, a2.result, a2.exitCode], [2, 'pass', 0]);
  assert.equal(round.gates.length, 2);
  const dir = store.dirFor(ref);
  assert.ok(a1.log && a2.log && a1.log !== a2.log && !a1.log.includes('\\'));
  assert.ok(fs.existsSync(path.join(dir, a1.log)) && fs.existsSync(path.join(dir, a2.log)));
  assert.deepEqual(gateState(round, ['test']), { missing: [], failed: [] });
});

test('a program that does not exist is a fail with exitCode null and the error in the log', () => {
  const { store, round, home } = setup();
  const a = runGate(store, ref, round, 'x', ['no-such-program-xyz'], home);
  assert.equal(a.result, 'fail');
  assert.equal(a.exitCode, null);
  assert.ok(fs.readFileSync(path.join(store.dirFor(ref), a.log!), 'utf8').length > 0);
});

test('npm (a .cmd shim on Windows) runs as a gate', () => {
  const { store, round, home } = setup();
  const a = runGate(store, ref, round, 'npm', ['npm', '--version'], home);
  assert.equal(a.result, 'pass');
});

test('token values are redacted from the log', () => {
  const { store, round, home } = setup();
  process.env.TEST_TOKEN = 's3cr3t-value';
  try {
    const a = runGate(store, ref, round, 'tok', [node, '-e', 'console.log(process.env.TEST_TOKEN)'], home);
    const log = fs.readFileSync(path.join(store.dirFor(ref), a.log!), 'utf8');
    assert.ok(log.includes('***'));
    assert.ok(!log.includes('s3cr3t-value'));
  } finally {
    delete process.env.TEST_TOKEN;
  }
});

test('notChecked needs a reason and records not-checked', () => {
  const { round } = setup();
  assert.throws(() => notChecked(round, 'lint', ''));
  const a = notChecked(round, 'lint', 'no linter configured');
  assert.equal(a.result, 'not-checked');
  assert.equal(a.reason, 'no linter configured');
  assert.equal(round.gates.length, 1);
});

test('gateState lists missing, failed and not-checked names', () => {
  const { store, round, home } = setup();
  assert.deepEqual(gateState(round, ['lint']), { missing: ['lint'], failed: [] });
  runGate(store, ref, round, 'build', [node, '-e', 'process.exit(2)'], home);
  assert.deepEqual(gateState(round, ['build', 'lint']), { missing: ['lint'], failed: ['build'] });
});
