import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { compareFindings, headToReview, humanComments, missesText } from '../src/backtest.ts';
import type { ReviewHistory } from '../src/hosts.ts';
import { removeTmp, setup } from './e2e-helper.ts';

after(removeTmp);

const URL = 'https://github.com/o/r/pull/1';

function history(head: string, base: string): ReviewHistory {
  return {
    url: URL,
    title: 'Add c',
    merged: true,
    author: 'me',
    head,
    base,
    reviews: [
      { by: 'ci-helper[bot]', bot: true, body: 'Coverage 90%', commit: base, at: '2026-01-01T00:00:00Z', url: `${URL}#pullrequestreview-9` },
      { by: 'alice', bot: false, body: 'Please handle empty lists.', commit: head, at: '2026-01-02T00:00:00Z', url: `${URL}#pullrequestreview-1` },
      { by: 'bob', bot: false, body: '', commit: head, at: '2026-01-03T00:00:00Z', url: `${URL}#pullrequestreview-2` },
    ],
    comments: [
      { by: 'alice', bot: false, file: 'src/a.ts', line: 2, body: 'TWO should be lower case', commit: head, at: '2026-01-02T00:00:00Z', url: `${URL}#discussion_r1`, reply: false },
      { by: 'alice', bot: false, file: 'src/c.ts', line: 1, body: 'c needs a test\nand a doc line', commit: head, at: '2026-01-02T00:00:01Z', url: `${URL}#discussion_r2`, reply: false },
      { by: 'me', bot: false, file: 'src/a.ts', line: 2, body: 'done', commit: head, at: '2026-01-02T01:00:00Z', url: `${URL}#discussion_r3`, reply: true },
      { by: 'me', bot: false, file: 'src/a.ts', line: 1, body: 'a note to myself', commit: head, at: '2026-01-02T02:00:00Z', url: `${URL}#discussion_r4`, reply: false },
      { by: 'lint[bot]', bot: true, file: 'src/a.ts', line: 3, body: 'lint', commit: head, at: '2026-01-02T03:00:00Z', url: `${URL}#discussion_r5`, reply: false },
    ],
  };
}

const finding = (at: string, title = 't') => ({
  severity: 'major' as const,
  source: { kind: 'rule' as const, ref: 'R1' },
  location: { file: at.split(':')[0] as string, line: Number(at.split(':')[1]), sha: 'h' },
  title,
});

test('the head to review is the commit of the first human review, else the merged head', () => {
  const h = history('h2', 'b');
  h.comments[0]!.commit = 'h1';
  h.comments[0]!.at = '2026-01-01T12:00:00Z';
  assert.deepEqual(headToReview(h), { sha: 'h1', why: 'the head of the first human review (alice, 2026-01-01)' });
  const none = { ...h, reviews: h.reviews.filter((r) => r.bot), comments: [] };
  assert.deepEqual(headToReview(none), { sha: 'h2', why: 'no human review: the merged head' });
});

test('human comments leave out the author, bots and replies', () => {
  const c = humanComments(history('h', 'b'));
  assert.deepEqual(c.lines.map((x) => x.url.slice(-2)), ['r1', 'r2']);
  assert.deepEqual(c.bodies.map((x) => x.by), ['alice']);
});

test('a finding near a comment catches it; the rest are missed or extra', () => {
  const c = humanComments(history('h', 'b'));
  const r = compareFindings([finding('src/a.ts:4'), finding('src/b.ts:1')], c.lines, 3);
  assert.deepEqual(r.caught.map((x) => x.comment.url.slice(-2)), ['r1']);
  assert.deepEqual(r.missed.map((x) => x.url.slice(-2)), ['r2']);
  assert.deepEqual(r.extra.map((f) => f.location.file), ['src/b.ts']);
  const far = compareFindings([finding('src/a.ts:6')], c.lines, 3);
  assert.equal(far.caught.length, 0);
});

test('a comment on the whole file is caught by any finding in that file', () => {
  const lines = [{ ...humanComments(history('h', 'b')).lines[1]!, line: null }];
  assert.equal(compareFindings([finding('src/c.ts:40')], lines, 3).caught.length, 1);
});

