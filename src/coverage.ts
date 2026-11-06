import type { ChangedFile } from './diff.ts';
import type { ReadMark } from './types.ts';

export interface Coverage {
  read: string[];
  partial: string[];
  unread: string[];
  skipped: { file: string; reason: string }[];
}

// Local matcher: path.matchesGlob is still experimental on our Node floor.
function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] as string;
    if (glob.startsWith('**/', i)) {
      re += '(?:.*/)?';
      i += 2;
    } else if (glob.startsWith('**', i)) {
      re += '.*';
      i += 1;
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

function globMatches(glob: string, file: string): boolean {
  const re = globToRegExp(glob);
  if (re.test(file)) return true;
  // A pattern without a slash also matches the file's own name in any folder.
  return !glob.includes('/') && re.test(file.slice(file.lastIndexOf('/') + 1));
}

function covers(ranges: [number, number][], need: [number, number]): boolean {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  let next = need[0];
  for (const [s, e] of sorted) {
    if (s > next) break;
    next = Math.max(next, e + 1);
  }
  return next > need[1];
}

type State = 'read' | 'partial' | 'unread';

function stateOf(f: ChangedFile, reads: ReadMark[]): State {
  const real = reads.filter((r) => r.file === f.file && !r.partial);
  // A deleted file has no new lines to read: its diff counts, and so does a whole-file manual read
  // of its old content (needed when the diff is too large to print).
  if (f.status === 'D') return real.some((r) => r.via === 'diff' || (r.via === 'manual' && !r.range)) ? 'read' : 'unread';
  if (real.length === 0) return 'unread';
  if (f.binary || f.ranges.length === 0) return 'read';
  if (real.some((r) => r.via === 'diff' || !r.range)) return 'read';
  const got = real.map((r) => r.range as [number, number]);
  return f.ranges.every((need) => covers(got, need)) ? 'read' : 'partial';
}

export function coverage(
  changed: ChangedFile[],
  reads: ReadMark[],
  skips: { file: string; reason: string }[],
  skipGlobs: string[],
): Coverage {
  const out: Coverage = { read: [], partial: [], unread: [], skipped: [] };
  for (const f of changed) {
    const explicit = skips.find((s) => s.file === f.file);
    if (explicit) out.skipped.push({ file: f.file, reason: explicit.reason });
    else if (skipGlobs.some((g) => globMatches(g, f.file))) {
      out.skipped.push({ file: f.file, reason: 'config' });
    } else out[stateOf(f, reads)].push(f.file);
  }
  return out;
}
