import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { handleHook } from '../src/hook.ts';
import { LedgerStore } from '../src/store.ts';
import { ref, removeTmp, setup, type Review } from './e2e-helper.ts';

test.after(removeTmp);

// The PR in `setup` changes lines 2-3 of src/a.ts, adds src/c.ts and leaves src/b.ts alone.
async function started(): Promise<Review> {
  const s = setup();
  const r = await s.rp('start', 'o/r#1');
  assert.equal(r.code, 0, r.err);
  return s;
}

// A Read as the hook sees it: a helper's carries its agent id, the main session's none.
function toolRead(s: Review, file: string, opts: { agent?: string; offset?: number; limit?: number; partial?: true } = {}): void {
  const event = {
    hook_event_name: 'PostToolUse',
    tool_name: 'Read',
    tool_input: { file_path: path.join(s.checkout, file), offset: opts.offset, limit: opts.limit },
    tool_response: opts.partial ? 'PARTIAL view of the file' : 'ok',
    ...(opts.agent === undefined ? {} : { agent_id: opts.agent }),
  };
  assert.equal(handleHook(event, s.home), null);
}

function findings(s: Review, ...list: [severity: string, at: string][]): string {
  const file = path.join(s.root, 'findings.json');
  const items = list.map(([severity, at], i) => ({ severity, source: { kind: 'rule', ref: 'R1' }, at, title: `t${i + 1}` }));
  fs.writeFileSync(file, JSON.stringify(items));
  return file;
}

const titles = (s: Review) => new LedgerStore(s.home).load(ref)!.findings.map((f) => f.title);

test('without helpers a finding needs no read of its own, as before', async () => {
  const s = await started();
  const r = await s.rp('add', findings(s, ['blocking', 'src/b.ts:1']));
  assert.equal(r.code, 0, r.err);
});

test('once a helper has read, a major finding on a line the main session never saw is refused', async () => {
  const s = await started();
  toolRead(s, 'src/a.ts', { agent: 'helper-1' });
  const r = await s.rp('add', findings(s, ['minor', 'src/c.ts:1'], ['major', 'src/a.ts:2']));
  assert.equal(r.code, 1);
  assert.match(r.err, /nothing added/);
  assert.match(r.err, /finding 2: src\/a\.ts:2 has not been read by the main session/);
  assert.match(r.err, /helper/);
  assert.deepEqual(titles(s), []);
});

test('the main session reading the line itself lets the finding in', async () => {
  const s = await started();
  toolRead(s, 'src/a.ts', { agent: 'helper-1' });
  toolRead(s, 'src/a.ts');
  const r = await s.rp('add', findings(s, ['blocking', 'src/a.ts:2']));
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(titles(s), ['t1']);
});

test('a read of other lines, or one cut short, is not a read of the line', async () => {
  const s = await started();
  toolRead(s, 'src/a.ts', { agent: 'helper-1' });
  toolRead(s, 'src/a.ts', { offset: 1, limit: 1 });
  toolRead(s, 'src/a.ts', { partial: true });
  const r = await s.rp('add', findings(s, ['major', 'src/a.ts:3']));
  assert.equal(r.code, 1);
  assert.match(r.err, /src\/a\.ts:3 has not been read by the main session/);
});

test('the printed diff counts for the lines it shows, not for the rest of the checkout', async () => {
  const s = await started();
  toolRead(s, 'src/b.ts', { agent: 'helper-1' });
  assert.equal((await s.rp('diff')).code, 0);
  // Line 1 of src/a.ts is unchanged but printed as context of the change at lines 2-3.
  const shown = await s.rp('add', findings(s, ['major', 'src/a.ts:2'], ['major', 'src/a.ts:1']));
  assert.equal(shown.code, 0, shown.err);
  const elsewhere = await s.rp('add', findings(s, ['major', 'src/b.ts:1']));
  assert.equal(elsewhere.code, 1);
  assert.match(elsewhere.err, /src\/b\.ts:1 has not been read by the main session/);
});

test('a read declared with reviewproof read counts as the main session\'s', async () => {
  const s = await started();
  toolRead(s, 'src/a.ts', { agent: 'helper-1' });
  assert.equal((await s.rp('read', 'src/a.ts', '--lines', '2-3')).code, 0);
  const r = await s.rp('add', findings(s, ['major', 'src/a.ts:3']));
  assert.equal(r.code, 0, r.err);
});

test('a minor finding is taken on a helper\'s word', async () => {
  const s = await started();
  toolRead(s, 'src/a.ts', { agent: 'helper-1' });
  const r = await s.rp('add', findings(s, ['minor', 'src/a.ts:2']));
  assert.equal(r.code, 0, r.err);
});

test('reopening a major finding asks for the same read', async () => {
  const s = await started();
  assert.equal((await s.rp('add', findings(s, ['major', 'src/a.ts:2']))).code, 0);
  s.push('src/a.ts', 'one\nTWO\nthree\nfour\n');
  assert.equal((await s.rp('start', 'o/r#1')).code, 0);
  toolRead(s, 'src/a.ts', { agent: 'helper-1' });
  const refused = await s.rp('mark', 'F1-1', 'reopened', '--at', 'src/a.ts:2');
  assert.equal(refused.code, 1);
  assert.match(refused.err, /src\/a\.ts:2 has not been read by the main session/);
  toolRead(s, 'src/a.ts');
  const ok = await s.rp('mark', 'F1-1', 'reopened', '--at', 'src/a.ts:2');
  assert.equal(ok.code, 0, ok.err);
});
