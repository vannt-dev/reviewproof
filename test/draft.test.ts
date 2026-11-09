import assert from 'node:assert/strict';
import test from 'node:test';
import { renderDraft } from '../src/draft.ts';
import { addFinding } from '../src/rounds.ts';
import { notChecked } from '../src/gates.ts';
import { ready } from './ready-ledger.ts';

const cov = {
  read: ['a.ts', 'b.ts', 'c.ts'],
  partial: [],
  unread: [],
  skipped: [],
};

test('the draft of a ready two-round ledger shows carried status, gates and coverage', () => {
  const l = ready();
  const out = renderDraft(l, cov);
  assert.match(out, /F1-1 x: verified \(fixed\)/);
  assert.match(out, /- test: pass, 1 attempt$/m);
  assert.match(out, /read 3 of 3 changed files \(opened with Read or reviewproof diff\)$/m);
  assert.match(out, /not decided yet/);
  assert.equal(renderDraft(l, cov), out);
  // round 2 added no finding: "none", not a table header with no rows
  assert.match(out, /### Findings\n\nnone\n/);
  assert.doesNotMatch(out, /\| id \| severity \|/);
});

test('table rows are this round only, pipes are escaped, skips and verdict are listed', () => {
  const l = ready();
  addFinding(l, {
    severity: 'major',
    source: { kind: 'design', ref: 'doc' },
    location: { file: 'a.ts', line: 3, sha: 'h2' },
    title: 'a | b',
  });
  notChecked(l.rounds[1]!, 'lint', 'no linter');
  l.rounds[1]!.verdict = { value: 'not-yet', summary: 'Fix F2-1', at: '' };
  const out = renderDraft(l, {
    ...cov,
    skipped: [{ file: 'x.lock', reason: 'config' }],
  });
  assert.ok(out.includes('| a.ts:3@h2 | a \\| b |'), 'the pipe in the title is escaped');
  assert.doesNotMatch(out, /\| F1-1 \|/);
  assert.match(out, /Verdict: not-yet\.\*\* Fix F2-1/);
  assert.match(out, /- lint: not-checked \(no linter\), 1 attempt$/m);
  assert.match(
    out,
    /3 changed files \(opened with Read or reviewproof diff\); skipped: x\.lock \(config\)$/m,
  );
});

test('a finding body is in the draft under its id, and no details section without bodies', () => {
  const l = ready();
  assert.doesNotMatch(renderDraft(l, cov), /### Details/);
  addFinding(l, {
    severity: 'major',
    source: { kind: 'rule', ref: 'CONTRIBUTING.md#errors' },
    location: { file: 'a.ts', line: 3, sha: 'h2' },
    title: 'Errors are swallowed',
    body: 'The catch returns null.\n\nCallers read null as "not found".',
  });
  addFinding(l, {
    severity: 'minor',
    source: { kind: 'other', ref: 'naming' },
    location: { file: 'b.ts', line: 1, sha: 'h2' },
    title: 'No body here',
  });
  const out = renderDraft(l, cov);
  assert.ok(
    out.includes('### Details\n\n**F2-1 Errors are swallowed** (a.ts:3@h2)\n\nThe catch returns null.\n\nCallers read null as "not found".\n\n### Carried findings'),
    out,
  );
  assert.doesNotMatch(out, /\*\*F2-2 No body here\*\*/);
});
