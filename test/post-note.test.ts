import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { LedgerStore } from '../src/store.ts';
import { passTest, ready, ref, removeTmp, steps, type Review } from './e2e-helper.ts';

test.after(removeTmp);

const ledger = (s: Review) => new LedgerStore(s.home).load(ref)!;

let files = 0;
function findings(s: Review, ...list: { at: string; title: string; body?: string }[]): string {
  const file = path.join(s.root, `findings-${++files}.json`);
  const rows = list.map((f) => ({ severity: 'major', source: { kind: 'rule', ref: 'R1' }, ...f }));
  fs.writeFileSync(file, JSON.stringify(rows));
  return file;
}

/** Round 1 posted with one open finding on src/a.ts:2, then round 2 started on a new head. */
async function secondRound(): Promise<Review> {
  const s = await ready();
  await steps(
    s,
    ['add', findings(s, { at: 'src/a.ts:2', title: 'TWO is loud', body: 'Callers expect lower case.' })],
    ['verdict', 'not-yet', '--summary', 'One finding open.'],
    ['draft'],
    ['post', '--approved-by', 'tester'],
  );
  s.push('src/a.ts', 'one\nTWO\nthree\nfour\n');
  await steps(s, ['start', 'o/r#1'], ['diff'], passTest);
  return s;
}

