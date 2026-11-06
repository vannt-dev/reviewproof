import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { changedFiles, parseDiff } from '../src/diff.ts';
import type { ChangedFile } from '../src/diff.ts';
import { coverage } from '../src/coverage.ts';
import type { ReadMark } from '../src/types.ts';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-cov-'));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

const env = {
  ...process.env,
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.com',
};
const git = (...args: string[]) =>
  execFileSync('git', args, { cwd: root, env, encoding: 'utf8', stdio: 'pipe' }).trim();
const lines = (n: number, tag = 'l') =>
  Array.from({ length: n }, (_, i) => `${tag}${i + 1}`).join('\n') + '\n';
const put = (f: string, data: string | Buffer) => fs.writeFileSync(path.join(root, f), data);

git('init', '-q');
put('a.ts', lines(10));
put('c.ts', lines(10, 'c'));
put('e.ts', lines(3, 'e'));
git('add', '-A');
git('commit', '-q', '-m', 'one');
const from = git('rev-parse', 'HEAD');
put('a.ts', lines(10).replace('l3\nl4\n', 'x3\nx4\n'));
put('b.ts', lines(3, 'b'));
git('mv', 'c.ts', 'd.ts');
put('d.ts', lines(10, 'c').replace('c5\n', 'z5\n'));
git('rm', '-q', 'e.ts');
put('img.png', Buffer.from([137, 80, 0, 1, 2, 3]));
put('package-lock.json', '{}\n');
git('add', '-A');
git('commit', '-q', '-m', 'two');
const to = git('rev-parse', 'HEAD');

const changed = changedFiles(root, from, to);
const find = (f: string) => changed.find((c) => c.file === f);
const mark = (file: string, extra: Partial<ReadMark> = {}): ReadMark => ({
  file,
  via: 'hook',
  at: '2026-11-06T00:00:00Z',
  ...extra,
});
const cov = (reads: ReadMark[], skips: { file: string; reason: string }[] = [], globs: string[] = []) =>
  coverage(changed, reads, skips, globs);

test('changedFiles reports statuses, ranges and binary files from real git', () => {
  assert.deepEqual(find('a.ts')?.ranges, [[3, 4]]);
  assert.equal(find('a.ts')?.status, 'M');
  assert.equal(find('b.ts')?.status, 'A');
  assert.equal(find('d.ts')?.status, 'R');
  assert.deepEqual(find('d.ts')?.ranges, [[5, 5]]);
  assert.equal(find('e.ts')?.status, 'D');
  assert.equal(find('img.png')?.binary, true);
});

test('parseDiff handles single-line hunks, pure deletions and a rename without edits', () => {
  const text = [
    'diff --git a/x.ts b/x.ts',
    '--- a/x.ts',
    '+++ b/x.ts',
    '@@ -2 +2 @@',
    '-a',
    '+b',
    '@@ -8,2 +8,0 @@',
    '-c',
    '-d',
    '@@ -20,0 +21,3 @@',
    '+n',
    'diff --git a/old.ts b/new.ts',
    'similarity index 100%',
    'rename from old.ts',
    'rename to new.ts',
    '',
  ].join('\n');
  assert.deepEqual(parseDiff(text), [
    { file: 'x.ts', status: 'M', binary: false, ranges: [[2, 2], [21, 23]] },
    { file: 'new.ts', status: 'R', binary: false, ranges: [] },
  ]);
});

test('ranged reads must together contain every changed range', () => {
  const a = (r: [number, number][]) => cov(r.map((x) => mark('a.ts', { range: x })));
  assert.ok(a([[1, 2]]).partial.includes('a.ts'));
  assert.ok(a([[1, 3]]).partial.includes('a.ts'));
  assert.ok(a([[1, 10]]).read.includes('a.ts'));
  assert.ok(a([[1, 3], [4, 6]]).read.includes('a.ts'));
});

test('a whole-file read covers everything; a partial mark covers nothing', () => {
  const r = cov([mark('a.ts'), mark('b.ts', { partial: true })]);
  assert.ok(r.read.includes('a.ts'));
  assert.ok(r.unread.includes('b.ts'));
});

test('deleted files count only with a diff read', () => {
  assert.ok(cov([mark('e.ts', { via: 'hook' })]).unread.includes('e.ts'));
  assert.ok(cov([mark('e.ts', { via: 'manual', range: [1, 1] })]).unread.includes('e.ts'));
  assert.ok(cov([mark('e.ts', { via: 'diff' })]).read.includes('e.ts'));
});

test('a whole-file manual read also counts a deleted file (its old content was read elsewhere)', () => {
  assert.ok(cov([mark('e.ts', { via: 'manual' })]).read.includes('e.ts'));
});

test('binary files count with any non-partial read', () => {
  assert.ok(cov([mark('img.png', { range: [1, 1] })]).read.includes('img.png'));
  assert.ok(cov([]).unread.includes('img.png'));
});

test('a rename without edits counts as read by any non-partial read', () => {
  const ch = parseDiff('diff --git a/o.ts b/n.ts\nrename from o.ts\nrename to n.ts\n');
  assert.deepEqual(coverage(ch, [mark('n.ts', { range: [1, 1] })], [], []).read, ['n.ts']);
});

test('explicit skips keep their reason, glob skips get config', () => {
  const r = cov([], [{ file: 'b.ts', reason: 'generated' }], ['package-lock.json']);
  assert.deepEqual(r.skipped, [
    { file: 'b.ts', reason: 'generated' },
    { file: 'package-lock.json', reason: 'config' },
  ]);
  assert.ok(!r.unread.includes('b.ts'));
});

test('globs: basename without slash, ** spans folders, ? and * stop at slash', () => {
  const ch: ChangedFile[] = ['web/package-lock.json', 'src/a/b.gen.ts', 'src/x.ts', 'src/y/x.ts'].map(
    (file) => ({ file, status: 'M', binary: false, ranges: [[1, 1]] }),
  );
  const r = coverage(ch, [], [], ['package-lock.json', 'src/**/*.gen.ts', 'src/?.ts']);
  assert.deepEqual(r.skipped.map((s) => s.file), ['web/package-lock.json', 'src/a/b.gen.ts', 'src/x.ts']);
  assert.deepEqual(r.unread, ['src/y/x.ts']);
});
