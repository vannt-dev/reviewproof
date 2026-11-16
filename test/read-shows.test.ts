import { test } from 'node:test';
import assert from 'node:assert/strict';
import { git, removeTmp, setup, steps } from './e2e-helper.ts';

// Each test file runs in its own process, so the budget set here reaches no other file.
const budget = (chars: number): void => void (process.env.REVIEWPROOF_DIFF_BUDGET = String(chars));
test.after(removeTmp);

test('read prints the file at the round head with line numbers before it counts it', async () => {
  const s = setup();
  await steps(s, ['start', 'o/r#1']);
  const head = s.host.head.slice(0, 7);
  const r = await s.rp('read', 'src/a.ts');
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, `src/a.ts at ${head}, lines 1-3 of 3\n1\tone\n2\tTWO\n3\tthree\nread src/a.ts\n`);
  const part = await s.rp('read', 'src/a.ts', '--lines', '2-9');
  assert.equal(part.out, `src/a.ts at ${head}, lines 2-3 of 3\n2\tTWO\n3\tthree\nread src/a.ts lines 2-3\n`);
});

test('read of a deleted file prints its old content', async () => {
  const s = setup();
  git(s.checkout, 'rm', '-q', 'src/b.ts');
  s.push('src/a.ts', 'one\nTWO\nthree\nfour\n');
  await steps(s, ['start', 'o/r#1']);
  const from = git(s.checkout, 'rev-parse', 'origin/main').slice(0, 7);
  const r = await s.rp('read', 'src/b.ts');
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, `src/b.ts (deleted) at ${from}, lines 1-1 of 1\n1\tb\nread src/b.ts\n`);
  assert.doesNotMatch((await s.rp('status')).out, /unread:[^]*src\/b\.ts/);
});

test('read refuses lines past the end and a part too large for one call, and counts nothing then', async () => {
  const s = setup();
  s.push('src/big.ts', `${'x'.repeat(60)}\n`.repeat(40));
  await steps(s, ['start', 'o/r#1']);
  budget(1000);
  const past = await s.rp('read', 'src/a.ts', '--lines', '5-6');
  assert.equal(past.code, 1);
  assert.match(past.err, /--lines 5-6: src\/a\.ts has 3 lines/);
  const whole = await s.rp('read', 'src/big.ts');
  assert.equal(whole.code, 1);
  assert.match(whole.err, /src\/big\.ts lines 1-40 are larger than one call can show: read fewer with --lines a-b/);
  assert.doesNotMatch(whole.out, /xxx/);
  assert.match((await s.rp('status')).out, /unread:[^]*src\/big\.ts/);
  for (const lines of ['1-13', '14-26', '27-40']) {
    const r = await s.rp('read', 'src/big.ts', '--lines', lines);
    assert.equal(r.code, 0, `${lines}: ${r.err}`);
    assert.match(r.out, /^\d+\tx{60}$/m);
  }
  assert.doesNotMatch((await s.rp('status')).out, /src\/big\.ts/);
});

test('read of a binary file says so and counts it', async () => {
  const s = setup();
  s.push('logo.png', '\u0000\u0001PNG\u0000binary');
  await steps(s, ['start', 'o/r#1']);
  const r = await s.rp('read', 'logo.png');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^logo\.png at [0-9a-f]{7}: a binary file, nothing to print\nread logo\.png\n$/);
});
