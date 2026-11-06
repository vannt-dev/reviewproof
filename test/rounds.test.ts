import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addFinding, carried, currentStatus, mark, startRound } from '../src/rounds.ts';
import type { NewFinding, PrRef } from '../src/types.ts';

const ref: PrRef = { host: 'github', hostname: 'github.com', project: 'o/r', number: 1 };
const pr = (head: string) => ({ url: 'https://x/1', title: 't', head, base: 'main0001' });
const nf = (title: string): NewFinding => ({
  severity: 'major',
  source: { kind: 'rule', ref: 'r1' },
  location: { file: 'src/a.ts', line: 3, sha: 'abc1234' },
  title,
});

function twoRounds() {
  let l = startRound(null, ref, pr('abc1234'), 'cli', new Date(0), false);
  addFinding(l, nf('one'));
  addFinding(l, nf('two'));
  l = startRound(l, ref, pr('def5678'), 'cli', new Date(1), false);
  return l;
}

test('first round creates the ledger', () => {
  const l = startRound(null, ref, pr('abc1234'), 'cli', new Date(0), false);
  assert.equal(l.rounds.length, 1);
  assert.equal(l.rounds[0]?.n, 1);
  assert.equal(l.rounds[0]?.startedAt, new Date(0).toISOString());
  assert.equal(l.pr.title, 't');
});

test('same head throws unless forced', () => {
  const l = startRound(null, ref, pr('abc1234'), 'cli', new Date(0), false);
  assert.throws(
    () => startRound(l, ref, pr('abc1234'), 'cli', new Date(1), false),
    /head abc1234 unchanged since round 1/,
  );
  assert.equal(startRound(l, ref, pr('abc1234'), 'cli', new Date(1), true).rounds.length, 2);
});

test('finding ids run per round', () => {
  const l = twoRounds();
  assert.equal(addFinding(l, nf('three')).id, 'F2-1');
  assert.deepEqual(l.findings.map((f) => f.id), ['F1-1', 'F1-2', 'F2-1']);
  assert.deepEqual(l.findings[0]?.history, [{ round: 1, status: 'open' }]);
});

test('addFinding without rounds throws', () => {
  const l = { schemaVersion: 1 as const, pr: { ...ref, url: '', title: '' }, rounds: [], findings: [] };
  assert.throws(() => addFinding(l, nf('x')), /round/);
});

test('earlier open findings are carried', () => {
  const l = twoRounds();
  assert.deepEqual(carried(l).map((f) => f.id), ['F1-1', 'F1-2']);
});

test('withdrawing needs evidence', () => {
  const l = twoRounds();
  assert.throws(() => mark(l, 'F1-1', 'withdrawn', { evidence: 'the author disagrees' }), /evidence/);
  mark(l, 'F1-1', 'withdrawn', { evidence: 'handled in src/a.ts:9@def5678' });
  assert.deepEqual(carried(l).map((f) => f.id), ['F1-2']);
  assert.equal(currentStatus(l.findings[0]!), 'withdrawn');
});

test('reopening needs a location at the new head', () => {
  const l = twoRounds();
  assert.throws(() => mark(l, 'F1-1', 'reopened', {}), /location at the new head/);
  const old = { file: 'src/a.ts', line: 3, sha: 'abc1234' };
  assert.throws(() => mark(l, 'F1-1', 'reopened', { location: old }), /location at the new head/);
  const location = { file: 'src/a.ts', line: 4, sha: 'def5678' };
  mark(l, 'F1-1', 'reopened', { location });
  assert.deepEqual(l.findings[0]?.history[1], { round: 2, status: 'reopened', location });
  assert.equal(carried(l).length, 1);
});

test('reopened findings stay carried into the next round', () => {
  const l = twoRounds();
  mark(l, 'F1-1', 'reopened', { location: { file: 'a', line: 1, sha: 'def5678' } });
  mark(l, 'F1-2', 'verified', {});
  const next = startRound(l, ref, pr('9999999'), 'cli', new Date(2), false);
  assert.deepEqual(carried(next).map((f) => f.id), ['F1-1']);
});

test('re-marking in the same round replaces the entry', () => {
  const l = twoRounds();
  mark(l, 'F1-1', 'verified', {});
  mark(l, 'F1-1', 'verified', { evidence: 'ok' });
  assert.equal(l.findings[0]?.history.length, 2);
  assert.equal(l.findings[0]?.history[1]?.evidence, 'ok');
});

test('marking a current-round or unknown id throws', () => {
  const l = twoRounds();
  const f = addFinding(l, nf('new'));
  assert.throws(() => mark(l, f.id, 'verified', {}), /carried/);
  assert.throws(() => mark(l, 'F9-9', 'verified', {}), /carried/);
});
