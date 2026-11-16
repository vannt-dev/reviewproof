import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { staleEvidence } from '../src/evidence.ts';
import { git, passTest, ready, removeTmp, setup, steps } from './e2e-helper.ts';

after(removeTmp);

const tmp: string[] = [];
after(() => {
  for (const d of tmp) fs.rmSync(d, { recursive: true, force: true });
});

// A repository with one commit on main; `commit` adds a commit on the pull request's branch.
function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-evidence-'));
  tmp.push(dir);
  git(dir, 'init', '-q', '-b', 'main');
  const commit = (files: Record<string, string | null>): string => {
    for (const [file, text] of Object.entries(files)) {
      const p = path.join(dir, file);
      if (text === null) fs.rmSync(p);
      else {
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, text);
      }
    }
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', Object.keys(files).join(' '));
    return git(dir, 'rev-parse', 'HEAD');
  };
  const base = commit({ 'src/a.ts': 'a\n', 'README.md': 'r\n' });
  git(dir, 'switch', '-q', '-c', 'pr');
  return { dir, base, commit };
}

const EVIDENCE = ['evidence/**', '*.png'];

test('evidence changed before a later code change is stale; the code change is named', () => {
  const { dir, base, commit } = repo();
  commit({ 'src/a.ts': 'a2\n' });
  const shot = commit({ 'evidence/run.png': 'png1', 'evidence/report.html': 'r1' });
  const code = commit({ 'src/b.ts': 'b\n' });
  const stale = staleEvidence(dir, base, code, EVIDENCE, ['**']);
  assert.deepEqual(
    stale.map((s) => [s.file, s.changedAt, s.codeFile, s.codeAt]),
    [
      ['evidence/report.html', shot, 'src/b.ts', code],
      ['evidence/run.png', shot, 'src/b.ts', code],
    ],
  );
});

test('evidence made after the last code change is not stale', () => {
  const { dir, base, commit } = repo();
  commit({ 'evidence/run.png': 'png1' });
  commit({ 'src/a.ts': 'a2\n' });
  const head = commit({ 'evidence/run.png': 'png2' });
  assert.deepEqual(staleEvidence(dir, base, head, EVIDENCE, ['**']), []);
});

test('only changes to the files the evidence covers make it stale', () => {
  const { dir, base, commit } = repo();
  commit({ 'src/a.ts': 'a2\n' });
  commit({ 'shot.png': 'png1' });
  const head = commit({ 'README.md': 'r2\n' });
  assert.deepEqual(staleEvidence(dir, base, head, EVIDENCE, ['src/**']), []);
  assert.deepEqual(staleEvidence(dir, base, head, EVIDENCE, ['**']).map((s) => s.codeFile), ['README.md']);
});

test('evidence the pull request deleted, or never touched, is not judged', () => {
  const { dir, base, commit } = repo();
  commit({ 'evidence/old.png': 'png' });
  commit({ 'evidence/old.png': null });
  const head = commit({ 'src/a.ts': 'a2\n' });
  assert.deepEqual(staleEvidence(dir, base, head, EVIDENCE, ['**']), []);
});

test('changes that came in by merging the base branch do not make evidence stale', () => {
  const { dir, base, commit } = repo();
  commit({ 'src/a.ts': 'a2\n' });
  commit({ 'evidence/run.png': 'png1' });
  git(dir, 'switch', '-q', 'main');
  commit({ 'src/other.ts': 'o\n' });
  git(dir, 'switch', '-q', 'pr');
  git(dir, 'merge', '-q', '--no-edit', 'main');
  const head = git(dir, 'rev-parse', 'HEAD');
  assert.deepEqual(staleEvidence(dir, base, head, EVIDENCE, ['**']), []);
});

test('no evidence globs: nothing is judged', () => {
  const { dir, base, commit } = repo();
  commit({ 'shot.png': 'png1' });
  const head = commit({ 'src/a.ts': 'a2\n' });
  assert.deepEqual(staleEvidence(dir, base, head, [], ['**']), []);
});

test('stale evidence blocks verdict pass, shows in status and the draft, and not-yet is allowed', async () => {
  // The pull request's first commit adds src/c.ts (the evidence here); a later one changes src/a.ts.
  const s = setup();
  s.push('src/a.ts', 'one\nTWO\nthree\nfour\n');
  fs.writeFileSync(path.join(s.home, 'config.json'), JSON.stringify({ requiredGates: ['test'], evidence: ['src/c.ts'] }));
  await steps(s, ['start', 'o/r#1'], ['diff'], passTest);
  const st = await s.rp('status');
  assert.match(st.out, /verdict pass is blocked by:\n {2}- evidence src\/c\.ts was last changed at [0-9a-f]{7}, before src\/a\.ts changed at [0-9a-f]{7}: make it again at the head/);
  const pass = await s.rp('verdict', 'pass', '--summary', 'Looks right.');
  assert.equal(pass.code, 1);
  assert.match(pass.err, /evidence src\/c\.ts was last changed/);
  const notYet = await s.rp('verdict', 'not-yet', '--summary', 'Evidence is older than the code.');
  assert.equal(notYet.code, 0, notYet.err);
  const draft = await s.rp('draft');
  assert.match(draft.out, /### Evidence\n\n- src\/c\.ts: stale \(changed at [0-9a-f]{7}, before src\/a\.ts at [0-9a-f]{7}\)/);
});

test('with evidence configured and up to date, the draft says so and verdict pass is allowed', async () => {
  const s = await ready();
  fs.writeFileSync(path.join(s.home, 'config.json'), JSON.stringify({ requiredGates: ['test'], evidence: ['src/a.ts'] }));
  const pass = await s.rp('verdict', 'pass', '--summary', 'Looks right.');
  assert.equal(pass.code, 0, pass.err);
  const draft = await s.rp('draft');
  assert.match(draft.out, /### Evidence\n\nup to date: 1 evidence file changed after the last change it covers/);
});
