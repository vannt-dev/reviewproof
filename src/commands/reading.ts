import { changedFiles, parseDiff } from '../diff.ts';
import type { ReadMark } from '../types.ts';
import {
  assertOpen, count, coverageOf, git, locked, openReview, saveChange, str, take, type Command, type Review,
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
  deleted: boolean;
}

// Each file's diff starts at its "diff --git" line (hunk lines never do), and is named the way
// coverage names it.
function perFile(text: string): FileDiff[] {
  const parts = text.split(/^(?=diff --git )/m).filter((t) => t.startsWith('diff --git '));
  return parts.flatMap((t) => parseDiff(t).map((f) => ({ file: f.file, text: t, deleted: f.status === 'D' })));
}

// What an agent's tool shows of one call's output is cut short, and a file cut short was not read.
// Files print in order while they fit. One that would fit a later call waits for it; one larger than
// the whole budget is never printed (not even alone), so it can only be read in parts, which record themselves.
const budget = (): number => Number(process.env.REVIEWPROOF_DIFF_BUDGET) || 25000;

function fit(files: FileDiff[]): { shown: FileDiff[]; later: string[]; tooLarge: FileDiff[] } {
  const limit = budget();
  const shown: FileDiff[] = [];
  const later: string[] = [];
  const tooLarge: FileDiff[] = [];
  let used = 0;
  for (const f of files) {
    if (f.text.length > limit) tooLarge.push(f);
    else if (used + f.text.length > limit) later.push(f.file);
    else {
      shown.push(f);
      used += f.text.length;
    }
  }
  return { shown, later, tooLarge };
}

const diff: Command = {
  args: '[files...]',
  about: 'print the round diff (all files, or those named) and count the printed files read',
  async run(env, a) {
    const seen = assertOpen(openReview(env));
    const named = a.positionals.length > 0;
    // A bare diff leaves out skipped files (config globs and explicit skips): they need no reading.
    const skipped = new Set(coverageOf(env, seen).skipped.map((f) => f.file));
    const all = changedOnly(seen, a.positionals);
    const files = named ? all : all.filter((f) => !skipped.has(f));
    // The same flags as the coverage diff: readable names, no user diff drivers.
    const args = ['-c', 'core.quotepath=false', 'diff', '-M', '--no-color', '--no-ext-diff', '--no-textconv'];
    args.push(seen.round.from, seen.round.head);
    if (files.length < all.length || named) args.push('--', ...files);
    const { shown, later, tooLarge } = fit(files.length === 0 ? [] : perFile(git(seen.checkout, args)));
    if (shown.length > 0) console.log(shown.map((f) => f.text).join('').replace(/\n$/, ''));
    const at = env.now().toISOString();
    // A large diff prints outside the lock; only counting the reads waits for it.
    locked(env, seen, (r) => {
      assertOpen(r).round.reads.push(...shown.map((f): ReadMark => ({ file: f.file, via: 'diff', at })));
      env.store.save(r.ledger);
    });
    console.log(`reviewproof: ${count(shown.length, 'changed file')} counted as read`);
    if (later.length > 0) {
      console.error(`not shown (too long for one call): ${later.join(', ')} — run reviewproof diff ${later.join(' ')}`);
    }
    for (const { file, deleted } of tooLarge) {
      console.error(
        deleted
          ? `${file}: deleted, and its diff is larger than one call can show; print its old content ` +
              `with reviewproof read ${file} (--lines a-b for a part)`
          : `${file}: its diff is larger than one call can show; open it with Read in parts ` +
              `(each part is recorded) or print it in parts with reviewproof read ${file} --lines a-b`,
      );
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

// What `read` prints: the file at the round head (its old content at the round's start when the
// round deleted it), numbered, for the lines asked; null text for a binary or an empty file.
function shown(r: Review, file: string, want: [number, number] | null) {
  const changed = changedFiles(r.checkout, r.round.from, r.round.head).find((f) => f.file === file);
  const deleted = changed?.status === 'D';
  const sha = deleted ? r.round.from : r.round.head;
  const label = `${file}${deleted ? ' (deleted)' : ''} at ${sha.slice(0, 7)}`;
  if (changed?.binary) return { label: `${label}: a binary file, nothing to print`, range: null, text: null };
  const content = git(r.checkout, ['cat-file', 'blob', `${sha}:${file}`]);
  const lines = content === '' ? [] : content.replace(/\n$/, '').split('\n');
  if (lines.length === 0) return { label: `${label}: an empty file, nothing to print`, range: null, text: null };
  const [a, b] = want ?? [1, lines.length];
  if (a > lines.length) throw new Error(`--lines ${a}-${b}: ${file} has ${lines.length} lines`);
  const range: [number, number] = [a, Math.min(b, lines.length)];
  const body = lines.slice(range[0] - 1, range[1]).map((l, i) => `${range[0] + i}\t${l}`).join('\n');
  return { label: `${label}, lines ${range[0]}-${range[1]} of ${lines.length}`, range, text: body };
}

// Counted as read only once printed here: a file is never recorded as read without being shown.
const read: Command = {
  args: '<file> [--lines a-b]',
  about: 'print a changed file (or some of its lines) at the round head and count it read',
  options: { lines: { type: 'string' } },
  async run(env, a) {
    const file = repoPath(take(a, '<file>')[0]);
    const lines = str(a, 'lines');
    const want = lines === undefined ? null : lineRange(lines);
    const seen = assertOpen(openReview(env));
    changedOnly(seen, [file]);
    const s = shown(seen, file, want);
    if (s.text !== null && s.range && s.text.length > budget()) {
      throw new Error(`${file} lines ${s.range[0]}-${s.range[1]} are larger than one call can show: read fewer with --lines a-b`);
    }
    console.log(s.text === null ? s.label : `${s.label}\n${s.text}`);
    locked(env, seen, (r) => {
      const mark: ReadMark = { file, via: 'manual', at: env.now().toISOString() };
      // A whole read of all lines stays a whole read, as before; a part keeps its range.
      if (want !== null && s.range) mark.range = s.range;
      assertOpen(r).round.reads.push(mark);
      env.store.save(r.ledger);
    });
    console.log(`read ${file}${want !== null && s.range ? ` lines ${s.range[0]}-${s.range[1]}` : ''}`);
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
