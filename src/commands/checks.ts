import path from 'node:path';
import { changedFiles } from '../diff.ts';
import { notChecked, runGate } from '../gates.ts';
import type { ReadMark } from '../types.ts';
import {
  count, git, openForChange, openReview, saveChange, str, take, type Command, type Review,
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
    const r = openForChange(env);
    const g = runGate(env.store, r.ref, r.round, name, a.tail, env.cwd);
    saveChange(env, r);
    const log = path.join(env.store.dirFor(r.ref), g.log ?? '');
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
    const r = openForChange(env);
    const g = notChecked(r.round, name, str(a, 'reason') ?? '');
    saveChange(env, r);
    console.log(`gate ${name} attempt ${g.attempt}: not checked (${g.reason})`);
    return 0;
  },
};

const diff: Command = {
  args: '[files...]',
  about: 'print the round diff (all files, or those named) and count them read',
  async run(env, a) {
    const r = openReview(env);
    const files = changedOnly(r, a.positionals);
    // The same flags as the coverage diff: readable names, no user diff drivers.
    const args = ['-c', 'core.quotepath=false', 'diff', '-M', '--no-color', '--no-ext-diff', '--no-textconv'];
    args.push(r.round.from, r.round.head);
    if (a.positionals.length > 0) args.push('--', ...files);
    const text = git(r.checkout, args);
    if (text !== '') console.log(text.replace(/\n$/, ''));
    const at = env.now().toISOString();
    r.round.reads.push(...files.map((file): ReadMark => ({ file, via: 'diff', at })));
    env.store.save(r.ledger);
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
    const r = openReview(env);
    changedOnly(r, [file]);
    const lines = str(a, 'lines');
    const mark: ReadMark = { file, via: 'manual', at: env.now().toISOString() };
    if (lines !== undefined) mark.range = lineRange(lines);
    r.round.reads.push(mark);
    env.store.save(r.ledger);
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
    const r = openForChange(env);
    changedOnly(r, [file]);
    r.round.skips = [...r.round.skips.filter((s) => s.file !== file), { file, reason }];
    saveChange(env, r);
    console.log(`skipped ${file}: ${reason}`);
    return 0;
  },
};

export const checks: Record<string, Command> = { 'gate run': gateRun, 'gate skip': gateSkip, diff, read, skip };
