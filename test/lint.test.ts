import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hedges, lintFinding } from '../src/lint.ts';

const HEAD = 'abc1234def';
const lines = (file: string) => (file === 'src/a.ts' ? 40 : null);
const valid = {
  severity: 'major',
  source: { kind: 'rule', ref: 'RULE-1' },
  at: 'src/a.ts:12',
  title: 'Missing null check',
};

function errorsFor(patch: Record<string, unknown>): string[] {
  return lintFinding({ ...valid, ...patch }, HEAD, lines).errors;
}

test('a valid input takes the head sha', () => {
  const r = lintFinding({ ...valid, body: 'details' }, HEAD, lines);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.finding?.location, { file: 'src/a.ts', line: 12, sha: HEAD });
  assert.equal(r.finding?.body, 'details');
});

test('an explicit sha equal to head is accepted', () => {
  assert.deepEqual(errorsFor({ at: `src/a.ts:12@${HEAD}` }), []);
});

test('a head prefix of 7+ chars is accepted and widened to the full head', () => {
  const r = lintFinding({ ...valid, at: 'src/a.ts:12@ABC1234' }, HEAD, lines);
  assert.deepEqual(r.errors, []);
  assert.equal(r.finding?.location.sha, HEAD);
});

test('short or non-prefix shas are errors naming at', () => {
  for (const at of ['src/a.ts:12@abc123', 'src/a.ts:12@abc1235']) {
    const errors = errorsFor({ at });
    assert.equal(errors.length, 1, at);
    assert.ok(errors[0]?.startsWith('at'), errors[0]);
  }
});

test('an @ inside the path is not a sha', () => {
  const scoped = (file: string) => (file === 'packages/@scope/x.ts' ? 10 : null);
  for (const at of ['packages/@scope/x.ts:3', 'packages/@scope/x.ts:3@abc1234']) {
    const r = lintFinding({ ...valid, at }, HEAD, scoped);
    assert.deepEqual(r.errors, [], at);
    assert.equal(r.finding?.location.sha, HEAD);
  }
});

test('each bad field gives exactly one error naming it', () => {
  const cases: [Record<string, unknown>, string][] = [
    [{ severity: 'critical' }, 'severity'],
    [{ source: { kind: 'rule' } }, 'source.ref'],
    [{ source: { kind: 'opinion', ref: 'x' } }, 'source.kind'],
    [{ at: 'src/missing.ts:3' }, 'at'],
    [{ at: 'src/a.ts:50' }, 'at'],
    [{ at: 'src/a.ts:12@1111111' }, 'at'],
    [{ title: '  ' }, 'title'],
  ];
  for (const [patch, field] of cases) {
    const errors = errorsFor(patch);
    assert.equal(errors.length, 1, JSON.stringify(patch));
    assert.ok(errors[0]?.startsWith(field), errors[0]);
  }
});

test('a non-object input is one error and no finding', () => {
  const r = lintFinding('nope', HEAD, lines);
  assert.equal(r.errors.length, 1);
  assert.equal(r.finding, undefined);
});

const words = ['probably', 'seems', 'might', 'maybe', 'likely'];

test('hedges matches whole words case-insensitively', () => {
  assert.deepEqual(hedges('This probably breaks', words), ['probably']);
  assert.deepEqual(hedges('Probably, it MIGHT fail', words), ['probably', 'might']);
  assert.deepEqual(hedges('Probabilistic test', words), []);
});

test('hedges works for non-ASCII words', () => {
  assert.deepEqual(hedges('Có vẻ sai', ['có vẻ']), ['có vẻ']);
  assert.deepEqual(hedges('Cóvẻ sai', ['có']), []);
});
