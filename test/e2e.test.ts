import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { LedgerStore } from '../src/store.ts';
import { git, ref, removeTmp, setup } from './e2e-helper.ts';

test.after(removeTmp);

const passTest = ['gate', 'run', 'test', '--', process.execPath, '-e', '0'];

test('a full two-round review: refused, gated, drafted, posted, then verified', async () => {
  const s = setup();
  const { rp, host } = s;
  const store = new LedgerStore(s.home);
  const ledger = () => store.load(ref)!;

  // Round 1 on the PR head: a.ts changed, c.ts added.
  let r = await rp('start', 'o/r#1');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /round 1/);
  assert.match(r.out, /2 changed files/);
  assert.equal(ledger().rounds[0]?.from, host.base);

  const findings = path.join(s.root, 'findings.json');
  const finding = { severity: 'blocking', source: { kind: 'rule', ref: 'R1' }, at: 'src/a.ts:2', title: 'TWO' };
  fs.writeFileSync(findings, JSON.stringify([finding]));
  r = await rp('add', findings);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /F1-1/);
  assert.equal(ledger().findings[0]?.location.sha, host.head);

  r = await rp('verdict', 'pass', '--summary', 'Ready.');
  assert.equal(r.code, 1);
  assert.match(r.err, /blocking finding F1-1 is open/);
  assert.match(r.err, /file src\/a\.ts unread/);
  assert.match(r.err, /gate test missing/);

  r = await rp('diff');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^\+TWO$/m);
  r = await rp(...passTest);
  assert.equal(r.code, 0, r.err);
  r = await rp('verdict', 'not-yet', '--summary', 'One blocking finding.');
  assert.equal(r.code, 0, r.err);
  r = await rp('draft');
  assert.equal(r.code, 0, r.err);
  const draft = path.join(store.dirFor(ref), 'drafts', 'round-1.md');
  assert.match(fs.readFileSync(draft, 'utf8'), /Verdict: not-yet/);

  // The PR moved after the verdict: nothing is posted.
  const reviewed = host.head;
  host.head = 'f'.repeat(40);
  r = await rp('post', '--approved-by', 'tester');
  assert.equal(r.code, 1);
  assert.match(r.err, /head moved/);
  assert.equal(host.comments.size, 0);
  host.head = reviewed;

  r = await rp('post', '--approved-by', 'tester');
  assert.equal(r.code, 0, r.err);
  assert.equal(host.comments.get('101'), fs.readFileSync(draft, 'utf8'));
  const post = ledger().rounds[0]?.post;
  assert.deepEqual([post?.id, post?.approvedBy], ['101', 'tester']);

  // Round 2: the author fixes line 2.
  s.push('src/a.ts', 'one\ntwo\nthree\n');
  r = await rp('start', 'o/r#1');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /round 2/);
  assert.equal(ledger().rounds[1]?.from, reviewed);
  assert.equal((await rp('diff')).code, 0);
  assert.equal((await rp(...passTest)).code, 0);

  r = await rp('verdict', 'pass', '--summary', 'Fixed.');
  assert.equal(r.code, 1);
  assert.match(r.err, /finding F1-1 carried without a status this round/);
  r = await rp('mark', 'F1-1', 'verified');
  assert.equal(r.code, 0, r.err);
  r = await rp('verdict', 'pass', '--summary', 'The blocking finding is fixed.');
  assert.equal(r.code, 0, r.err);

  // One commit per verdict and per post; the refused attempts left no trace.
  assert.deepEqual(git(s.home, 'log', '--format=%s').split('\n'), [
    'o/r#1 round 2: pass, 0 open',
    'o/r#1 round 1: posted',
    'o/r#1 round 1: not-yet, 1 open',
  ]);
});
