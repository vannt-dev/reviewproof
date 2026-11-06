import { test } from 'node:test';
import assert from 'node:assert/strict';
import { removeTmp, setup, steps } from './e2e-helper.ts';

// Each test file runs in its own process, so the budget set here reaches no other file.
const budget = (chars: number): void => void (process.env.REVIEWPROOF_DIFF_BUDGET = String(chars));
const tooLarge = (file: string): string =>
  `${file}: its diff is larger than one call can show; open it with Read in parts (each part is recorded) ` +
  `or record what you read with reviewproof read ${file} --lines a-b\n`;
test.after(removeTmp);

test('a file larger than the budget is never printed or counted, even asked for alone', async () => {
  const s = setup();
  s.push('src/big.ts', `${'x'.repeat(60)}\n`.repeat(40));
  await steps(s, ['start', 'o/r#1']);
  budget(1000);
  const r = await s.rp('diff');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^\+TWO$[^]*^\+c$/m);
  assert.doesNotMatch(r.out, /xxx/);
  assert.match(r.out, /2 changed files counted as read/);
  assert.equal(r.err, tooLarge('src/big.ts'));
  const alone = await s.rp('diff', 'src/big.ts');
  assert.doesNotMatch(alone.out, /xxx/);
  assert.match(alone.out, /0 changed files counted as read/);
  assert.equal(alone.err, tooLarge('src/big.ts'));
  assert.match((await s.rp('status')).out, /unread:\n {2}- src\/big\.ts\n/);
  assert.equal((await s.rp('read', 'src/big.ts', '--lines', '1-40')).code, 0);
  assert.match((await s.rp('status')).out, /read 3 of 3 changed files/);
});

test('files that fit only in a later call are listed apart from files too large for any call', async () => {
  const s = setup();
  s.push('src/big.ts', `${'x'.repeat(60)}\n`.repeat(40));
  await steps(s, ['start', 'o/r#1']);
  budget(1000);
  const sizes = (await s.rp('diff', 'src/a.ts')).out.length;
  budget(sizes + 20); // room for one small file, not for both, never for big.ts
  const r = await s.rp('diff');
  assert.match(r.out, /^\+TWO$/m);
  assert.doesNotMatch(r.out, /^\+c$/m);
  assert.match(r.out, /1 changed file counted as read/);
  assert.equal(
    r.err,
    `not shown (too long for one call): src/c.ts — run reviewproof diff src/c.ts\n${tooLarge('src/big.ts')}`,
  );
  const c = await s.rp('diff', 'src/c.ts');
  assert.match(c.out, /^\+c$/m);
  assert.equal(c.err, '');
});

test('nothing printed when every file is too large', async () => {
  const s = setup();
  await steps(s, ['start', 'o/r#1']);
  budget(10);
  const r = await s.rp('diff');
  assert.doesNotMatch(r.out, /^\+/m);
  assert.match(r.out, /0 changed files counted as read/);
  assert.equal(r.err, tooLarge('src/a.ts') + tooLarge('src/c.ts'));
});
