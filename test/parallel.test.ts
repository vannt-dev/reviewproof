import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { LedgerStore } from '../src/store.ts';
import { ref, removeTmp, runNode, setup, type Review } from './e2e-helper.ts';

const repo = path.join(import.meta.dirname, '..');
const bin = path.join(repo, 'bin', 'reviewproof.ts');
test.after(removeTmp);

// The real CLI in a child process, as an agent's background command runs it.
const cli = (s: Review, ...args: string[]) =>
  runNode([bin, ...args], { cwd: s.checkout, env: { REVIEWPROOF_HOME: s.home } });

const ledger = (s: Review) => new LedgerStore(s.home).load(ref)!;
const logText = (s: Review, log: string) => fs.readFileSync(path.join(new LedgerStore(s.home).dirFor(ref), log), 'utf8');

function findings(s: Review, name: string): string {
  const file = path.join(s.root, `${name}.json`);
  const at = ['src/a.ts:1', 'src/a.ts:3', 'src/c.ts:1'];
  const list = at.map((x, i) => ({ severity: 'minor', source: { kind: 'rule', ref: 'R1' }, at: x, title: `${name}${i + 1}` }));
  fs.writeFileSync(file, JSON.stringify(list));
  return file;
}

async function started(): Promise<Review> {
  const s = setup();
  const r = await s.rp('start', 'o/r#1');
  assert.equal(r.code, 0, r.err);
  return s;
}

// A gate that is still running while other commands change the ledger.
const slowGate = (name: string, code: number, says: string) =>
  ['gate', 'run', name, '--', process.execPath, '-e', `setTimeout(() => { console.log('${says}'); process.exitCode = ${code}; }, 300)`];

test('two adds and two gate runs at once all land in the ledger', async () => {
  const s = await started();
  const slow = slowGate('slow', 0, 'done');
  const runs = await Promise.all([cli(s, 'add', findings(s, 'a')), cli(s, 'add', findings(s, 'b')), cli(s, ...slow), cli(s, ...slow)]);
  for (const r of runs) assert.equal(r.code, 0, r.err);
  const l = ledger(s);
  assert.deepEqual(l.findings.map((f) => f.title).sort(), ['a1', 'a2', 'a3', 'b1', 'b2', 'b3']);
  assert.equal(new Set(l.findings.map((f) => f.id)).size, 6);
  const gates = l.rounds[0]!.gates;
  assert.deepEqual(gates.map((g) => [g.name, g.attempt, g.result]).sort(), [['slow', 1, 'pass'], ['slow', 2, 'pass']]);
  assert.equal(fs.existsSync(path.join(new LedgerStore(s.home).dirFor(ref), 'ledger.lock')), false);
});

test('a failed run is never lost or overwritten: an add during it, then a second failed run', async () => {
  const s = await started();
  const [gate, add] = await Promise.all([cli(s, ...slowGate('test', 1, 'first')), cli(s, 'add', findings(s, 'a'))]);
  assert.equal(gate.code, 1, gate.err);
  assert.equal(add.code, 0, add.err);
  assert.equal(ledger(s).findings.length, 3);
  assert.equal((await cli(s, ...slowGate('test', 1, 'second'))).code, 1);
  const gates = ledger(s).rounds[0]!.gates;
  assert.deepEqual(gates.map((g) => [g.attempt, g.result, g.log]), [
    [1, 'fail', 'logs/round-1/test-1.log'],
    [2, 'fail', 'logs/round-1/test-2.log'],
  ]);
  assert.match(logText(s, 'logs/round-1/test-1.log'), /^first$/m);
  assert.match(logText(s, 'logs/round-1/test-2.log'), /^second$/m);
});

test('a log left by an attempt the ledger does not hold keeps its number and its text', async () => {
  const s = await started();
  const left = path.join(new LedgerStore(s.home).dirFor(ref), 'logs', 'round-1', 'test-1.log');
  fs.mkdirSync(path.dirname(left), { recursive: true });
  fs.writeFileSync(left, 'an earlier run\n');
  const r = await s.rp('gate', 'run', 'test', '--', process.execPath, '-e', '0');
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(ledger(s).rounds[0]!.gates.map((g) => [g.attempt, g.log]), [[2, 'logs/round-1/test-2.log']]);
  assert.equal(fs.readFileSync(left, 'utf8'), 'an earlier run\n');
});

test('a gate that ran for a round followed by a new one meanwhile is refused, not recorded', async () => {
  const s = await started();
  const running = path.join(s.root, 'gate-running');
  const script = `require('fs').writeFileSync(${JSON.stringify(running)}, ''); setTimeout(() => {}, 1000)`;
  const gate = cli(s, 'gate', 'run', 'test', '--', process.execPath, '-e', script);
  for (let i = 0; i < 500 && !fs.existsSync(running); i++) await new Promise((r) => setTimeout(r, 20));
  s.push('src/b.ts', 'b2\n');
  const next = await s.rp('start', 'o/r#1');
  assert.equal(next.code, 0, next.err);
  const r = await gate;
  assert.equal(r.code, 1);
  assert.match(r.err, /round 2 of o\/r#1 started meanwhile: run the command again/);
  assert.deepEqual(ledger(s).rounds.map((x) => x.gates.length), [0, 0]);
});

test('the review-round skill says how to work in parallel and still never to post', () => {
  const text = fs.readFileSync(path.join(repo, 'skills', 'review-round', 'SKILL.md'), 'utf8');
  assert.ok(text.includes('Work in parallel'));
  assert.ok(text.includes('never run reviewproof post'));
});
