import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { LedgerStore } from '../src/store.ts';
import { ref, removeTmp, setup, type Review } from './e2e-helper.ts';

test.after(removeTmp);

const ledger = (s: Review) => new LedgerStore(s.home).load(ref)!;
const passTest = ['gate', 'run', 'test', '--', process.execPath, '-e', '0'];

async function steps(s: Review, ...runs: string[][]): Promise<void> {
  for (const argv of runs) {
    const r = await s.rp(...argv);
    assert.equal(r.code, 0, `${argv.join(' ')}: ${r.err}`);
  }
}

// Round 1 where verdict pass is allowed: every file read, the required gate passed.
async function ready(): Promise<Review> {
  const s = setup();
  await steps(s, ['start', 'o/r#1'], ['diff'], passTest);
  return s;
}

function blockingFile(s: Review): string {
  const file = path.join(s.root, 'blocking.json');
  const finding = { severity: 'blocking', source: { kind: 'rule', ref: 'R1' }, at: 'src/a.ts:2', title: 'late' };
  fs.writeFileSync(file, JSON.stringify([finding]));
  return file;
}

test('verdict refuses when the PR head moved and records nothing', async () => {
  const s = await ready();
  s.host.head = 'f'.repeat(40);
  const r = await s.rp('verdict', 'pass', '--summary', 'Clean.');
  assert.equal(r.code, 1);
  assert.match(r.err, /head moved/);
  assert.equal(ledger(s).rounds[0]?.verdict, undefined);
});

test('a finding added after verdict pass clears the verdict, so the pass is never posted', async () => {
  const s = await ready();
  await steps(s, ['verdict', 'pass', '--summary', 'Clean.'], ['draft']);
  const add = await s.rp('add', blockingFile(s));
  assert.equal(add.code, 0, add.err);
  assert.match(add.out, /verdict cleared: run reviewproof verdict again/);
  assert.equal(ledger(s).rounds[0]?.verdict, undefined);
  assert.equal(ledger(s).rounds[0]?.draftAt, undefined);
  const post = await s.rp('post', '--approved-by', 'tester');
  assert.equal(post.code, 1);
  assert.equal(s.host.comments.size, 0);
  assert.match((await s.rp('verdict', 'pass', '--summary', 'Clean.')).err, /blocking finding F1-1 is open/);
});

test('post re-checks the recorded verdict against the ledger', async () => {
  const s = await ready();
  await steps(s, ['verdict', 'pass', '--summary', 'Clean.'], ['draft']);
  fs.writeFileSync(path.join(s.home, 'config.json'), JSON.stringify({ requiredGates: ['test', 'lint'] }));
  const r = await s.rp('post', '--approved-by', 'tester');
  assert.equal(r.code, 1);
  assert.match(r.err, /the ledger changed since the verdict: run reviewproof verdict again\n {2}- gate lint missing/);
  assert.equal(s.host.comments.size, 0);
});

test('a draft written before the verdict is not posted', async () => {
  const s = await ready();
  await steps(s, ['draft'], ['verdict', 'not-yet', '--summary', 'Later.']);
  const r = await s.rp('post', '--approved-by', 'tester');
  assert.equal(r.code, 1);
  assert.match(r.err, /the draft is older than the verdict: run reviewproof draft/);
  assert.equal(s.host.comments.size, 0);
  await steps(s, ['draft'], ['post', '--approved-by', 'tester']);
  assert.equal(s.host.comments.size, 1);
});

test('a posted round refuses every change', async () => {
  const s = await ready();
  await steps(s, ['verdict', 'not-yet', '--summary', 'Later.'], ['draft'], ['post', '--approved-by', 'tester']);
  const changes = [
    ['add', blockingFile(s)],
    ['mark', 'F1-1', 'verified'],
    passTest,
    ['gate', 'skip', 'lint', '--reason', 'none'],
    ['skip', 'src/c.ts', '--reason', 'generated'],
    ['draft'],
  ];
  for (const argv of changes) {
    const r = await s.rp(...argv);
    assert.equal(r.code, 1, argv.join(' '));
    assert.match(r.err, /round 1 is already posted: start the next round/, argv.join(' '));
  }
  assert.equal(ledger(s).rounds[0]?.gates.length, 1);
});
