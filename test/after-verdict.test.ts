import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { addFinding } from '../src/rounds.ts';
import { LedgerStore } from '../src/store.ts';
import type { Ledger } from '../src/types.ts';
import { passTest, ready, ref, removeTmp, steps, type Review } from './e2e-helper.ts';

test.after(removeTmp);

const ledger = (s: Review) => new LedgerStore(s.home).load(ref)!;

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
    ['diff'],
    ['read', 'src/a.ts'],
    ['draft'],
  ];
  for (const argv of changes) {
    const r = await s.rp(...argv);
    assert.equal(r.code, 1, argv.join(' '));
    assert.match(r.err, /round 1 is already posted: start the next round/, argv.join(' '));
    assert.equal(r.out, '', argv.join(' '));
  }
  assert.equal(ledger(s).rounds[0]?.gates.length, 1);
});

// A command that changes the ledger while the host takes the note.
function meanwhile(s: Review, change: (l: Ledger) => void): void {
  s.host.meanwhile = () => {
    const store = new LedgerStore(s.home);
    const l = store.load(ref)!;
    change(l);
    store.save(l);
  };
}

test('a change landing while the note is posted: the post is recorded and the note named stale', async () => {
  const s = await ready();
  await steps(s, ['verdict', 'pass', '--summary', 'Clean.'], ['draft']);
  meanwhile(s, (l) => {
    const location = { file: 'src/a.ts', line: 2, sha: s.host.head };
    addFinding(l, { severity: 'blocking', source: { kind: 'rule', ref: 'R1' }, location, title: 'late' });
    delete l.rounds[0]!.verdict;
    delete l.rounds[0]!.draftAt;
  });
  const r = await s.rp('post', '--approved-by', 'tester');
  assert.equal(r.code, 1);
  const url = 'https://github.com/o/r/pull/1#issuecomment-101';
  assert.match(r.err, new RegExp(`^posted note is stale: ${url} — the ledger changed while posting$`, 'm'));
  assert.match(r.err, /blocking finding F1-1 is open/);
  assert.equal(ledger(s).rounds[0]?.post?.url, url);
  assert.equal(s.host.comments.size, 1);
});

test('a round posted while this note was posted keeps its post; the error names both notes', async () => {
  const s = await ready();
  await steps(s, ['verdict', 'not-yet', '--summary', 'Later.'], ['draft']);
  meanwhile(s, (l) => {
    l.rounds[0]!.post = { id: '1', url: 'https://first.example/1', approvedBy: 'other', at: '' };
  });
  const r = await s.rp('post', '--approved-by', 'tester');
  assert.equal(r.code, 1);
  assert.match(r.err, /posted https:\S+issuecomment-101, but recording it failed: round 1 was posted meanwhile/);
  assert.match(r.err, /do not post again/);
  assert.match(r.err, /https:\/\/first\.example\/1/);
  assert.equal(ledger(s).rounds[0]?.post?.url, 'https://first.example/1');
});
