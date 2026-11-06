import { execFileSync } from 'node:child_process';
import { gitEnv } from './git-env.ts';

export interface ChangedFile {
  file: string;
  status: 'A' | 'M' | 'D' | 'R';
  binary: boolean;
  ranges: [number, number][];
}

const HUNK = /^@@ -\S+ \+(\d+)(?:,(\d+))? @@/;

// Without a rename line both sides of the header are the same path "a/P b/P",
// so P is recoverable from the length alone, even with spaces in the name.
function headerPath(header: string): string {
  const rest = header.slice('diff --git '.length);
  const len = (rest.length - 5) / 2;
  return rest.slice(2, 2 + len);
}

export function parseDiff(text: string): ChangedFile[] {
  const files: ChangedFile[] = [];
  let cur: ChangedFile | null = null;
  let inHunks = false;
  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      cur = { file: headerPath(line), status: 'M', binary: false, ranges: [] };
      files.push(cur);
      inHunks = false;
    } else if (!cur) {
      continue;
    } else if (line.startsWith('@@')) {
      inHunks = true;
      const m = HUNK.exec(line);
      const start = Number(m?.[1]);
      const count = m?.[2] === undefined ? 1 : Number(m[2]);
      if (m && count > 0) cur.ranges.push([start, start + count - 1]);
    } else if (!inHunks) {
      if (line.startsWith('new file mode')) cur.status = 'A';
      else if (line.startsWith('deleted file mode')) cur.status = 'D';
      else if (line.startsWith('rename to ')) {
        cur.status = 'R';
        cur.file = line.slice('rename to '.length);
      } else if (line.startsWith('Binary files ') && line.endsWith(' differ')) cur.binary = true;
    }
  }
  return files;
}

export function changedFiles(repo: string, from: string, to: string): ChangedFile[] {
  // quotepath=false keeps non-ASCII names readable; the --no-* flags ignore the user's diff drivers.
  const args = ['-c', 'core.quotepath=false', 'diff', '--unified=0', '-M', '--no-color'];
  args.push('--no-ext-diff', '--no-textconv', from, to);
  const out = execFileSync('git', args, {
    cwd: repo,
    env: gitEnv(),
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  return parseDiff(out);
}
