import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { GitHub } from '../src/github.ts';
import type { CiCheck, Host } from '../src/hosts.ts';
import { toSarif } from '../src/sarif.ts';
import { LedgerStore } from '../src/store.ts';
import type { GateAttempt, PrRef } from '../src/types.ts';
import { ref, removeTmp, setup, steps, type Review } from './e2e-helper.ts';

test.after(removeTmp);

const URL = 'https://github.com/o/r/actions/runs/7/job/9';

function check(s: Review, name: string, conclusion: string, more: Partial<CiCheck> = {}): CiCheck {
  return { name, conclusion, sha: s.host.head, url: URL, startedAt: '2026-01-01T00:00:00Z', completedAt: '2026-01-01T00:02:00Z', ...more };
}

const gates = (s: Review): GateAttempt[] => new LedgerStore(s.home).load(ref)!.rounds.at(-1)!.gates;

async function started(): Promise<Review> {
  const s = setup();
  await steps(s, ['start', 'o/r#1'], ['diff']);
  return s;
}

test('a passed check is recorded as a ci gate at the head, with its run and times and no log', async () => {
  const s = await started();
  s.host.ci = [check(s, 'test', 'success')];
  const r = await s.rp('gate', 'ci', 'test');
  assert.equal(r.code, 0, r.err);
  const head7 = s.host.head.slice(0, 7);
  assert.equal(r.out.trim(), `gate test attempt 1: pass (ci check "test" success at ${head7}, ${URL})`);
  assert.deepEqual(s.host.checksAsked, [s.host.head]);
  const [g] = gates(s);
  assert.deepEqual({ ...g, at: '' }, {
    name: 'test', attempt: 1, argv: null, exitCode: null, result: 'pass', head: s.host.head, kind: 'ci',
    ci: { check: 'test', conclusion: 'success', url: URL, startedAt: '2026-01-01T00:00:00Z', completedAt: '2026-01-01T00:02:00Z' },
    at: '',
  });
  assert.equal(fs.existsSync(path.join(new LedgerStore(s.home).dirFor(ref), 'logs')), false);
  // The required gate `test` is satisfied by the check alone.
  await steps(s, ['verdict', 'pass', '--summary', 'Checked.'], ['draft']);
  const draft = fs.readFileSync(path.join(new LedgerStore(s.home).dirFor(ref), 'drafts', 'round-1.md'), 'utf8');
  assert.match(draft, new RegExp(`^- ci: test pass at ${head7} \\(${URL}\\), 1 attempt$`, 'm'));
  assert.match((await s.rp('status')).out, /^gates: test pass \(ci, 1 attempt\)$/m);
});

test('failure, cancelled and timed_out are a failed gate: exit 1, and verdict pass is refused', async () => {
  for (const conclusion of ['failure', 'cancelled', 'timed_out', 'error']) {
    const s = await started();
    s.host.ci = [check(s, 'test', conclusion)];
    const r = await s.rp('gate', 'ci', 'test');
    assert.equal(r.code, 1, conclusion);
    assert.match(r.out, new RegExp(`gate test attempt 1: fail \\(ci check "test" ${conclusion} at`));
    assert.equal(gates(s)[0]?.result, 'fail');
    const v = await s.rp('verdict', 'pass', '--summary', 'Checked.');
    assert.equal(v.code, 1);
    assert.match(v.err, /gate test failed/);
  }
});

test('a check that is not finished, or ended without a result, is refused and nothing is recorded', async () => {
  const s = await started();
  for (const [conclusion, why] of [
    ['in_progress', 'is not finished yet \\(in_progress\\)'],
    ['queued', 'is not finished yet \\(queued\\)'],
    ['pending', 'is not finished yet \\(pending\\)'],
    ['skipped', 'ended as skipped, which is no evidence either way'],
    ['neutral', 'ended as neutral, which is no evidence either way'],
    ['something_new', 'ended as something_new, which is no evidence either way'],
  ] as const) {
    s.host.ci = [check(s, 'test', conclusion)];
    const r = await s.rp('gate', 'ci', 'test');
    assert.equal(r.code, 1, conclusion);
    assert.match(r.err, new RegExp(`check "test" ${why}: nothing recorded`));
  }
  assert.equal(gates(s).length, 0);
});

test('a check that ran on another commit than the head of the round is refused', async () => {
  const s = await started();
  const other = 'f'.repeat(40);
  s.host.ci = [check(s, 'test', 'success', { sha: other })];
  const r = await s.rp('gate', 'ci', 'test');
  assert.equal(r.code, 1);
  assert.match(r.err, new RegExp(`check "test" ran at fffffff, not at the round's head ${s.host.head.slice(0, 7)}: nothing recorded`));
  assert.equal(gates(s).length, 0);
  // The round keeps its head when the pull request moves on: the checks asked for are the round's.
  const old = s.host.head;
  s.push('src/b.ts', 'b2\n');
  s.host.ci = [check(s, 'test', 'success')];
  assert.match((await s.rp('gate', 'ci', 'test')).err, new RegExp(`not at the round's head ${old.slice(0, 7)}`));
  assert.deepEqual(s.host.checksAsked, [old, old]);
});

