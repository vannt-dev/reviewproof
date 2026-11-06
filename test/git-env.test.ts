import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { LedgerStore } from '../src/store.ts';
import { changedFiles } from '../src/diff.ts';
import { gitEnv } from '../src/git-env.ts';
import { git, removeTmp, setup } from './e2e-helper.ts';

test.after(removeTmp);

test('the preload removed repository variables from this process', () => {
  // The outer shell may have set them (GIT_DIR=<decoy> npm test); a hook does exactly that.
  assert.equal(process.env.GIT_DIR, undefined);
  assert.equal(process.env.GIT_INDEX_FILE, undefined);
});

test('gitEnv drops the repository variables, keeps the rest and merges extra', () => {
  const env = gitEnv({ GIT_TERMINAL_PROMPT: '0' }, {
    GIT_DIR: 'x',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'k',
    GIT_CONFIG_VALUE_0: 'v',
    GIT_AUTHOR_NAME: 'kept',
    PATH: 'p',
  });
  assert.deepEqual(env, { GIT_AUTHOR_NAME: 'kept', PATH: 'p', GIT_TERMINAL_PROMPT: '0' });
});

test('git runs on the repository it is pointed at, not the one named by inherited variables', async () => {
  const s = setup();
  const decoy = path.join(s.root, 'decoy');
  fs.mkdirSync(decoy);
  git(decoy, 'init', '-q');
  git(decoy, 'commit', '-q', '--allow-empty', '-m', 'decoy');
  const before = git(decoy, 'rev-parse', 'HEAD');
  const bare = git(decoy, 'config', '--get', 'core.bare');
  const saved = { dir: process.env.GIT_DIR, index: process.env.GIT_INDEX_FILE };
  process.env.GIT_DIR = path.join(decoy, '.git');
  process.env.GIT_INDEX_FILE = path.join(decoy, '.git', 'index');
  try {
    new LedgerStore(s.home).commit('ledger'); // the home holds config.json and is not a repository yet
    assert.deepEqual(changedFiles(s.checkout, s.host.base, s.host.head).map((f) => f.file), ['src/a.ts', 'src/c.ts']);
    const started = await s.rp('start', 'o/r#1'); // finds the checkout through git
    assert.equal(started.code, 0, started.err);
  } finally {
    if (saved.dir === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = saved.dir;
    if (saved.index === undefined) delete process.env.GIT_INDEX_FILE;
    else process.env.GIT_INDEX_FILE = saved.index;
  }
  assert.equal(git(decoy, 'rev-parse', 'HEAD'), before);
  assert.equal(git(decoy, 'rev-list', '--count', 'HEAD'), '1');
  assert.equal(git(decoy, 'status', '--porcelain'), '');
  assert.equal(git(decoy, 'config', '--get', 'core.bare'), bare); // git init writes false; true means hijacked
  assert.equal(git(s.home, 'log', '--format=%s'), 'ledger');
});
