import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { toSarif } from '../src/sarif.ts';
import { addFinding, mark, startRound } from '../src/rounds.ts';
import { removeTmp, setup } from './e2e-helper.ts';
import type { Ledger, NewFinding, PrRef, Severity } from '../src/types.ts';

const ref: PrRef = { host: 'github', hostname: 'github.com', project: 'o/r', number: 1 };
const pr = (head: string) => ({ url: 'https://github.com/o/r/pull/1', title: 't', head, base: 'b0' });
const nf = (title: string, severity: Severity, ruleRef = 'R1'): NewFinding => ({
  severity,
  source: { kind: 'rule', ref: ruleRef },
  location: { file: 'src/a.ts', line: 3, sha: 'h1' },
  title,
});

// Round 1 raises F1-1..F1-4 and one that round 2 never touches; round 2 settles three and adds one.
function ledger(): Ledger {
  const l = startRound(null, ref, pr('h1'), 'b0', new Date(0), false);
  addFinding(l, nf('verified one', 'blocking'));
  addFinding(l, nf('reopened one', 'major', 'D2'));
  addFinding(l, nf('withdrawn one', 'minor'));
  addFinding(l, { ...nf('carried one', 'major'), body: 'more text' });
  startRound(l, ref, pr('h2'), 'h1', new Date(1), false);
  mark(l, 'F1-1', 'verified', { evidence: 'fixed' });
  mark(l, 'F1-2', 'reopened', { location: { file: 'src/b.ts', line: 9, sha: 'h2' } });
  mark(l, 'F1-3', 'withdrawn', { evidence: 'src/a.ts:3@abc1234' });
  addFinding(l, nf('fresh one', 'blocking', 'D2'));
  l.rounds[1]?.gates.push({ name: 'test', attempt: 1, argv: ['t'], exitCode: 1, result: 'fail', at: '' });
  l.rounds[1]?.gates.push({ name: 'test', attempt: 2, argv: ['t'], exitCode: 0, result: 'pass', at: '' });
  return l;
}

interface Out {
  version: string;
  runs: {
    tool: { driver: { name: string; version: string; rules: { id: string; properties: { kind: string } }[] } };
    versionControlProvenance: { revisionId: string }[];
    invocations: { executionSuccessful: boolean; properties: { gate: string; result: string } }[];
    results: Record<string, any>[];
  }[];
}

test('one run for the latest round, with the tool, rules and revision', () => {
  const s = toSarif(ledger(), '9.9.9', ['test', 'lint']) as Out;
  assert.equal(s.version, '2.1.0');
  assert.equal(s.runs.length, 1);
  const run = s.runs[0]!;
  assert.equal(run.tool.driver.name, 'reviewproof');
  assert.equal(run.tool.driver.version, '9.9.9');
  assert.deepEqual(run.tool.driver.rules.map((r) => [r.id, r.properties.kind]), [['R1', 'rule'], ['D2', 'rule']]);
  assert.equal(run.versionControlProvenance[0]?.revisionId, 'h2');
});

test('levels, baseline states, fingerprints and locations follow each finding', () => {
  const results = (toSarif(ledger(), '1') as Out).runs[0]!.results;
  const by = (id: string) => results.find((r) => r.partialFingerprints.findingId === id)!;
  assert.deepEqual([by('F1-1').level, by('F1-1').baselineState, by('F1-1').properties.status], ['error', 'absent', 'verified']);
  assert.deepEqual([by('F1-2').level, by('F1-2').baselineState], ['warning', 'updated']);
  assert.equal(by('F1-2').locations[0].physicalLocation.artifactLocation.uri, 'src/b.ts');
  assert.equal(by('F1-2').locations[0].physicalLocation.region.startLine, 9);
  assert.deepEqual([by('F1-3').level, by('F1-3').baselineState], ['note', 'absent']);
  assert.deepEqual([by('F1-4').baselineState, by('F1-4').message.text], ['unchanged', 'carried one\n\nmore text']);
  assert.deepEqual([by('F2-1').baselineState, by('F2-1').ruleId], ['new', 'D2']);
  assert.equal(by('F1-4').suppressions, undefined);
});

test('a withdrawn finding is suppressed with its evidence', () => {
  const results = (toSarif(ledger(), '1') as Out).runs[0]!.results;
  const w = results.find((r) => r.partialFingerprints.findingId === 'F1-3')!;
  assert.deepEqual(w.suppressions, [{ kind: 'external', justification: 'src/a.ts:3@abc1234' }]);
});

test('findings closed in an earlier round are left out', () => {
  const l = ledger();
  startRound(l, ref, pr('h3'), 'h2', new Date(2), false);
  const ids = (toSarif(l, '1') as Out).runs[0]!.results.map((r) => r.partialFingerprints.findingId);
  assert.deepEqual(ids.sort(), ['F1-2', 'F1-4', 'F2-1']);
});

test('one invocation per required gate, decided by the last attempt', () => {
  const inv = (toSarif(ledger(), '1', ['test', 'lint']) as Out).runs[0]!.invocations;
  assert.deepEqual(inv.map((i) => [i.properties.gate, i.executionSuccessful, i.properties.result]), [
    ['test', true, 'pass'],
    ['lint', false, 'missing'],
  ]);
});

test('invocations are the union of required gates and gates that ran', () => {
  const l = ledger();
  l.rounds[1]?.gates.push({ name: 'extra', attempt: 1, argv: ['x'], exitCode: 0, result: 'pass', at: '' });
  const inv = (toSarif(l, '1', ['lint']) as Out).runs[0]!.invocations;
  assert.deepEqual(inv.map((i) => i.properties.gate).sort(), ['extra', 'lint', 'test']);
});

test('artifact uris are percent-encoded per segment', () => {
  const l = ledger();
  l.findings.find((x) => x.id === 'F2-1')!.location = { file: 'src/a b\\ü#.ts', line: 1, sha: 'h2' };
  const r = (toSarif(l, '1') as Out).runs[0]!.results.find((x) => x.partialFingerprints.findingId === 'F2-1')!;
  assert.equal(r.locations[0].physicalLocation.artifactLocation.uri, 'src/a%20b/%C3%BC%23.ts');
});

test.after(removeTmp);

test('export --sarif --out writes valid SARIF JSON and prints its path', async () => {
  const s = setup();
  assert.equal((await s.rp('start', 'o/r#1')).code, 0);
  const file = path.join(s.root, 'out', 'r.sarif');
  const r = await s.rp('export', '--sarif', '--out', file);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out.trim(), file);
  const sarif = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(sarif.version, '2.1.0');
  assert.equal(sarif.runs[0].tool.driver.version, '0.1.0');
  assert.equal(sarif.runs[0].invocations[0].properties.gate, 'test');
  assert.equal((await s.rp('export')).code, 1);
});
