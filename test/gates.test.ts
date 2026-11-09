import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LedgerStore } from '../src/store.ts';
import { captureGate, gateState, notChecked, recordGate } from '../src/gates.ts';
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
  const store = new LedgerStore(home);
  // Run, then record: the two steps `gate run` takes on either side of taking the ledger lock.
  const gate = (name: string, argv: string[]) => recordGate(store, ref, round, name, captureGate(argv, home));
  return { store, round, gate };
}

test('a failed then a passing attempt keeps both logs and the last one decides', () => {
  const { store, round, gate } = setup();
  const a1 = gate('test', [node, '-e', 'process.exit(1)']);
  const a2 = gate('test', [node, '-e', '0']);
  assert.deepEqual([a1.attempt, a1.result, a1.exitCode], [1, 'fail', 1]);
  assert.deepEqual([a2.attempt, a2.result, a2.exitCode], [2, 'pass', 0]);
  assert.equal(round.gates.length, 2);
  const dir = store.dirFor(ref);
  assert.ok(a1.log && a2.log && a1.log !== a2.log && !a1.log.includes('\\'));
  assert.ok(fs.existsSync(path.join(dir, a1.log)) && fs.existsSync(path.join(dir, a2.log)));
  assert.deepEqual(gateState(round, ['test']), { missing: [], failed: [], notChecked: [], stale: [] });
});

test('a program that does not exist is a fail with exitCode null and the error in the log', () => {
  const { store, gate } = setup();
  const a = gate('x', ['no-such-program-xyz']);
  assert.equal(a.result, 'fail');
  assert.equal(a.exitCode, null);
  assert.ok(fs.readFileSync(path.join(store.dirFor(ref), a.log!), 'utf8').length > 0);
});

test('npm (a .cmd shim on Windows) runs as a gate', () => {
  const { gate } = setup();
  const a = gate('npm', ['npm', '--version']);
  assert.equal(a.result, 'pass');
});

test('token values are redacted from the log', () => {
  const { store, gate } = setup();
  process.env.TEST_TOKEN = 's3cr3t-value';
  try {
    const a = gate('tok', [node, '-e', 'console.log(process.env.TEST_TOKEN)']);
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

test('an attempt number skipped for a log already there is not handed out again', () => {
  const { store, round, gate } = setup();
  store.writeLog(ref, 1, 'lint', 1, 'lost');
  assert.equal(gate('lint', [node, '-e', '0']).attempt, 2);
  assert.equal(notChecked(round, 'lint', 'no linter').attempt, 3);
});

test('gateState lists missing, failed and not-checked names', () => {
  const { round, gate } = setup();
  assert.deepEqual(gateState(round, ['lint']), { missing: ['lint'], failed: [], notChecked: [], stale: [] });
  gate('build', [node, '-e', 'process.exit(2)']);
  assert.deepEqual(gateState(round, ['build', 'lint']), {
    missing: ['lint'],
    failed: ['build'],
    notChecked: [],
    stale: [],
  });
  notChecked(round, 'lint', 'no linter');
  assert.deepEqual(gateState(round, ['lint']), { missing: [], failed: [], notChecked: ['lint'], stale: [] });
});
