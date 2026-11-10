import type { ChangedFile } from './diff.ts';
import type { ReadMark } from './types.ts';

/** Lines `reviewproof diff` prints around each change (git's default context). */
const CONTEXT = 3;

/** A helper agent's Read carries its agent id; the main session's reads carry none. */
export const helpersRead = (reads: ReadMark[]): boolean => reads.some((r) => r.agent !== undefined);

/**
 * Whether the main session has had this line in front of it: a Read of its own covering the line,
 * a read it declared, or the printed diff where the line is a change or its context.
 */
export function seenByMain(reads: ReadMark[], changed: ChangedFile[], file: string, line: number): boolean {
  const inDiff = (): boolean => {
    const f = changed.find((c) => c.file === file);
    return f?.ranges.some(([start, end]) => line >= start - CONTEXT && line <= end + CONTEXT) ?? false;
  };
  return reads.some((r) => {
    if (r.file !== file || r.agent !== undefined || r.partial) return false;
    if (r.via === 'diff') return inDiff();
    return !r.range || (line >= r.range[0] && line <= r.range[1]);
  });
}