test('the name matches exactly, then ignoring case; a missing or unclear name lists the names', async () => {
  const s = await started();
  s.host.ci = [check(s, 'Test', 'success'), check(s, 'TEST', 'failure'), check(s, 'Lint', 'success')];
  let r = await s.rp('gate', 'ci', 'TEST');
  assert.match(r.out, /gate TEST attempt 1: fail/);
  r = await s.rp('gate', 'ci', 'lint');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /gate Lint attempt 1: pass \(ci check "Lint"/);
  r = await s.rp('gate', 'ci', 'test');
  assert.equal(r.code, 1);
  assert.equal(r.err.trim(), 'reviewproof gate ci: check "test" matches more than one name; say which:\n  - Test\n  - TEST');
  r = await s.rp('gate', 'ci', 'build');
  assert.equal(r.err.trim(), `reviewproof gate ci: no check "build" at the round's head ${s.host.head.slice(0, 7)}; the checks there:\n  - Test\n  - TEST\n  - Lint`);
  s.host.ci = [];
  assert.match((await s.rp('gate', 'ci', 'build')).err, /no checks at the round's head/);
  assert.equal(gates(s).length, 2);
});

test('a check name becomes a gate name, or --as names the gate; the draft shows both', async () => {
  const s = await started();
  s.host.ci = [check(s, 'node / node 24 (windows-latest)', 'success'), check(s, 'CI result', 'success')];
  await steps(s, ['gate', 'ci', 'node / node 24 (windows-latest)'], ['gate', 'ci', 'CI result', '--as', 'test']);
  assert.deepEqual(gates(s).map((g) => [g.name, g.ci?.check]), [
    ['node-node-24-windows-latest', 'node / node 24 (windows-latest)'],
    ['test', 'CI result'],
  ]);
  await steps(s, ['verdict', 'pass', '--summary', 'Checked.'], ['draft']);
  const draft = fs.readFileSync(path.join(new LedgerStore(s.home).dirFor(ref), 'drafts', 'round-1.md'), 'utf8');
  assert.match(draft, /^- ci: test \(check `CI result`\) pass at [0-9a-f]{7} \(https:\S+\), 1 attempt$/m);
  assert.match(draft, /^- ci: node-node-24-windows-latest \(check `node \/ node 24 \(windows-latest\)`\) pass /m);
  const bad = await s.rp('gate', 'ci', 'CI result', '--as', 'a/b');
  assert.match(bad.err, /gate name "a\/b"/);
  s.host.ci = [check(s, '(?)', 'success')];
  assert.match((await s.rp('gate', 'ci', '(?)')).err, /has no letter or digit to name a gate: record it alone with --as NAME/);
});

test('a failed check stays next to the run that passed after it', async () => {
  const s = await started();
  s.host.ci = [check(s, 'test', 'failure')];
  await s.rp('gate', 'ci', 'test');
  s.host.ci = [check(s, 'test', 'success')];
  await steps(s, ['gate', 'ci', 'test'], ['verdict', 'pass', '--summary', 'Checked.'], ['draft']);
  assert.deepEqual(gates(s).map((g) => [g.attempt, g.result]), [[1, 'fail'], [2, 'pass']]);
  const draft = fs.readFileSync(path.join(new LedgerStore(s.home).dirFor(ref), 'drafts', 'round-1.md'), 'utf8');
  assert.match(draft, /^- ci: test pass at [0-9a-f]{7} \(https:\S+\), 2 attempts \(attempt 1 failed\)$/m);
});

test('runs that share a name pass only when all of them passed', async () => {
  const s = await started();
  s.host.ci = [check(s, 'test', 'success'), check(s, 'test', 'failure', { url: `${URL}0` })];
  let r = await s.rp('gate', 'ci', 'test');
  assert.equal(r.code, 1);
  assert.equal(gates(s)[0]?.ci?.url, `${URL}0`);
  s.host.ci = [check(s, 'test', 'in_progress'), check(s, 'test', 'failure')];
  r = await s.rp('gate', 'ci', 'test');
  assert.match(r.err, /is not finished yet/);
});

test('--all records every finished check at the head and names the ones it left out', async () => {
  const s = await started();
  s.host.ci = [
    check(s, 'test', 'success'),
    check(s, 'CI result', 'failure'),
    check(s, 'deploy', 'skipped'),
    check(s, 'e2e', 'in_progress'),
    check(s, 'old', 'success', { sha: 'e'.repeat(40) }),
  ];
  const r = await s.rp('gate', 'ci', '--all');
  assert.equal(r.code, 1);
  assert.deepEqual(gates(s).map((g) => [g.name, g.result]), [['test', 'pass'], ['CI-result', 'fail']]);
  assert.match(r.out, /^not recorded: deploy ended as skipped, which is no evidence either way$/m);
  assert.match(r.out, /^not recorded: e2e is not finished yet \(in_progress\)$/m);
  assert.match(r.out, /^not recorded: old ran at eeeeeee, not at the round's head/m);

  s.host.ci = [check(s, 'test', 'success')];
  assert.equal((await s.rp('gate', 'ci', '--all')).code, 0);
  s.host.ci = [check(s, 'e2e', 'queued')];
  assert.match((await s.rp('gate', 'ci', '--all')).err, /no finished check at the round's head [0-9a-f]{7}:\n {2}- e2e is not finished yet/);
  s.host.ci = [check(s, 'a b', 'success'), check(s, 'a/b', 'success')];
  assert.match((await s.rp('gate', 'ci', '--all')).err, /would share a gate name; record each alone with --as NAME:\n {2}- a b\n {2}- a\/b/);
  assert.match((await s.rp('gate', 'ci', '--all', '--as', 'x')).err, /--as names one gate/);
  assert.match((await s.rp('gate', 'ci', 'test', '--all')).err, /unexpected argument "test"/);
  assert.match((await s.rp('gate', 'ci')).err, /missing <check>/);
  assert.equal(gates(s).length, 3);
});

test('what the host sends is kept to one line, without token values, with a web link only', async () => {
  const s = await started();
  process.env.TEST_TOKEN = 's3cr3t-value';
  try {
    s.host.ci = [check(s, 'test\n## s3cr3t-value', 'success', { url: 'javascript:alert(1)' })];
    await steps(s, ['gate', 'ci', '--all']);
  } finally {
    delete process.env.TEST_TOKEN;
  }
  const [g] = gates(s);
  assert.equal(g?.ci?.check, 'test ## ***');
  assert.equal(g?.ci?.url, undefined);
  assert.equal(g?.name, 'test');
});

test('a host whose checks are not read says so', async () => {
  const s = await started();
  (s.host as Host).checks = undefined;
  const r = await s.rp('gate', 'ci', 'test');
  assert.equal(r.code, 1);
  assert.match(r.err, /only GitHub checks are read: record this gate with gate run or gate skip/);
});

test('SARIF carries the check of a ci gate', async () => {
  const s = await started();
  s.host.ci = [check(s, 'test', 'success')];
  await steps(s, ['gate', 'ci', 'test']);
  const sarif = toSarif(new LedgerStore(s.home).load(ref)!, '0') as {
    runs: { invocations: { executionSuccessful: boolean; properties: { ci?: { url: string } } }[] }[];
  };
  assert.equal(sarif.runs[0]?.invocations[0]?.executionSuccessful, true);
  assert.equal(sarif.runs[0]?.invocations[0]?.properties.ci?.url, URL);
});

const gh: PrRef = { host: 'github', hostname: 'ghe.corp.io', project: 'o/r', number: 12 };

test('GitHub checks reads check runs and commit statuses of the commit, page by page', async () => {
  const calls: string[] = [];
  const run = (n: number) => ({
    name: `job ${n}`, status: 'completed', conclusion: 'success', head_sha: 'h1',
    html_url: `https://x/${n}`, started_at: 's', completed_at: 'c',
  });
  const host = new GitHub((argv) => {
    assert.deepEqual(argv.slice(0, 3), ['api', '--hostname', 'ghe.corp.io']);
    const url = argv[3] ?? '';
    calls.push(url);
    if (url.includes('/check-runs?') && url.endsWith('page=1')) {
      return JSON.stringify({ check_runs: Array.from({ length: 100 }, (_, i) => run(i)) });
    }
    if (url.includes('/check-runs?')) {
      return JSON.stringify({
        check_runs: [
          { name: 'slow', status: 'in_progress', conclusion: null, head_sha: 'h1', html_url: null, started_at: 's', completed_at: null },
        ],
      });
    }
    return JSON.stringify({
      sha: 'h1',
      state: 'pending',
      statuses: [
        { context: 'legacy/ci', state: 'failure', target_url: 'https://ci/1', created_at: 'a', updated_at: 'b' },
        { context: 'legacy/wait', state: 'pending', target_url: null, created_at: 'a', updated_at: 'b' },
      ],
    });
  });
  const got = await host.checks(gh, 'h1');
  assert.deepEqual(calls, [
    'repos/o/r/commits/h1/check-runs?per_page=100&page=1',
    'repos/o/r/commits/h1/check-runs?per_page=100&page=2',
    'repos/o/r/commits/h1/status?per_page=100&page=1',
  ]);
  assert.equal(got.length, 103);
  assert.deepEqual(got[0], { name: 'job 0', conclusion: 'success', sha: 'h1', url: 'https://x/0', startedAt: 's', completedAt: 'c' });
  assert.deepEqual(got.slice(100), [
    { name: 'slow', conclusion: 'in_progress', sha: 'h1', startedAt: 's' },
    { name: 'legacy/ci', conclusion: 'failure', sha: 'h1', url: 'https://ci/1', startedAt: 'a', completedAt: 'b' },
    { name: 'legacy/wait', conclusion: 'pending', sha: 'h1', startedAt: 'a' },
  ]);
});
