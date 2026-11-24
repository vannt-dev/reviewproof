import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LedgerStore } from '../src/store.ts';
import { allReads } from '../src/reads.ts';
import { setActive } from '../src/active.ts';
import { handleHook } from '../src/hook.ts';
import reviewproof from '../src/pi.ts';
import { startRound } from '../src/rounds.ts';
import type { PrRef } from '../src/types.ts';

const tmp: string[] = [];
function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-pi-'));
  tmp.push(d);
  return d;
}
test.after(() => {
  for (const d of tmp) fs.rmSync(d, { recursive: true, force: true });
});

const ref: PrRef = { host: 'github', hostname: 'github.com', project: 'o/r', number: 1 };

function setup(): { home: string; checkout: string; store: LedgerStore } {
  const home = tmpDir();
  const checkout = path.join(tmpDir(), 'Checkout');
  fs.mkdirSync(path.join(checkout, 'src'), { recursive: true });
  fs.writeFileSync(path.join(checkout, 'src', 'A.ts'), 'x');
  const store = new LedgerStore(home);
  store.save(startRound(null, ref, { url: 'u', title: 't', head: 'h1', base: 'b' }, 'b', new Date(0), false));
  setActive(home, checkout, ref);
  return { home, checkout, store };
}

// What reviewproof's Pi extension passes on for a finished read.
const piRead = (cwd: string, input: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  pi_event: 'tool_result',
  toolName: 'read',
  input,
  isError: false,
  cwd,
  ...extra,
});

function reads(s: { store: LedgerStore }) {
  return allReads(s.store, ref, s.store.load(ref)!.rounds[0]!);
}

test('a Pi read relative to the session folder records the file and the lines it showed', () => {
  const s = setup();
  assert.equal(handleHook(piRead(s.checkout, { path: 'src/A.ts' }), s.home), null);
  assert.equal(handleHook(piRead(path.join(s.checkout, 'src'), { path: '@A.ts', offset: 10, limit: 20 }), s.home), null);
  const r = reads(s);
  assert.equal(r.length, 2);
  assert.equal(r[0]?.file, 'src/A.ts');
  assert.equal(r[0]?.via, 'hook');
  assert.equal(r[0]?.agent, undefined);
  // no limit: at most 2000 lines, and a read that showed fewer showed the whole rest of the file
  assert.deepEqual(r[0]?.range, [1, 2000]);
  assert.deepEqual(r[1]?.range, [10, 29]);
});

test('a Pi read cut at its line or byte limit covers only the lines it showed', () => {
  const s = setup();
  const truncated = { truncation: { truncated: true, truncatedBy: 'bytes', outputLines: 150 } };
  handleHook(piRead(s.checkout, { path: 'src/A.ts', offset: 5 }, { details: truncated }), s.home);
  assert.deepEqual(reads(s)[0]?.range, [5, 154]);
  // a first line over the byte limit: Pi showed no line of the file
  const tooLong = { truncation: { truncated: true, firstLineExceedsLimit: true, outputLines: 0 } };
  handleHook(piRead(s.checkout, { path: 'src/A.ts' }, { details: tooLong }), s.home);
  handleHook(piRead(s.checkout, { path: 'src/A.ts', limit: 0 }), s.home);
  assert.equal(reads(s).length, 1);
});

test('failed, nested, other-tool and outside reads record nothing; an image has no line range', () => {
  const s = setup();
  handleHook(piRead(s.checkout, { path: 'src/A.ts' }, { isError: true }), s.home);
  handleHook(piRead(s.checkout, { path: 'src/A.ts' }, { parentToolCallId: 'call-1' }), s.home);
  handleHook(piRead(s.checkout, { path: 'src/A.ts' }, { toolName: 'grep' }), s.home);
  handleHook(piRead(tmpDir(), { path: 'src/A.ts' }), s.home);
  handleHook(piRead(s.checkout, { path: 42 }), s.home);
  assert.equal(reads(s).length, 0);
  handleHook(piRead(s.checkout, { path: 'src/A.ts' }, { image: true }), s.home);
  const r = reads(s);
  assert.equal(r.length, 1);
  assert.equal(r[0]?.range, undefined);
});

test('the Pi extension records reads into REVIEWPROOF_HOME and never throws', () => {
  const s = setup();
  const handlers: Record<string, (event: unknown, ctx: unknown) => unknown> = {};
  reviewproof({ on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => (handlers[name] = handler) } as never);
  assert.deepEqual(Object.keys(handlers), ['tool_result']);
  const before = process.env.REVIEWPROOF_HOME;
  process.env.REVIEWPROOF_HOME = s.home;
  try {
    const event = {
      type: 'tool_result',
      toolCallId: 't1',
      toolName: 'read',
      input: { path: 'src/A.ts', limit: 3 },
      content: [{ type: 'text', text: 'x' }],
      isError: false,
    };
    assert.equal(handlers.tool_result!(event, { cwd: s.checkout }), undefined);
    handlers.tool_result!({ ...event, content: [{ type: 'image', data: '', mimeType: 'image/png' }] }, { cwd: s.checkout });
    assert.doesNotThrow(() => handlers.tool_result!(null, null));
    assert.doesNotThrow(() => handlers.tool_result!({ toolName: 'read' }, undefined));
  } finally {
    if (before === undefined) delete process.env.REVIEWPROOF_HOME;
    else process.env.REVIEWPROOF_HOME = before;
  }
  const r = reads(s);
  assert.equal(r.length, 2);
  assert.deepEqual(r[0]?.range, [1, 3]);
  assert.equal(r[1]?.range, undefined);
});

test('package.json points Pi at the extension built from src/pi.ts', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'package.json'), 'utf8'));
  assert.deepEqual(pkg.pi, { extensions: ['./dist/src/pi.js'] });
  assert.ok(fs.existsSync(path.join(import.meta.dirname, '..', 'src', 'pi.ts')));
});
