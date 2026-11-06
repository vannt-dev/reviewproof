import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { setActive } from '../src/active.ts';
import { allReads } from '../src/reads.ts';
import { startRound } from '../src/rounds.ts';
import { LedgerStore } from '../src/store.ts';
import type { PrRef } from '../src/types.ts';

const bin = path.join(import.meta.dirname, '..', 'bin', 'reviewproof.ts');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-bin-'));
const home = path.join(root, 'home');
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

// The real entry in a child process: stdin, exit code and REVIEWPROOF_HOME as Claude Code sees them.
const cli = (args: string[], input = '') =>
  spawnSync(process.execPath, [bin, ...args], {
    input,
    encoding: 'utf8',
    env: { ...process.env, REVIEWPROOF_HOME: home },
  });

test('the bin passes the exit code of run through', () => {
  assert.equal(cli(['--help']).status, 0);
  assert.equal(cli(['frob']).status, 1);
});

test('hook: a post from the agent is denied on stdout; bad input exits 0 and prints nothing', () => {
  const post = { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'reviewproof post' } };
  const r = cli(['hook'], JSON.stringify(post));
  assert.equal(r.status, 0);
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, 'deny');
  for (const input of ['not json', '', 'null']) {
    const bad = cli(['hook'], input);
    assert.deepEqual([bad.status, bad.stdout], [0, ''], input);
  }
});

test('hook: a Read in the checkout lands in the REVIEWPROOF_HOME ledger', () => {
  const ref: PrRef = { host: 'github', hostname: 'github.com', project: 'o/r', number: 1 };
  const checkout = path.join(root, 'checkout');
  fs.mkdirSync(checkout);
  fs.writeFileSync(path.join(checkout, 'a.ts'), 'x\n');
  const store = new LedgerStore(home);
  store.save(startRound(null, ref, { url: 'u', title: 't', head: 'h1', base: 'b' }, 'b', new Date(0), false));
  setActive(home, checkout, ref);
  const read = { hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: path.join(checkout, 'a.ts') } };
  assert.equal(cli(['hook'], JSON.stringify(read)).status, 0);
  const round = store.load(ref)?.rounds[0];
  assert.deepEqual(round && allReads(store, ref, round).map((m) => m.file), ['a.ts']);
});
