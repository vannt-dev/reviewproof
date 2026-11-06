import path from 'node:path';
import { changedFiles } from '../diff.ts';
import { captureGate, notChecked, recordGate } from '../gates.ts';
import type { ReadMark } from '../types.ts';
import {
  assertOpen, count, git, locked, openReview, saveChange, str, take, type Command, type Review,
} from './context.ts';

// Paths are repo-relative, as status and coverage print them; a Windows backslash or ./ is fine.
const repoPath = (file: string): string => file.replace(/\\/g, '/').replace(/^\.\//, '');

// A diff, read or skip of a file the round did not change counts for nothing, so it is refused.
// No files named means all the changed ones.
function changedOnly(r: Review, files: string[]): string[] {
  const names = changedFiles(r.checkout, r.round.from, r.round.head).map((f) => f.file);
  const wanted = files.map(repoPath);
  const other = wanted.filter((f) => !names.includes(f));
  if (other.length > 0) throw new Error(`not changed in round ${r.round.n}: ${other.join(', ')}`);
  return wanted.length > 0 ? wanted : names;
}

const gateRun: Command = {
  args: '<name> -- <command...>',
  about: 'run a gate (no shell) and keep its log; exit 1 when it failed',
  tail: true,
  async run(env, a) {
    const [name] = take(a, '<name>');
    if (a.tail.length === 0) throw new Error('the gate command goes after --');
    const seen = assertOpen(openReview(env));
    // The command may take minutes, so it runs before the lock; other commands go on meanwhile.
    const ran = captureGate(a.tail, env.cwd);
    const g = locked(env, seen, (r) => {
      const g = recordGate(env.store, r.ref, assertOpen(r).round, name, ran);
      saveChange(env, r);
      return g;
    });
    const log = path.join(env.store.dirFor(seen.ref), g.log ?? '');
    console.log(`gate ${name} attempt ${g.attempt}: ${g.result} (exit code ${g.exitCode ?? 'none'}), log ${log}`);
    return g.result === 'pass' ? 0 : 1;
  },
};

const gateSkip: Command = {
  args: '<name> --reason R',
  about: 'record a gate as not checked (verdict pass still refuses it)',
  options: { reason: { type: 'string' } },
  async run(env, a) {
    const [name] = take(a, '<name>');
    const g = locked(env, openReview(env), (r) => {
      const g = notChecked(assertOpen(r).round, name, str(a, 'reason') ?? '');
      saveChange(env, r);
      return g;
    });
    console.log(`gate ${name} attempt ${g.attempt}: not checked (${g.reason})`);
    return 0;
  },
};

const diff: Command = {
  args: '[files...]',
  about: 'print the round diff (all files, or those named) and count them read',
  async run(env, a) {
    const seen = openReview(env);
    const files = changedOnly(seen, a.positionals);
    // The same flags as the coverage diff: readable names, no user diff drivers.
    const args = ['-c', 'core.quotepath=false', 'diff', '-M', '--no-color', '--no-ext-diff', '--no-textconv'];
    args.push(seen.round.from, seen.round.head);
    if (a.positionals.length > 0) args.push('--', ...files);
    const text = git(seen.checkout, args);
    if (text !== '') console.log(text.replace(/\n$/, ''));
    const at = env.now().toISOString();
    // A large diff prints outside the lock; only counting the reads waits for it.
    locked(env, seen, (r) => {
      r.round.reads.push(...files.map((file): ReadMark => ({ file, via: 'diff', at })));
      env.store.save(r.ledger);
    });
    console.log(`reviewproof: ${count(files.length, 'changed file')} counted as read`);
    return 0;
  },
};

function lineRange(text: string): [number, number] {
  const m = /^(\d+)-(\d+)$/.exec(text);
  const range: [number, number] = [Number(m?.[1]), Number(m?.[2])];
  if (!m || range[0] < 1 || range[1] < range[0]) throw new Error(`--lines "${text}" must be a-b with 1 <= a <= b`);
  return range;
}

const read: Command = {
  args: '<file> [--lines a-b]',
  about: 'count a changed file, or some of its lines, read elsewhere',
  options: { lines: { type: 'string' } },
  async run(env, a) {
    const file = repoPath(take(a, '<file>')[0]);
    const lines = str(a, 'lines');
    locked(env, openReview(env), (r) => {
      changedOnly(r, [file]);
      const mark: ReadMark = { file, via: 'manual', at: env.now().toISOString() };
      if (lines !== undefined) mark.range = lineRange(lines);
      r.round.reads.push(mark);
      env.store.save(r.ledger);
    });
    console.log(`read ${file}${lines === undefined ? '' : ` lines ${lines}`}`);
    return 0;
  },
};

const skip: Command = {
  args: '<file> --reason R',
  about: 'leave a changed file out of coverage',
  options: { reason: { type: 'string' } },
  async run(env, a) {
    const file = repoPath(take(a, '<file>')[0]);
    const reason = (str(a, 'reason') ?? '').trim();
    if (reason === '') throw new Error('skip needs --reason');
    locked(env, openReview(env), (r) => {
      changedOnly(assertOpen(r), [file]);
      r.round.skips = [...r.round.skips.filter((s) => s.file !== file), { file, reason }];
      saveChange(env, r);
    });
    console.log(`skipped ${file}: ${reason}`);
    return 0;
  },
};

export const checks: Record<string, Command> = { 'gate run': gateRun, 'gate skip': gateSkip, diff, read, skip };
