import assert from 'node:assert/strict';
import test from 'node:test';
import type { Config } from '../src/config.ts';
import type { Coverage } from '../src/coverage.ts';
import { addFinding } from '../src/rounds.ts';
import { notChecked } from '../src/gates.ts';
import { verdictBlockers } from '../src/verdict.ts';
import type { Ledger } from '../src/types.ts';
import { ready } from './ready-ledger.ts';

const cfg: Config = {
  requiredGates: ['test'],
  skip: [],
  hedgeWords: ['probably'],
};
const at = { file: 'a.ts', line: 1, sha: 'h2' };
const readyCov = (): Coverage => ({
  read: ['a.ts'],
  partial: [],
  unread: [],
  skipped: [],
});

const check = (l: Ledger, cov = readyCov(), value: 'pass' | 'not-yet' = 'pass', s = 'All good') =>
  verdictBlockers(l, cov, cfg, value, s);

test('a ready ledger has no blockers', () => assert.deepEqual(check(ready()), []));

test('each blocker kind shows up alone', () => {
  const missing = ready();
  missing.rounds[1]!.gates = [];
  assert.deepEqual(check(missing), ['gate test missing']);
  const failed = ready();
  failed.rounds[1]!.gates[0]!.result = 'fail';
  assert.deepEqual(check(failed), ['gate test failed']);
  const unchecked = ready();
  notChecked(unchecked.rounds[1]!, 'test', 'no runner');
  assert.deepEqual(check(unchecked), ['gate test not checked: no runner']);
  assert.deepEqual(check(ready(), { ...readyCov(), unread: ['b.ts'] }), ['file b.ts unread']);
  assert.deepEqual(check(ready(), { ...readyCov(), partial: ['c.ts'] }), ['file c.ts only partly read']);
  const open = ready();
  addFinding(open, {
    severity: 'blocking',
    source: { kind: 'rule', ref: 'R1' },
    location: at,
    title: 'y',
  });
  assert.deepEqual(check(open), ['blocking finding F2-1 is open']);
  assert.deepEqual(check(ready(), readyCov(), 'pass', 'Looks fine, probably'), ['summary hedges: probably']);
  assert.deepEqual(check(ready(), readyCov(), 'pass', '  '), ['summary is empty']);
});

test('a carried finding without a status is named, for both values', () => {
  const l = ready();
  l.findings[0]!.history = [{ round: 1, status: 'open' }];
  const expected = ['finding F1-1 carried without a status this round', 'blocking finding F1-1 is open'];
  assert.deepEqual(check(l), expected);
  assert.deepEqual(check(l, readyCov(), 'not-yet'), [expected[0]]);
});

test('not-yet is allowed with an open blocking finding and a failed or unchecked gate', () => {
  const l = ready();
  addFinding(l, {
    severity: 'blocking',
    source: { kind: 'rule', ref: 'R1' },
    location: at,
    title: 'y',
  });
  l.rounds[1]!.gates[0]!.result = 'fail';
  assert.deepEqual(check(l, readyCov(), 'not-yet'), []);
  notChecked(l.rounds[1]!, 'test', 'skipped');
  assert.deepEqual(check(l, readyCov(), 'not-yet'), []);
});
