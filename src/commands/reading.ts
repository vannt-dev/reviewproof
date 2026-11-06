import { changedFiles, parseDiff } from '../diff.ts';
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

interface FileDiff {
  file: string;
  text: string;
}

// Each file's diff starts at its "diff --git" line (hunk lines never do), and is named the way
// coverage names it.
function perFile(text: string): FileDiff[] {
  const parts = text.split(/^(?=diff --git )/m).filter((t) => t.startsWith('diff --git '));
  return parts.flatMap((t) => parseDiff(t).map((f) => ({ file: f.file, text: t })));
}

// What an agent's tool shows of one call's output is cut short, and a file cut short was not read.
// Files print in order while they fit; one that does not waits for a call of its own. When none
// fits, the first prints alone, so every call moves on (a file asked for alone always prints).
function fit(files: FileDiff[]): { shown: FileDiff[]; left: string[] } {
  const budget = Number(process.env.REVIEWPROOF_DIFF_BUDGET) || 25000;
  const shown: FileDiff[] = [];
  let used = 0;
  for (const f of files) {
    if (used + f.text.length > budget) continue;
    shown.push(f);
    used += f.text.length;
  }
  if (shown.length === 0 && files[0]) shown.push(files[0]);
  return { shown, left: files.filter((f) => !shown.includes(f)).map((f) => f.file) };
}

const diff: Command = {
  args: '[files...]',
  about: 'print the round diff (all files, or those named) and count the printed files read',
  async run(env, a) {
    const seen = assertOpen(openReview(env));
    const files = changedOnly(seen, a.positionals);
    // The same flags as the coverage diff: readable names, no user diff drivers.
    const args = ['-c', 'core.quotepath=false', 'diff', '-M', '--no-color', '--no-ext-diff', '--no-textconv'];
    args.push(seen.round.from, seen.round.head);
    if (a.positionals.length > 0) args.push('--', ...files);
    const { shown, left } = fit(perFile(git(seen.checkout, args)));
    if (shown.length > 0) console.log(shown.map((f) => f.text).join('').replace(/\n$/, ''));
    const at = env.now().toISOString();
    // A large diff prints outside the lock; only counting the reads waits for it.
    locked(env, seen, (r) => {
      assertOpen(r).round.reads.push(...shown.map((f): ReadMark => ({ file: f.file, via: 'diff', at })));
      env.store.save(r.ledger);
    });
    console.log(`reviewproof: ${count(shown.length, 'changed file')} counted as read`);
    if (left.length > 0) {
      console.error(`not shown (too long for one call): ${left.join(', ')} — run reviewproof diff ${left.join(' ')}`);
    }
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
      changedOnly(assertOpen(r), [file]);
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

/** What counts as read: the diff printed, reads declared, files left out. */
export const reading: Record<string, Command> = { diff, read, skip };
