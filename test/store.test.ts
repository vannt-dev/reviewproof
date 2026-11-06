import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { LedgerStore } from '../src/store.ts';
import { loadConfig } from '../src/config.ts';
import type { Ledger, PrRef } from '../src/types.ts';

const tmp: string[] = [];
function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-store-'));
  tmp.push(d);
  return d;
}
test.after(() => {
  for (const d of tmp) fs.rmSync(d, { recursive: true, force: true });
});

const ref: PrRef = { host: 'gitlab', hostname: 'gitlab.example.com', project: 'grp/sub/repo', number: 7 };
const ledger: Ledger = {
  schemaVersion: 1,
  pr: { ...ref, url: 'https://gitlab.example.com/grp/sub/repo/-/merge_requests/7', title: 'T' },
  rounds: [],
  findings: [],
};

test('save then load round-trips and uses the documented path', () => {
  const home = tmpDir();
  const store = new LedgerStore(home);
  store.save(ledger);
  assert.deepEqual(store.load(ref), ledger);
  assert.equal(
    store.dirFor(ref),
    path.join(home, 'gitlab.example.com', 'grp', 'sub', 'repo', '7'),
  );
  assert.deepEqual(fs.readdirSync(store.dirFor(ref)), ['ledger.json']);
});

test('a port in the hostname becomes a valid folder name', () => {
  const home = tmpDir();
  const store = new LedgerStore(home);
  const withPort: PrRef = { ...ref, hostname: 'gitlab.example.com:8443' };
  assert.equal(
    store.dirFor(withPort),
    path.join(home, 'gitlab.example.com_8443', 'grp', 'sub', 'repo', '7'),
  );
  store.save({ ...ledger, pr: { ...ledger.pr, hostname: 'gitlab.example.com:8443' } });
  assert.notEqual(store.load(withPort), null);
});

test('load returns null without a ledger', () => {
  assert.equal(new LedgerStore(tmpDir()).load(ref), null);
});

test('a newer schema is refused', () => {
  const store = new LedgerStore(tmpDir());
  fs.mkdirSync(store.dirFor(ref), { recursive: true });
  fs.writeFileSync(path.join(store.dirFor(ref), 'ledger.json'), JSON.stringify({ ...ledger, schemaVersion: 2 }));
  assert.throws(() => store.load(ref), /^Error: ledger schema 2 is newer than this reviewproof \(1\)$/);
});

test('writeLog keeps every attempt and never overwrites one; writeDraft rewrites the round file', () => {
  const store = new LedgerStore(tmpDir());
  const a = store.writeLog(ref, 1, 'lint', 1, 'one');
  const b = store.writeLog(ref, 1, 'lint', 2, 'two');
  assert.equal(a, path.join(store.dirFor(ref), 'logs', 'round-1', 'lint-1.log'));
  assert.equal(fs.readFileSync(a, 'utf8'), 'one');
  assert.equal(fs.readFileSync(b, 'utf8'), 'two');
  assert.throws(() => store.writeLog(ref, 1, 'lint', 1, 'again'), { code: 'EEXIST' });
  assert.equal(fs.readFileSync(a, 'utf8'), 'one');
  store.writeDraft(ref, 2, '# old');
  const d = store.writeDraft(ref, 2, '# draft');
  assert.equal(d, path.join(store.dirFor(ref), 'drafts', 'round-2.md'));
  assert.equal(fs.readFileSync(d, 'utf8'), '# draft');
});

test('commit inits the repo on first use and commits with the message', () => {
  process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = 'Test';
  process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = 'test@example.com';
  const home = tmpDir();
  const store = new LedgerStore(home);
  store.save(ledger);
  fs.writeFileSync(path.join(home, 'active.json'), '{}');
  // As verdict and post commit: inside the ledger lock, whose file is there meanwhile.
  store.locked(ref, () => store.commit('round 1'));
  assert.ok(fs.existsSync(path.join(home, '.git')));
  const git = (...args: string[]) => spawnSync('git', ['-C', home, ...args], { encoding: 'utf8' }).stdout.trim();
  assert.equal(git('rev-list', '--count', 'HEAD'), '1');
  assert.equal(git('log', '-1', '--format=%s'), 'round 1');
  // Machine-local state (checkout paths, temp and lock files) stays out of the history.
  assert.deepEqual(git('ls-files').split('\n'), ['.gitignore', 'gitlab.example.com/grp/sub/repo/7/ledger.json']);
  // Nothing changed since: a re-run commits nothing and does not fail.
  store.commit('round 1 again');
  assert.equal(git('rev-list', '--count', 'HEAD'), '1');
});

