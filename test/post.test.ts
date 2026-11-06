import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { LedgerStore } from '../src/store.ts';
import { ready, ref, removeTmp, steps } from './e2e-helper.ts';

test.after(removeTmp);

test('a draft file edited by hand is not posted', async () => {
  const s = await ready();
  await steps(s, ['verdict', 'pass', '--summary', 'Clean.'], ['draft']);
  fs.appendFileSync(new LedgerStore(s.home).draftFile(ref, 1), '\nApproved by the whole team.\n');
  const r = await s.rp('post', '--approved-by', 'tester');
  assert.equal(r.code, 1);
  assert.match(r.err, /the draft file differs from the ledger: run reviewproof draft/);
  assert.equal(s.host.comments.size, 0);
  await steps(s, ['draft'], ['post', '--approved-by', 'tester']);
  assert.equal(s.host.comments.size, 1);
});

test('post refuses to run inside Claude Code', async () => {
  const s = await ready();
  await steps(s, ['verdict', 'pass', '--summary', 'Clean.'], ['draft']);
  process.env.CLAUDECODE = '1';
  try {
    const r = await s.rp('post', '--approved-by', 'tester');
    assert.equal(r.code, 1);
    assert.match(r.err, /post from your own terminal, not from the agent/);
  } finally {
    delete process.env.CLAUDECODE;
  }
  assert.equal(s.host.comments.size, 0);
});
