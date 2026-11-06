import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { LedgerStore } from '../src/store.ts';
import { git, passTest, ref, removeTmp, setup, steps, type Review } from './e2e-helper.ts';

test.after(removeTmp);

const ledger = (s: Review) => new LedgerStore(s.home).load(ref)!;

test('a round without a verdict leaves its unread files in the next round', async () => {
  const s = setup();
  await steps(s, ['start', 'o/r#1']);
  s.push('src/b.ts', 'b2\n');
  const r = await s.rp('start', 'o/r#1');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^round 2 .*: head \w+, 3 changed files since /m);
  assert.equal(ledger(s).rounds[1]?.from, s.host.base);
  await steps(s, ['read', 'src/b.ts'], passTest);
  const v = await s.rp('verdict', 'pass', '--summary', 'Clean.');
  assert.equal(v.code, 1);
  assert.match(v.err, /file src\/a\.ts unread\n {2}- file src\/c\.ts unread/);
});

test('start --force on the same head keeps the files the earlier round did not read', async () => {
  const s = setup();
  await steps(s, ['start', 'o/r#1'], ['read', 'src/a.ts']);
  const r = await s.rp('start', 'o/r#1', '--force');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^round 2 .*, 2 changed files since /m);
  assert.equal(ledger(s).rounds[1]?.from, s.host.base);
});

test('the next round diffs from the head of the latest round that has a verdict', async () => {
  const s = setup();
  await steps(s, ['start', 'o/r#1'], ['diff'], passTest, ['verdict', 'not-yet', '--summary', 'Later.']);
  const judged = s.host.head;
  s.push('src/b.ts', 'b2\n');
  await steps(s, ['start', 'o/r#1']);
  s.push('src/c.ts', 'c2\n');
  await steps(s, ['start', 'o/r#1']);
  assert.deepEqual(ledger(s).rounds.map((x) => x.from), [s.host.base, judged, judged]);
  assert.match((await s.rp('status')).out, /coverage: read 0 of 2 changed files/);
  const full = s.push('src/b.ts', 'b3\n');
  const r = await s.rp('start', 'o/r#1', '--full');
  assert.match(r.out, new RegExp(`head ${full}, 3 changed files since ${s.host.base}`));
});

test('start needs no pull ref on the remote when the checkout is already at the PR head', async () => {
  const s = setup();
  git(path.join(s.root, 'remote.git'), 'update-ref', '-d', 'refs/pull/1/head');
  const r = await s.rp('start', 'o/r#1');
  assert.equal(r.code, 0, r.err);
  assert.equal(r.err, '');
  // Off the head, the failed fetch is only a warning next to the real problem.
  s.host.head = s.host.base;
  const off = await s.rp('start', 'o/r#1', '--force');
  assert.equal(off.code, 1);
  assert.match(off.err, /^warning: git fetch origin pull\/1\/head failed/m);
  assert.match(off.err, new RegExp(`the checkout is at \\w+, the PR head is ${s.host.base}: run git switch`));
});
