import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { LedgerStore } from '../src/store.ts';
import type { Ledger, PrRef } from '../src/types.ts';
import { git, runNode } from './e2e-helper.ts';

// The ledger home under parallel use: unlocked readers, several pull requests, several checkouts.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-home-'));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
const newHome = (name: string): string => fs.mkdtempSync(path.join(root, `${name}-`));

const src = (file: string): string => JSON.stringify(pathToFileURL(path.join(import.meta.dirname, '..', 'src', file)).href);
const script = (code: string, ...args: string[]) => runNode(['--input-type=module', '-e', code, ...args]);
const waitFor = async (file: string): Promise<void> => {
  for (let i = 0; i < 500 && !fs.existsSync(file); i++) await new Promise((r) => setTimeout(r, 20));
  assert.ok(fs.existsSync(file), `${file} never appeared`);
};

const ref: PrRef = { host: 'github', hostname: 'github.com', project: 'o/r', number: 1 };
const ledger = (title: string): Ledger => ({ schemaVersion: 1, pr: { ...ref, url: 'u', title }, rounds: [], findings: [] });

// An unlocked reader (the hook, status) that keeps the file open for a moment.
const holdOpen = `
import fs from 'node:fs';
const [file, ready] = process.argv.slice(1);
const fd = fs.openSync(file, 'r');
fs.writeFileSync(ready, '');
setTimeout(() => fs.closeSync(fd), 300);
`;

test('save waits for a reader that has ledger.json open, then replaces it', async () => {
  const home = newHome('open');
  const store = new LedgerStore(home);
  store.save(ledger('old'));
  const ready = path.join(home, 'ready');
  const reader = script(holdOpen, path.join(store.dirFor(ref), 'ledger.json'), ready);
  await waitFor(ready);
  store.save(ledger('new'));
  assert.equal(store.load(ref)?.pr.title, 'new');
  assert.equal((await reader).code, 0);
  assert.deepEqual(fs.readdirSync(store.dirFor(ref)), ['ledger.json']);
});

test('a save whose rename keeps failing throws and leaves no temp file behind', () => {
  const store = new LedgerStore(newHome('fail'));
  // A folder where ledger.json goes: no rename can replace it.
  fs.mkdirSync(path.join(store.dirFor(ref), 'ledger.json', 'x'), { recursive: true });
  assert.throws(() => store.save(ledger('t')));
  assert.deepEqual(fs.readdirSync(store.dirFor(ref)), ['ledger.json']);
});

// One agent per pull request: each start records its checkout in the home's one active.json.
const activate = `
import { setActive } from ${src('active.ts')};
const [home, name] = process.argv.slice(1);
for (let i = 0; i < 40; i++) {
  setActive(home, home + '/' + name + i, { host: 'github', hostname: 'github.com', project: 'o/r', number: i });
}
`;

// The hook reads active.json on every Read, without a lock.
const readLoop = `
import fs from 'node:fs';
const [file, ms] = process.argv.slice(1);
let torn = 0;
for (const end = Date.now() + Number(ms); Date.now() < end; ) {
  try {
    JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (e instanceof SyntaxError) torn++;
  }
}
console.log(torn);
`;

test('checkouts made active at the same time are all kept, and a reader never sees half a file', async () => {
  const home = newHome('active');
  const reader = script(readLoop, path.join(home, 'active.json'), '1500');
  const runs = await Promise.all(['x', 'y'].map((name) => script(activate, home, name)));
  for (const r of runs) assert.equal(r.code, 0, r.err);
  const map = JSON.parse(fs.readFileSync(path.join(home, 'active.json'), 'utf8')) as object;
  assert.equal(Object.keys(map).length, 80);
  const read = await reader;
  assert.deepEqual([read.code, read.out.trim()], [0, '0'], 'torn reads of active.json');
});

// Verdicts and posts of different pull requests commit to the one git repository of the home.
const commits = `
import { LedgerStore } from ${src('store.ts')};
const [home, project] = process.argv.slice(1);
const store = new LedgerStore(home);
const pr = { host: 'github', hostname: 'github.com', project, number: 1, url: 'u' };
for (let i = 1; i <= 4; i++) {
  store.save({ schemaVersion: 1, pr: { ...pr, title: 't' + i }, rounds: [], findings: [] });
  store.commit(project + ' ' + i);
}
`;

test('two pull requests committing at the same time both commit', async () => {
  const home = newHome('commit');
  const runs = await Promise.all(['o/x', 'o/y'].map((p) => script(commits, home, p)));
  for (const r of runs) assert.equal(r.code, 0, r.err);
  for (const p of ['o/x', 'o/y']) {
    assert.match(git(home, 'show', `HEAD:github.com/${p}/1/ledger.json`), /"title": "t4"/);
  }
  assert.equal(git(home, 'status', '--porcelain'), '');
});
