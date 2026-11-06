import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { LedgerStore } from '../src/store.ts';
import { ref, removeTmp, setup, type Review } from './e2e-helper.ts';

test.after(removeTmp);

const ledger = (s: Review) => new LedgerStore(s.home).load(ref)!;

function findingsFile(s: Review, ...at: string[]): string {
  const file = path.join(s.root, 'findings.json');
  const items = at.map((a) => ({ severity: 'major', source: { kind: 'rule', ref: 'R1' }, at: a, title: 't' }));
  fs.writeFileSync(file, JSON.stringify(items));
  return file;
}

test('--help lists every command on one line each; unknown commands and options fail', async () => {
  const { rp } = setup();
  const r = await rp('--help');
  assert.equal(r.code, 0);
  for (const name of ['start', 'add', 'mark', 'status', 'gate run', 'gate skip', 'diff', 'read', 'skip']) {
    assert.match(r.out, new RegExp(`^  ${name} `, 'm'), name);
  }
  for (const name of ['verdict', 'draft', 'post', 'hook']) assert.match(r.out, new RegExp(`^  ${name}\\b`, 'm'));
  assert.equal((await rp()).code, 1);
  assert.match((await rp('frob')).err, /unknown command "frob"/);
  assert.match((await rp('constructor')).err, /unknown command "constructor"/);
  const bad = await rp('start', 'o/r#1', '--bogus');
  assert.equal(bad.code, 1);
  assert.match(bad.err, /Unknown option '--bogus'/);
});

test('commands need a started review; start needs the checkout on the PR head', async () => {
  const s = setup();
  const none = await s.rp('status');
  assert.equal(none.code, 1);
  assert.match(none.err, /no active review in .+: run reviewproof start <pr>/);
  const head = s.host.head;
  s.host.head = s.host.base;
  const off = await s.rp('start', 'o/r#1');
  assert.equal(off.code, 1);
  assert.match(off.err, new RegExp(`git switch --detach ${s.host.base}`));
  s.host.head = head;
  assert.equal((await s.rp('start', 'o/r#1')).code, 0);
  assert.match((await s.rp('start', 'o/r#1')).err, /unchanged since round 1/);
});

test('add is all or nothing, with line counts taken at the head', async () => {
  const s = setup();
  await s.rp('start', 'o/r#1');
  const bad = await s.rp('add', findingsFile(s, 'src/a.ts:3', 'src/a.ts:4', 'src/zz.ts:1'));
  assert.equal(bad.code, 1);
  assert.match(bad.err, /finding 2: at: line 4 is past the end of src\/a\.ts \(3 lines\)/);
  assert.match(bad.err, /finding 3: at: file src\/zz\.ts does not exist at the round head/);
  assert.equal(ledger(s).findings.length, 0);
  const good = await s.rp('add', findingsFile(s, 'src/a.ts:3'));
  assert.equal(good.code, 0, good.err);
  assert.match(good.out, /added F1-1/);
});

test('read, skip and gate skip show in status and in what blocks verdict pass', async () => {
  const s = setup();
  await s.rp('start', 'o/r#1');
  assert.match((await s.rp('read', 'src/b.ts')).err, /not changed in round 1: src\/b\.ts/);
  assert.match((await s.rp('read', 'src/a.ts', '--lines', '3-1')).err, /--lines "3-1"/);
  assert.equal((await s.rp('read', 'src/a.ts', '--lines', '1-1')).code, 0);
  assert.equal((await s.rp('skip', 'src/c.ts', '--reason', 'generated')).code, 0);
  assert.equal((await s.rp('gate', 'skip', 'test', '--reason', 'no tests')).code, 0);
  const r = await s.rp('status');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /gates: test not-checked \(1 attempt\)/);
  assert.match(r.out, /partly read:\n {2}- src\/a\.ts/);
  assert.match(r.out, /skipped:\n {2}- src\/c\.ts \(generated\)/);
  assert.match(r.out, /verdict pass is blocked by:\n {2}- gate test not checked: no tests\n {2}- file src\/a\.ts only partly read\n$/);
  await s.rp('read', 'src/a.ts', '--lines', '2-3');
  assert.match((await s.rp('status')).out, /read 1 of 1 changed file\n/);
});

test('a failing gate exits 1 and keeps the attempt', async () => {
  const s = setup();
  await s.rp('start', 'o/r#1');
  const r = await s.rp('gate', 'run', 'test', '--', process.execPath, '-e', 'process.exit(3)');
  assert.equal(r.code, 1);
  assert.match(r.out, /gate test attempt 1: fail \(exit code 3\)/);
  assert.equal(ledger(s).rounds[0]?.gates[0]?.exitCode, 3);
});

test('mark --at widens a short head prefix to the full head', async () => {
  const s = setup();
  await s.rp('start', 'o/r#1');
  await s.rp('add', findingsFile(s, 'src/a.ts:2'));
  const head = s.push('src/a.ts', 'one\nTWO\nthree\nfour\n');
  await s.rp('start', 'o/r#1');
  const vague = await s.rp('mark', 'F1-1', 'withdrawn', '--evidence', 'the author disagrees');
  assert.match(vague.err, /withdrawn needs evidence/);
  const r = await s.rp('mark', 'F1-1', 'reopened', '--at', `src/a.ts:4@${head.slice(0, 7)}`);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(ledger(s).findings[0]?.history.at(-1)?.location, { file: 'src/a.ts', line: 4, sha: head });
});

test('post needs a verdict and a draft; a note changed by the host is kept with a warning', async () => {
  const s = setup();
  await s.rp('start', 'o/r#1');
  await s.rp('diff');
  await s.rp('gate', 'run', 'test', '--', process.execPath, '-e', '0');
  assert.match((await s.rp('post')).err, /--approved-by/);
  assert.match((await s.rp('post', '--approved-by', 'tester')).err, /no verdict: run reviewproof verdict/);
  await s.rp('verdict', 'pass', '--summary', 'Clean.');
  assert.match((await s.rp('post', '--approved-by', 'tester')).err, /no draft: run reviewproof draft/);
  await s.rp('draft');
  s.host.altered = '## Review round 1\n\nedited by the host\n';
  const r = await s.rp('post', '--approved-by', 'tester');
  assert.equal(r.code, 1);
  assert.match(r.err, /differs from the draft at line 1:\n {2}draft: {2}## Review round 1 \(head \w+\)\n {2}posted: ## Review round 1$/m);
  assert.equal(ledger(s).rounds[0]?.post?.id, '101');
  assert.match((await s.rp('post', '--approved-by', 'tester')).err, /already posted/);
});
