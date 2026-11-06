import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { LedgerStore } from '../src/store.ts';
import { ref, removeTmp, setup, steps } from './e2e-helper.ts';

test.after(removeTmp);

test('gate names are plain words: no path, drive or stream characters', async () => {
  const nameRule = /gate name ".*": use letters, digits, \., _ and -, from a letter or digit \(e\.g\. test-unit\)/;
  const s = setup();
  await steps(s, ['start', 'o/r#1']);
  for (const name of ['../x', 'test:unit', 'a/b', 'a\\b', '..', '.x', '']) {
    const run = ['gate', 'run', name, '--', process.execPath, '-e', '0'];
    for (const argv of [run, ['gate', 'skip', name, '--reason', 'none']]) {
      const r = await s.rp(...argv);
      assert.equal(r.code, 1, argv.join(' '));
      assert.match(r.err, nameRule, argv.join(' '));
    }
  }
  assert.equal(new LedgerStore(s.home).load(ref)!.rounds[0]?.gates.length, 0);
  assert.equal(fs.existsSync(path.join(new LedgerStore(s.home).dirFor(ref), 'logs')), false);
  await steps(s, ['gate', 'skip', 'Test.unit_2-x', '--reason', 'none']);
});

test('a token value in the gate command line is *** in ledger.json', async () => {
  const s = setup();
  await steps(s, ['start', 'o/r#1']);
  process.env.TEST_TOKEN = 's3cr3t-value';
  try {
    await steps(s, ['gate', 'run', 'test', '--', process.execPath, '-e', '0', 'key=s3cr3t-value']);
  } finally {
    delete process.env.TEST_TOKEN;
  }
  const text = fs.readFileSync(path.join(new LedgerStore(s.home).dirFor(ref), 'ledger.json'), 'utf8');
  assert.ok(!text.includes('s3cr3t-value'));
  assert.deepEqual(new LedgerStore(s.home).load(ref)!.rounds[0]?.gates[0]?.argv?.at(-1), 'key=***');
});