test('commit adds the missing patterns to a .gitignore the home already has, once', () => {
  const home = tmpDir();
  const ignore = path.join(home, '.gitignore');
  fs.writeFileSync(ignore, 'notes/\n*.tmp');
  const store = new LedgerStore(home);
  store.save(ledger);
  store.locked(ref, () => store.commit('round 1'));
  assert.equal(fs.readFileSync(ignore, 'utf8'), 'notes/\n*.tmp\nactive.json\n*.lock\n');
  const files = spawnSync('git', ['-C', home, 'ls-files'], { encoding: 'utf8' }).stdout.trim().split('\n');
  assert.deepEqual(files, ['.gitignore', 'gitlab.example.com/grp/sub/repo/7/ledger.json']);
  store.commit('round 1 again');
  assert.equal(fs.readFileSync(ignore, 'utf8'), 'notes/\n*.tmp\nactive.json\n*.lock\n');
});

test('loadConfig prefers the checkout file and fills defaults', () => {
  const checkout = tmpDir();
  const home = tmpDir();
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ requiredGates: ['home'] }));
  assert.deepEqual(loadConfig(checkout, home).requiredGates, ['home']);
  fs.writeFileSync(path.join(checkout, '.reviewproof.json'), JSON.stringify({ skip: ['x'], extra: 1 }));
  const cfg = loadConfig(checkout, home);
  assert.deepEqual(cfg, {
    requiredGates: [],
    skip: ['x'],
    hedgeWords: ['probably', 'seems', 'might', 'maybe', 'likely'],
  });
});

test('loadConfig returns defaults when no file exists', () => {
  const cfg = loadConfig(tmpDir(), tmpDir());
  assert.deepEqual(cfg.skip, ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', '**/*.snap']);
});

test('loadConfig names the file for bad JSON and refuses a non-object', () => {
  const checkout = tmpDir();
  const file = path.join(checkout, '.reviewproof.json');
  const names = (re: RegExp) => (e: Error) => e.message.includes(file) && re.test(e.message);
  fs.writeFileSync(file, '{ nope');
  assert.throws(() => loadConfig(checkout, tmpDir()), names(/not valid JSON/));
  for (const text of ['null', '[]', '"x"', '3']) {
    fs.writeFileSync(file, text);
    assert.throws(() => loadConfig(checkout, tmpDir()), names(/must hold a JSON object/));
  }
});

test('commit works with signing forced on, no git identity and a global hooks path', () => {
  const home = tmpDir();
  const hooks = tmpDir();
  fs.writeFileSync(path.join(hooks, 'pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const gitconfig = path.join(tmpDir(), 'gitconfig');
  const slashed = hooks.split(path.sep).join('/');
  fs.writeFileSync(gitconfig, `[commit]\n\tgpgsign = true\n[gpg]\n\tprogram = false\n[core]\n\thooksPath = ${slashed}\n`);
  const saved = { ...process.env };
  for (const k of ['GIT_AUTHOR_NAME', 'GIT_COMMITTER_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_EMAIL']) {
    delete process.env[k];
  }
  Object.assign(process.env, { GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_NOSYSTEM: '1', HOME: home, USERPROFILE: home });
  try {
    const store = new LedgerStore(home);
    store.save(ledger);
    store.locked(ref, () => store.commit('round 1'));
    const log = spawnSync('git', ['-C', home, 'log', '-1', '--format=%an %s'], { encoding: 'utf8' });
    assert.equal(log.stdout.trim(), 'reviewproof round 1');
  } finally {
    process.env = saved;
  }
});
