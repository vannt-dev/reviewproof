import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LedgerStore } from '../src/store.ts';
import { allReads } from '../src/reads.ts';
import { setActive } from '../src/active.ts';
import { handleHook } from '../src/hook.ts';
import { startRound } from '../src/rounds.ts';
import type { PrRef } from '../src/types.ts';

const tmp: string[] = [];
function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-shell-'));
  tmp.push(d);
  return d;
}
test.after(() => {
  for (const d of tmp) fs.rmSync(d, { recursive: true, force: true });
});

const ref: PrRef = { host: 'github', hostname: 'github.com', project: 'o/r', number: 1 };
const text = Array.from({ length: 50 }, (_, i) => `const v${i + 1} = ${i + 1};`).join('\n') + '\n';
const linesOf = (a: number, b: number): string =>
  Array.from({ length: b - a + 1 }, (_, i) => `const v${a + i} = ${a + i};`).join('\n');

function setup(): { home: string; checkout: string; store: LedgerStore } {
  const home = tmpDir();
  const checkout = path.join(tmpDir(), 'Checkout');
  fs.mkdirSync(path.join(checkout, 'src'), { recursive: true });
  fs.mkdirSync(path.join(checkout, '.git'));
  fs.writeFileSync(path.join(checkout, 'src', 'a.ts'), text);
  fs.writeFileSync(path.join(checkout, 'src', 'b.ts'), 'one\ntwo\n');
  const store = new LedgerStore(home);
  store.save(startRound(null, ref, { url: 'u', title: 't', head: 'h1', base: 'b' }, 'b', new Date(0), false));
  setActive(home, checkout, ref);
  return { home, checkout, store };
}

function reads(s: { store: LedgerStore }) {
  const round = s.store.load(ref)!.rounds[0]!;
  return allReads(s.store, ref, round).map((r) => [r.file, r.range, r.via, r.agent]);
}

// Claude Code's PostToolUse for its Bash and PowerShell tools.
const claude = (command: string, stdout: string, cwd: string, extra: Record<string, unknown> = {}, tool = 'Bash') => ({
  hook_event_name: 'PostToolUse',
  tool_name: tool,
  tool_input: { command, description: 'd' },
  tool_response: { stdout, stderr: '', interrupted: false, isImage: false, noOutputExpected: false, ...extra },
  cwd,
});

// Codex's PostToolUse for a shell command: the model-facing output as a string.
const codex = (command: string, output: string, cwd: string, extra: Record<string, unknown> = {}) => ({
  session_id: 's',
  turn_id: 't',
  transcript_path: null,
  cwd,
  hook_event_name: 'PostToolUse',
  model: 'm',
  permission_mode: 'default',
  tool_name: 'Bash',
  tool_input: { command },
  tool_response: output,
  tool_use_id: 'c1',
  ...extra,
});

test('a Bash sed -n inside the checkout records the lines it printed', () => {
  const s = setup();
  assert.equal(handleHook(claude("sed -n '10,20p' src/a.ts", linesOf(10, 20), s.checkout), s.home), null);
  assert.deepEqual(reads(s), [['src/a.ts', [10, 20], 'hook', undefined]]);
});

test('cat of a whole file, cat -n | head, and two files in one command', () => {
  const s = setup();
  handleHook(claude('cat src/a.ts', text.trimEnd(), s.checkout), s.home);
  const numbered = linesOf(1, 3).split('\n').map((l, i) => `     ${i + 1}\t${l}`).join('\n');
  handleHook(claude('cat -n src/a.ts | head -n 3', numbered, s.checkout), s.home);
  handleHook(claude('cat src/b.ts src/a.ts', `one\ntwo\n${linesOf(1, 50)}`, s.checkout), s.home);
  assert.deepEqual(reads(s), [
    ['src/a.ts', [1, 50], 'hook', undefined],
    ['src/a.ts', [1, 3], 'hook', undefined],
    ['src/b.ts', [1, 2], 'hook', undefined],
    ['src/a.ts', [1, 50], 'hook', undefined],
  ]);
});

test('output that is not the file content, or not all shown, records only what was shown', () => {
  const s = setup();
  handleHook(claude('cat src/a.ts | grep v1', 'const v1 = 1;', s.checkout), s.home);
  handleHook(claude('cat src/missing.ts', '', s.checkout), s.home);
  handleHook(claude('cat src/a.ts', linesOf(1, 50), s.checkout, { persistedOutputPath: 'x.txt', persistedOutputSize: 9 }), s.home);
  handleHook(claude('cat src/a.ts', linesOf(1, 50), s.checkout, { interrupted: true }), s.home);
  handleHook(claude('head -n 5 src/a.ts', 'something else', s.checkout), s.home);
  assert.deepEqual(reads(s), []);
  // An output cut off part way: the whole lines before the cut.
  handleHook(claude('cat src/a.ts', `${linesOf(1, 4)}\nconst v5`, s.checkout), s.home);
  assert.deepEqual(reads(s), [['src/a.ts', [1, 4], 'hook', undefined]]);
});

