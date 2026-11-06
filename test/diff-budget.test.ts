import { test } from 'node:test';
import assert from 'node:assert/strict';
import { removeTmp, setup, steps } from './e2e-helper.ts';

// Each test file runs in its own process, so the budget set here reaches no other file.
const budget = (chars: number): void => void (process.env.REVIEWPROOF_DIFF_BUDGET = String(chars));
test.after(removeTmp);

test('diff prints the files that fit, in order, and counts only those read', async () => {
  const s = setup();
  s.push('src/big.ts', `${'x'.repeat(60)}\n`.repeat(40));
  await steps(s, ['start', 'o/r#1']);
  budget(1000);
  const r = await s.rp('diff');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^\+TWO$[^]*^\+c$/m);
  assert.doesNotMatch(r.out, /xxx/);
  assert.match(r.out, /2 changed files counted as read/);
  assert.equal(r.err, 'not shown (too long for one call): src/big.ts — run reviewproof diff src/big.ts\n');
  assert.match((await s.rp('status')).out, /unread:\n {2}- src\/big\.ts\n/);
  const big = await s.rp('diff', 'src/big.ts');
  assert.match(big.out, /^\+x{60}$/m);
  assert.equal(big.err, '');
  assert.match((await s.rp('status')).out, /read 3 of 3 changed files/);
});

test('a file larger than the budget prints alone when nothing else could', async () => {
  const s = setup();
  await steps(s, ['start', 'o/r#1']);
  budget(10);
  const r = await s.rp('diff');
  assert.match(r.out, /^\+TWO$/m);
  assert.doesNotMatch(r.out, /^\+c$/m);
  assert.match(r.out, /1 changed file counted as read/);
  assert.equal(r.err, 'not shown (too long for one call): src/c.ts — run reviewproof diff src/c.ts\n');
  const c = await s.rp('diff', 'src/c.ts');
  assert.match(c.out, /^\+c$/m);
  assert.equal(c.err, '');
});