test('a later round edits the note it posted before: one comment per pull request', async () => {
  const s = await secondRound();
  await steps(s, ['mark', 'F1-1', 'verified'], ['verdict', 'pass', '--summary', 'Fixed.'], ['draft']);
  const r = await s.rp('post', '--approved-by', 'tester');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /posted https:\S+issuecomment-101 \(the earlier note, edited\)/);
  assert.equal(s.host.comments.size, 1);
  assert.match(s.host.comments.get('101') ?? '', /## Review round 2/);
  assert.deepEqual([ledger(s).rounds[1]?.post?.id, ledger(s).rounds[1]?.post?.edited], ['101', true]);
  // The ledger keeps round 1's note as it was posted.
  assert.equal(ledger(s).rounds[0]?.post?.edited, undefined);
  assert.match(fs.readFileSync(new LedgerStore(s.home).draftFile(ref, 1), 'utf8'), /## Review round 1/);
});

test('a deleted earlier note gets a new one', async () => {
  const s = await secondRound();
  await steps(s, ['mark', 'F1-1', 'verified'], ['verdict', 'pass', '--summary', 'Fixed.'], ['draft']);
  s.host.comments.delete('101');
  const r = await s.rp('post', '--approved-by', 'tester');
  assert.equal(r.code, 0, r.err);
  assert.match(r.err, /the earlier note \S+issuecomment-101 is gone: posting a new one/);
  assert.deepEqual([...s.host.comments.keys()], ['102']);
  assert.equal(ledger(s).rounds[1]?.post?.edited, undefined);
});

test('post --new-comment posts a new note and leaves the earlier one as it was', async () => {
  const s = await secondRound();
  await steps(s, ['mark', 'F1-1', 'verified'], ['verdict', 'pass', '--summary', 'Fixed.'], ['draft']);
  const r = await s.rp('post', '--new-comment', '--approved-by', 'tester');
  assert.equal(r.code, 0, r.err);
  assert.equal(s.host.comments.size, 2);
  assert.match(s.host.comments.get('101') ?? '', /## Review round 1/);
  assert.match(s.host.comments.get('102') ?? '', /## Review round 2/);
});

test('a reopened finding keeps its reasoning in the note that replaces its round', async () => {
  const s = await secondRound();
  await steps(s, ['mark', 'F1-1', 'reopened', '--at', 'src/a.ts:2'], ['verdict', 'not-yet', '--summary', 'Still open.']);
  const r = await s.rp('draft');
  assert.equal(r.code, 0, r.err);
  const details = `\\*\\*F1-1 TWO is loud\\*\\* \\(src/a\\.ts:2@${s.host.head}\\)\\n\\nCallers expect lower case\\.`;
  assert.match(r.out, new RegExp(details));
});

test('post --inline: open findings on added lines go on their lines, the rest stay in the note', async () => {
  const s = await ready();
  const file = findings(
    s,
    { at: 'src/a.ts:2', title: 'TWO is loud', body: 'Callers expect lower case.' },
    { at: 'src/b.ts:1', title: 'b is unchanged' },
    { at: 'src/a.ts:1', title: 'context only' },
  );
  await steps(s, ['add', file], ['verdict', 'not-yet', '--summary', 'Open.'], ['draft']);
  const r = await s.rp('post', '--inline', '--approved-by', 'tester');
  assert.equal(r.code, 0, r.err);
  assert.equal(s.host.comments.size, 1);
  assert.deepEqual(s.host.inlines, [
    {
      finding: 'F1-1',
      file: 'src/a.ts',
      line: 2,
      body: '**F1-1 TWO is loud** (major, rule: R1)\n\nCallers expect lower case.',
      note: 'https://github.com/o/r/pull/1#issuecomment-101',
    },
  ]);
  assert.match(r.out, /F1-2 src\/b\.ts:1: not an added line of the diff, in the note only/);
  assert.match(r.out, /F1-3 src\/a\.ts:1: not an added line of the diff, in the note only/);
  // The note itself still holds every finding.
  assert.match(s.host.comments.get('101') ?? '', /F1-1[\s\S]*F1-2[\s\S]*F1-3/);
  assert.deepEqual(ledger(s).rounds[0]?.post?.inline?.map((p) => p.finding), ['F1-1']);
});

test('post --inline after a failure part way adds only the missing comments, never a second note', async () => {
  const s = await ready();
  const file = findings(s, { at: 'src/a.ts:2', title: 'one' }, { at: 'src/c.ts:1', title: 'two' });
  await steps(s, ['add', file], ['verdict', 'not-yet', '--summary', 'Open.'], ['draft']);
  s.host.inlineFailAfter = 1;
  const r = await s.rp('post', '--inline', '--approved-by', 'tester');
  assert.equal(r.code, 1);
  assert.match(r.err, /inline comments failed after 1 of 2: HTTP 502/);
  assert.match(r.err, /run reviewproof post --inline again/);
  assert.deepEqual(ledger(s).rounds[0]?.post?.inline?.map((p) => p.finding), ['F1-1']);

  s.host.inlineFailAfter = null;
  const again = await s.rp('post', '--inline', '--approved-by', 'tester');
  assert.equal(again.code, 0, again.err);
  assert.equal(s.host.comments.size, 1);
  assert.deepEqual(s.host.inlines.map((c) => c.finding), ['F1-1', 'F1-2']);
  assert.deepEqual(ledger(s).rounds[0]?.post?.inline?.map((p) => p.finding), ['F1-1', 'F1-2']);

  const third = await s.rp('post', '--inline', '--approved-by', 'tester');
  assert.equal(third.code, 1);
  assert.match(third.err, /round 1 is already posted/);
  assert.equal(s.host.inlines.length, 2);
});

test('a reopened finding goes inline at its new line in the next round', async () => {
  const s = await secondRound();
  await steps(
    s,
    ['mark', 'F1-1', 'reopened', '--at', 'src/a.ts:2'],
    ['verdict', 'not-yet', '--summary', 'Still open.'],
    ['draft'],
    ['post', '--inline', '--approved-by', 'tester'],
  );
  assert.equal(s.host.comments.size, 1);
  assert.deepEqual(s.host.inlines.map((c) => [c.finding, c.file, c.line]), [['F1-1', 'src/a.ts', 2]]);
  assert.match(s.host.inlines[0]?.body ?? '', /\(major, rule: R1, reopened\)/);
});

test('post --inline still refuses inside Claude Code', async () => {
  const s = await ready();
  const file = findings(s, { at: 'src/a.ts:2', title: 'x' });
  await steps(s, ['add', file], ['verdict', 'not-yet', '--summary', 'Open.'], ['draft']);
  process.env.CLAUDECODE = '1';
  try {
    const r = await s.rp('post', '--inline', '--approved-by', 'tester');
    assert.equal(r.code, 1);
    assert.match(r.err, /post from your own terminal, not from the agent/);
  } finally {
    delete process.env.CLAUDECODE;
  }
  assert.equal(s.host.comments.size, 0);
  assert.equal(s.host.inlines.length, 0);
});