test('relative to the hook cwd, after a cd, or absolute; files outside a review are left alone', () => {
  const s = setup();
  handleHook(claude('cd src && head -n 2 b.ts', 'one\ntwo', s.checkout), s.home);
  handleHook(claude(`tail -n 1 "${path.join(s.checkout, 'src', 'b.ts')}"`, 'two', os.tmpdir()), s.home);
  handleHook(claude('head -n 1 b.ts', 'one', path.join(s.checkout, 'src')), s.home);
  handleHook(claude('cd src && head -n 1 b.ts', 'one', path.join(s.checkout, 'src')), s.home);
  const outside = path.join(tmpDir(), 'x.ts');
  fs.writeFileSync(outside, 'one\n');
  handleHook(claude(`cat "${outside}"`, 'one', s.checkout), s.home);
  assert.deepEqual(reads(s), [
    ['src/b.ts', [1, 2], 'hook', undefined],
    ['src/b.ts', [2, 2], 'hook', undefined],
    ['src/b.ts', [1, 1], 'hook', undefined],
    ['src/b.ts', [1, 1], 'hook', undefined],
  ]);
});

test('git show rev:path is relative to the repository root and checked against the file', () => {
  const s = setup();
  handleHook(claude('git show HEAD:src/b.ts', 'one\ntwo', path.join(s.checkout, 'src')), s.home);
  handleHook(claude('git show HEAD~3:src/a.ts', 'const v1 = 0;\nold', s.checkout), s.home);
  assert.deepEqual(reads(s), [['src/b.ts', [1, 2], 'hook', undefined]]);
});

test("Claude Code's PowerShell tool: Get-Content with CRLF output", () => {
  const s = setup();
  const out = linesOf(11, 12).replace(/\n/g, '\r\n');
  handleHook(claude('Get-Content -Path src/a.ts | Select-Object -Skip 10 -First 2', out, s.checkout, {}, 'PowerShell'), s.home);
  handleHook(claude('Get-Content src/b.ts -TotalCount 1', 'one', s.checkout, {}, 'PowerShell'), s.home);
  assert.deepEqual(reads(s), [
    ['src/a.ts', [11, 12], 'hook', undefined],
    ['src/b.ts', [1, 1], 'hook', undefined],
  ]);
});

test('a helper agent read carries its agent id', () => {
  const s = setup();
  handleHook(claude('head -n 1 src/b.ts', 'one', s.checkout, {}, 'Bash'), s.home);
  handleHook({ ...claude('tail -n 1 src/b.ts', 'two', s.checkout), agent_id: 'helper-1' }, s.home);
  assert.deepEqual(reads(s), [
    ['src/b.ts', [1, 1], 'hook', undefined],
    ['src/b.ts', [2, 2], 'hook', 'helper-1'],
  ]);
});

test('Codex: a string tool_response, both shell dialects, and its truncated output', () => {
  const s = setup();
  handleHook(codex("nl -ba src/a.ts | sed -n '5,7p'", linesOf(5, 7).split('\n').map((l, i) => `     ${i + 5}\t${l}`).join('\n'), s.checkout), s.home);
  handleHook(codex('Get-Content src/b.ts -Tail 1', 'two\r\n', s.checkout), s.home);
  const cut = `Warning: truncated output (original token count: 900)\n\n${linesOf(1, 6)}\nconst v…80 tokens truncated…50;`;
  handleHook(codex('cat src/a.ts', cut, s.checkout), s.home);
  handleHook(codex('head -n 1 src/b.ts', 'one', s.checkout, { agent_id: 'sub-1' }), s.home);
  assert.deepEqual(reads(s), [
    ['src/a.ts', [5, 7], 'hook', undefined],
    ['src/b.ts', [2, 2], 'hook', undefined],
    ['src/a.ts', [1, 6], 'hook', undefined],
    ['src/b.ts', [1, 1], 'hook', 'sub-1'],
  ]);
});

test('Git Bash /c/... paths name Windows files', { skip: process.platform !== 'win32' }, () => {
  const s = setup();
  const file = path.join(s.checkout, 'src', 'b.ts').replace(/\\/g, '/');
  const bash = `/${file[0]!.toLowerCase()}${file.slice(2)}`;
  handleHook(claude(`head -n 2 ${bash}`, 'one\ntwo', 'C:/'), s.home);
  assert.deepEqual(reads(s), [['src/b.ts', [1, 2], 'hook', undefined]]);
});

test('a shell PostToolUse never answers and never throws', () => {
  const s = setup();
  for (const e of [
    claude('cat src/a.ts', text, s.checkout, { stdout: 42 }),
    { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 7 } },
    { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'cat src/a.ts' }, tool_response: null },
    claude('cat src/a.ts', text, 42 as unknown as string),
    codex('cat src/a.ts', text, s.checkout, { cwd: undefined }),
  ]) {
    assert.equal(handleHook(e, s.home), null);
  }
  assert.deepEqual(reads(s), []);
});
