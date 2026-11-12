import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LedgerStore } from '../src/store.ts';
import { allReads } from '../src/reads.ts';
import { activeFor, setActive } from '../src/active.ts';
import { handleHook } from '../src/hook.ts';
import { startRound } from '../src/rounds.ts';
import type { PrRef } from '../src/types.ts';

const tmp: string[] = [];
function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-hook-'));
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

const read = (file: string, extra: Record<string, unknown> = {}, response: unknown = 'ok') => ({
  hook_event_name: 'PostToolUse',
  tool_name: 'Read',
  tool_input: { file_path: file, ...extra },
  tool_response: response,
});

function reads(s: { store: LedgerStore }) {
  const round = s.store.load(ref)!.rounds[0]!;
  return allReads(s.store, ref, round);
}

test('a Read in another case with backslashes records the relative path', () => {
  const s = setup();
  const odd = path.join(s.checkout, 'src', 'A.ts').toUpperCase().replace(/\//g, '\\');
  const lowerOnly = process.platform === 'win32' ? odd : path.join(s.checkout, 'src', 'A.ts');
  assert.equal(handleHook(read(lowerOnly), s.home), null);
  const r = reads(s);
  assert.equal(r.length, 1);
  assert.equal(r[0]?.file, 'src/A.ts');
  assert.equal(r[0]?.via, 'hook');
  assert.deepEqual(r[0]?.range, [1, 2000]); // a Read with no offset or limit shows the first 2000 lines
});

test('offset and limit become a 1-based inclusive range', () => {
  const s = setup();
  handleHook(read(path.join(s.checkout, 'src', 'A.ts'), { offset: 10, limit: 20 }), s.home);
  assert.deepEqual(reads(s)[0]?.range, [10, 29]);
});

test('only an offset reads up to the default limit of 2000 lines', () => {
  const s = setup();
  handleHook(read(path.join(s.checkout, 'src', 'A.ts'), { offset: 10 }), s.home);
  assert.deepEqual(reads(s)[0]?.range, [10, 2009]);
});

test('limit 1 reads one line only; a limit below 1 records nothing', () => {
  const s = setup();
  const f = path.join(s.checkout, 'src', 'A.ts');
  handleHook(read(f, { limit: 1 }), s.home);
  assert.deepEqual(reads(s)[0]?.range, [1, 1]);
  handleHook(read(f, { limit: 0 }), s.home);
  assert.equal(reads(s).length, 1);
});

test('a PARTIAL view response marks the read partial, an object response too', () => {
  const s = setup();
  const f = path.join(s.checkout, 'src', 'A.ts');
  handleHook(read(f, {}, 'PARTIAL view of the file'), s.home);
  handleHook(read(f, {}, { content: 'PARTIAL view' }), s.home);
  assert.deepEqual(reads(s).map((m) => m.partial), [true, true]);
});

test('agent_id is recorded as agent', () => {
  const s = setup();
  const ev = { ...read(path.join(s.checkout, 'src', 'A.ts')), agent_id: 'a1' };
  handleHook(ev, s.home);
  assert.equal(reads(s)[0]?.agent, 'a1');
});

test('a Read outside any active checkout records nothing', () => {
  const s = setup();
  const outside = path.join(tmpDir(), 'B.ts');
  assert.equal(handleHook(read(outside), s.home), null);
  assert.equal(reads(s).length, 0);
});

test('the hook leaves ledger.json untouched', () => {
  const s = setup();
  const file = path.join(s.store.dirFor(ref), 'ledger.json');
  const before = fs.readFileSync(file, 'utf8');
  handleHook(read(path.join(s.checkout, 'src', 'A.ts')), s.home);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('allReads skips malformed lines', () => {
  const s = setup();
  const dir = path.join(s.store.dirFor(ref), 'reads');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'round-1.jsonl'), 'not json\n{"file":"a","via":"hook","at":"t"}\n');
  assert.deepEqual(reads(s).map((m) => m.file), ['a']);
});

test('a Bash or PowerShell reviewproof post is denied, other commands are not', () => {
  const s = setup();
  const bash = (command: string, tool = 'Bash') => ({
    hook_event_name: 'PreToolUse',
    tool_name: tool,
    tool_input: { command },
  });
  const out = handleHook(bash('npx reviewproof post --approved-by me'), s.home);
  assert.deepEqual(JSON.parse(out ?? ''), {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason:
        'Only the person posts: run reviewproof post --approved-by <name> in your own terminal, outside Claude Code',
    },
  });
  assert.notEqual(handleHook(bash('node dist/reviewproof.js post', 'PowerShell'), s.home), null);
  assert.equal(handleHook(bash('reviewproof status'), s.home), null);
  assert.equal(handleHook(bash('reviewproof poster'), s.home), null);
});

test('every spelling of the post command is denied', () => {
  const s = setup();
  const denied = (command: string): boolean =>
    handleHook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } }, s.home) !== null;
  for (const c of [
    'npx reviewproof@0.1.0 post --approved-by me',
    'npx -y reviewproof@latest post',
    'node "C:\\tools\\reviewproof.js" post --approved-by me',
    'reviewproof.cmd post',
    'reviewproof.ps1 post',
    'REVIEWPROOF POST',
    'reviewproof -x post',
    'reviewproof post --approved-by me',
    'reviewproof post --inline --approved-by me',
    'reviewproof post --new-comment --approved-by me',
  ]) assert.equal(denied(c), true, c);
  for (const c of [
    'reviewproof status',
    'reviewproof poster',
    'reviewproof diff post.ts',
    'reviewproof verdict not-yet --summary "the POST handler skips validation"',
    'reviewproof verdict pass --summary "Ready to post"',
    'reviewproof add --title "blog post body unescaped"',
    'reviewproof read post',
    'reviewproof status && curl -X POST https://x',
  ]) {
    assert.equal(denied(c), false, c);
  }
});

test('malformed or unknown events return null', () => {
  const s = setup();
  assert.equal(handleHook(null, s.home), null);
  assert.equal(handleHook('{bad', s.home), null);
  assert.equal(handleHook({ hook_event_name: 'PostToolUse', tool_name: 'Read' }, s.home), null);
});

test('activeFor picks the longest nested checkout', () => {
  const home = tmpDir();
  const outer = tmpDir();
  const inner = path.join(outer, 'inner');
  fs.mkdirSync(inner);
  const other: PrRef = { ...ref, number: 2 };
  setActive(home, outer, ref);
  setActive(home, inner, other);
  assert.equal(activeFor(home, path.join(inner, 'x.ts'))?.ref.number, 2);
  assert.equal(activeFor(home, path.join(outer, 'x.ts'))?.ref.number, 1);
  assert.equal(activeFor(home, inner)?.ref.number, 2); // the checkout folder itself (CLI commands)
});

// macOS tmp is a link (/var -> /private/var), Windows runners use 8.3 names: a not-yet-existing
// file must still match the checkout stored under the real spelling.
test('activeFor matches a missing file reached through a link or junction', () => {
  const home = tmpDir();
  const real = tmpDir();
  const alias = path.join(tmpDir(), 'alias');
  fs.symlinkSync(real, alias, 'junction');
  setActive(home, real, ref);
  assert.equal(activeFor(home, path.join(alias, 'new', 'later.ts'))?.ref.number, 1);
});
