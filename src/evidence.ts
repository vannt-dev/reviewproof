import { execFileSync } from 'node:child_process';
import { globMatches } from './coverage.ts';
import { gitEnv } from './git-env.ts';

/** An evidence file the pull request changed before a later change to a file it covers. */
export interface StaleEvidence {
  file: string;
  /** The newest commit of the pull request that changed the evidence file. */
  changedAt: string;
  /** The newest commit that changed a covered file, and one such file. */
  codeAt: string;
  codeFile: string;
}

/** What the draft and the verdict need: null when no evidence is configured. */
export interface EvidenceState {
  stale: StaleEvidence[];
  /** Evidence files the pull request changed that are up to date. */
  fresh: string[];
}

// The pull request's own commits, newest first, with the files each one changed. --first-parent
// leaves out the commits a merge of the base branch brought in, and --diff-merges=off makes a merge
// commit list no files (--first-parent alone would list what the merge brought in).
function commits(checkout: string, from: string, head: string): { sha: string; files: string[] }[] {
  const out = execFileSync(
    'git',
    ['-c', 'core.quotepath=false', 'log', '--first-parent', '--diff-merges=off', '--no-renames', '--name-only', '--format=%x00%H', `${from}..${head}`],
    { cwd: checkout, env: gitEnv(), encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
  );
  return out
    .split('\u0000')
    .filter((c) => c.trim() !== '')
    .map((c) => {
      const [sha, ...files] = c.split('\n').map((l) => l.trim()).filter((l) => l !== '');
      return { sha: sha as string, files };
    });
}

function existsAt(checkout: string, head: string, file: string): boolean {
  try {
    execFileSync('git', ['cat-file', '-e', `${head}:${file}`], { cwd: checkout, env: gitEnv(), stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Evidence files (screenshots, reports: `evidence` globs) that the pull request changed in
 * `from..head` and that are still there at the head, split into stale ones (last changed before
 * the newest change to a file they cover: `covers` globs, evidence files excluded) and fresh ones.
 * Null when no evidence globs are configured. Both lists are sorted by file.
 */
export function evidenceState(checkout: string, from: string, head: string, evidence: string[], covers: string[]): EvidenceState | null {
  if (evidence.length === 0) return null;
  const list = commits(checkout, from, head);
  const isEvidence = (f: string): boolean => evidence.some((g) => globMatches(g, f));
  const isCovered = (f: string): boolean => !isEvidence(f) && covers.some((g) => globMatches(g, f));
  // Newest first, so the first commit naming a file is its last change.
  const last = new Map<string, number>();
  list.forEach((c, i) => {
    for (const f of c.files) if (isEvidence(f) && !last.has(f)) last.set(f, i);
  });
  const files = [...last].filter(([f]) => existsAt(checkout, head, f)).sort(([a], [b]) => a.localeCompare(b));
  const codeIndex = list.findIndex((c) => c.files.some(isCovered));
  const code = list[codeIndex];
  const stale: StaleEvidence[] = [];
  const fresh: string[] = [];
  for (const [file, i] of files) {
    if (code && i > codeIndex) {
      stale.push({ file, changedAt: (list[i] as { sha: string }).sha, codeAt: code.sha, codeFile: code.files.find(isCovered) as string });
    } else fresh.push(file);
  }
  return { stale, fresh };
}

/** The stale evidence files alone; see evidenceState. */
export function staleEvidence(checkout: string, from: string, head: string, evidence: string[], covers: string[]): StaleEvidence[] {
  return evidenceState(checkout, from, head, evidence, covers)?.stale ?? [];
}

const short = (sha: string): string => sha.slice(0, 7);

/** The verdict blocker for one stale evidence file. */
export function staleLine(s: StaleEvidence): string {
  return `evidence ${s.file} was last changed at ${short(s.changedAt)}, before ${s.codeFile} changed at ${short(s.codeAt)}: make it again at the head`;
}

/** The draft's lines for the evidence; empty when none is configured. */
export function evidenceLines(e: EvidenceState | null): string[] {
  if (!e) return [];
  const body =
    e.stale.length > 0
      ? e.stale.map((s) => `- ${s.file}: stale (changed at ${short(s.changedAt)}, before ${s.codeFile} at ${short(s.codeAt)})`)
      : e.fresh.length === 0
        ? ['no evidence file changed in this pull request']
        : [`up to date: ${e.fresh.length} evidence file${e.fresh.length === 1 ? '' : 's'} changed after the last change ${e.fresh.length === 1 ? 'it covers' : 'they cover'}`];
  return ['### Evidence', '', ...body, ''];
}