test('missesText lists each new miss once, with its file, line, person and link', () => {
  const c = humanComments(history('h1234567890', 'b'));
  const text = missesText('o/r#1', 'h1234567890', c.lines, '', new Date('2026-11-16T00:00:00Z'));
  assert.match(text, /^## o\/r#1 \(backtest 2026-11-16, head h123456\)\n\n- src\/a\.ts:2 \(alice\): TWO should be lower case \(https:\/\/github\.com\/o\/r\/pull\/1#discussion_r1\)\n- src\/c\.ts:1 \(alice\): c needs a test and a doc line/);
  assert.equal(missesText('o/r#1', 'h1234567890', c.lines, text, new Date()), '');
});

test('backtest without findings names the head to review and shows no comment', async () => {
  const s = setup();
  s.host.hist = history(s.host.head, s.host.base);
  const r = await s.rp('backtest', 'o/r#1');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, new RegExp(`review o/r#1 at ${s.host.head.slice(0, 7)}: the head of the first human review`));
  assert.match(r.out, /--findings/);
  assert.doesNotMatch(r.out, /lower case|empty lists/);
});

test('backtest with findings reports caught, missed, extra and unplaced, and appends misses once', async () => {
  const s = setup();
  s.host.hist = history(s.host.head, s.host.base);
  const file = path.join(s.checkout, 'findings.json');
  fs.writeFileSync(file, JSON.stringify([
    { severity: 'major', source: { kind: 'rule', ref: 'R1' }, at: 'src/a.ts:3', title: 'Upper case TWO' },
    { severity: 'minor', source: { kind: 'other', ref: 'style' }, at: 'src/b.ts:1', title: 'Rename b' },
  ]));
  const r = await s.rp('backtest', 'o/r#1', '--findings', 'findings.json');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /caught 1 of 2 line comments \(50%\)/);
  assert.match(r.out, /missed:\n {2}- src\/c\.ts:1 alice: c needs a test/);
  assert.match(r.out, /extra \(no human comment near\):\n {2}- src\/b\.ts:1 minor: Rename b/);
  assert.match(r.out, /not placed on a line \(judge by hand\):\n {2}- alice: Please handle empty lists\./);
  const misses = path.join(s.home, 'github.com', 'o', 'r', 'misses.md');
  assert.match(r.out, /1 miss added to .*misses\.md/);
  assert.match(fs.readFileSync(misses, 'utf8'), /src\/c\.ts:1 \(alice\): c needs a test/);
  const again = await s.rp('backtest', 'o/r#1', '--findings', 'findings.json');
  assert.match(again.out, /no new miss for .*misses\.md/);
  assert.equal(fs.readFileSync(misses, 'utf8').match(/discussion_r2/g)?.length, 1);
});

test('backtest writes misses to --misses when given', async () => {
  const s = setup();
  s.host.hist = history(s.host.head, s.host.base);
  fs.writeFileSync(path.join(s.checkout, 'f.json'), '[]');
  const r = await s.rp('backtest', 'o/r#1', '--findings', 'f.json', '--misses', 'notes/misses.md');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /caught 0 of 2 line comments \(0%\)/);
  assert.match(fs.readFileSync(path.join(s.checkout, 'notes', 'misses.md'), 'utf8'), /discussion_r1[\s\S]*discussion_r2/);
});

test('backtest refuses an open pull request, a host without history, a head not in the checkout and a bad finding', async () => {
  const s = setup();
  s.host.hist = { ...history(s.host.head, s.host.base), merged: false };
  assert.match((await s.rp('backtest', 'o/r#1')).err, /o\/r#1 is not merged: backtest replays merged pull requests/);
  s.host.hist = history('0123456789abcdef0123456789abcdef01234567', s.host.base);
  fs.writeFileSync(path.join(s.checkout, 'f.json'), '[]');
  assert.match((await s.rp('backtest', 'o/r#1', '--findings', 'f.json')).err, /commit 0123456 is not in this checkout: run git fetch origin 0123456789abcdef0123456789abcdef01234567/);
  s.host.hist = history(s.host.head, s.host.base);
  fs.writeFileSync(path.join(s.checkout, 'f.json'), JSON.stringify([{ severity: 'major', source: { kind: 'rule', ref: 'R' }, at: 'src/zz.ts:1', title: 'x' }]));
  const bad = await s.rp('backtest', 'o/r#1', '--findings', 'f.json');
  assert.equal(bad.code, 1);
  assert.match(bad.err, /finding 1: at: file src\/zz\.ts does not exist at the round head/);
  (s.host as { history?: unknown }).history = undefined;
  assert.match((await s.rp('backtest', 'o/r#1')).err, /backtest reads review history from GitHub only/);
});
