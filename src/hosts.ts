import type { PrInfo } from './rounds.ts';
import type { InlinePosted, PrRef } from './types.ts';
import { GitHub } from './github.ts';
import { GitLab } from './gitlab.ts';

/** A finding to comment on its line: an added line of the pull request's diff at `head`. */
export interface InlineComment {
  finding: string;
  file: string;
  /** The file's path at the base, when it was renamed. */
  from?: string;
  line: number;
  body: string;
}

export interface InlineRequest {
  head: string;
  /** The round's summary note, which every inline comment belongs to. */
  note: string;
  comments: InlineComment[];
}

export interface Host {
  resolve(ref: PrRef): Promise<PrInfo>;
  comment(ref: PrRef, body: string): Promise<{ id: string; url: string }>;
  /** Replaces a comment's body; null when the comment is gone (deleted), any other failure throws. */
  updateComment(ref: PrRef, id: string, body: string): Promise<{ id: string; url: string } | null>;
  readComment(ref: PrRef, id: string): Promise<string>;
  /** Posts the comments on their lines; `posted` hears of each as soon as it exists on the host. */
  inline(ref: PrRef, req: InlineRequest, posted: (p: InlinePosted[]) => void): Promise<void>;
}

const FORMS = [
  'https://github.com/o/r/pull/12',
  'o/r#12',
  'https://<host>/g/sub/r/-/merge_requests/7',
  'gitlab:g/r!7',
];

function bad(input: string): Error {
  return new Error(`cannot read "${input}" as a pull request. Accepted forms:\n  ${FORMS.join('\n  ')}`);
}

// The project becomes folder names and API paths, so empty and ".." segments are refused.
function ref(input: string, host: PrRef['host'], hostname: string, project: string, n: string): PrRef {
  const parts = project.split('/');
  if (parts.some((p) => p === '' || p === '.' || p === '..' || /[\\:]/.test(p)) || (host === 'github' && parts.length !== 2)) {
    throw new Error(`invalid project "${project}" in "${input}"`);
  }
  return { host, hostname, project, number: Number(n) };
}

export function parsePrRef(input: string): PrRef {
  const s = input.trim();
  const short = /^([^#\s]*\/[^#\s]*)#(\d+)$/.exec(s);
  if (short?.[1] && short[2]) return ref(s, 'github', 'github.com', short[1], short[2]);
  const lab = /^gitlab:([^!\s]+)!(\d+)$/.exec(s);
  if (lab?.[1] && lab[2]) return ref(s, 'gitlab', 'gitlab.com', lab[1], lab[2]);
  // Not new URL(): it would silently resolve ".." segments away before they can be refused.
  const url = /^https?:\/\/([^/?#\s]+)(\/[^?#\s]*)/.exec(s);
  if (!url?.[1] || !url[2]) throw bad(s);
  const mr = /^\/(.+)\/-\/merge_requests\/(\d+)(?:\/|$)/.exec(url[2]);
  if (mr?.[1] && mr[2]) return ref(s, 'gitlab', url[1], mr[1], mr[2]);
  const pull = /^\/(.+)\/pull\/(\d+)(?:\/|$)/.exec(url[2]);
  if (pull?.[1] && pull[2]) return ref(s, 'github', url[1], pull[1], pull[2]);
  throw bad(s);
}

export function hostFor(r: PrRef): Host {
  return r.host === 'github' ? new GitHub() : new GitLab();
}

// Hosts may normalise line endings and trailing blanks when they store a note.
export function sameNote(a: string, b: string): boolean {
  const norm = (t: string): string =>
    t.replace(/\r\n/g, '\n').split('\n').map((l) => l.trimEnd()).join('\n').trimEnd();
  return norm(a) === norm(b);
}
