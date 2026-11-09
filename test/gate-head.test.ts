import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { gateState } from '../src/gates.ts';
import { LedgerStore } from '../src/store.ts';
import type { Round } from '../src/types.ts';
import { git, passTest, ref, removeTmp, setup, steps } from './e2e-helper.ts';

test.after(removeTmp);

const failTest = ['gate', 'run', 'test', '--', process.execPath, '-e', 'process.exit(1)'];

test('a gate run on another commit does not count: the verdict asks for a run at the head', async () => {
  const s = setup();
  await steps(s, ['start', 'o/r#1'], ['diff'], passTest);
  const head = s.host.head;
  // The reviewer commits something locally: the checkout is no longer the PR head.
  fs.writeFileSync(path.join(s.checkout, 'local.txt'), 'x\n');
  git(s.checkout, 'add', 'local.txt');
  git(s.checkout, 'commit', '-q', '-m', 'local');
  const moved = git(s.checkout, 'rev-parse', 'HEAD');
  let r = await s.rp(...passTest);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, new RegExp(`checkout is at ${moved.slice(0, 7)}, not at the round's head ${head.slice(0, 7)}`));
  r = await s.rp('verdict', 'not-yet', '--summary', 'Checked.');
  assert.equal(r.code, 1);
  assert.match(r.err, new RegExp(`gate test ran at ${moved.slice(0, 7)}, not at the round's head ${head.slice(0, 7)}: run it again`));
  // Back at the head, a new run counts.
  git(s.checkout, 'reset', '-q', '--hard', head);
  await steps(s, passTest, ['verdict', 'not-yet', '--summary', 'Checked.']);
});

test('a gate run with uncommitted changes does not count', async () => {
  const s = setup();
  await steps(s, ['start', 'o/r#1'], ['diff']);
  fs.appendFileSync(path.join(s.checkout, 'src', 'b.ts'), 'edited\n');
  let r = await s.rp(...passTest);
  assert.match(r.out, /uncommitted changes in the checkout: this attempt does not count/);
  r = await s.rp('verdict', 'not-yet', '--summary', 'Checked.');
  assert.equal(r.code, 1);
  assert.match(r.err, /gate test ran with uncommitted changes: run it again on a clean checkout/);
  r = await s.rp('status');
  assert.match(r.out, /gate test ran with uncommitted changes/);
  git(s.checkout, 'checkout', '--', 'src/b.ts');
  await steps(s, passTest, ['verdict', 'not-yet', '--summary', 'Checked.']);
});

test('the draft shows where the last run ran and which attempts failed before it', async () => {
  const s = setup();
  await steps(s, ['start', 'o/r#1'], ['diff']);
  await s.rp(...failTest);
  await steps(s, passTest, ['verdict', 'not-yet', '--summary', 'Checked.'], ['draft']);
  const draft = fs.readFileSync(path.join(new LedgerStore(s.home).dirFor(ref), 'drafts', 'round-1.md'), 'utf8');
  assert.match(draft, new RegExp(`- test: pass at ${s.host.head.slice(0, 7)}, 2 attempts \\(attempt 1 failed\\)`));
});

test('an attempt from before heads were recorded still counts', () => {
  const round: Round = {
    n: 1, head: 'h', base: 'b', from: 'b', startedAt: '', reads: [], skips: [],
    gates: [{ name: 'test', attempt: 1, argv: ['x'], exitCode: 0, result: 'pass', at: '' }],
  };
  assert.deepEqual(gateState(round, ['test']), { missing: [], failed: [], notChecked: [], stale: [] });
});
