import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CiCheck, Host, InlineRequest } from './hosts.ts';
import type { PrInfo } from './rounds.ts';
import { runCapture } from './spawn.ts';
import type { InlinePosted, PrRef } from './types.ts';

// No update notice, and a missing login fails instead of waiting for input.
const GH_ENV = { GH_NO_UPDATE_NOTIFIER: '1', GH_PROMPT_DISABLED: '1' };

/** Runs `gh <args>` and returns stdout only; throws with gh's message on failure. */
function gh(args: string[]): string {
  const r = runCapture(['gh', ...args], process.cwd(), GH_ENV);
  if (r.status !== 0) throw new Error(`gh ${args[0] ?? ''} failed: ${r.error ?? r.output.trim()}`);
  return r.stdout;
}

const PAGE = 100;

interface CheckRun {
  name: string;
  status: string;
  conclusion: string | null;
  head_sha: string;
  html_url: string | null;
  started_at: string | null;
  completed_at: string | null;
}

interface CombinedStatus {
  sha: string;
  statuses: { context: string; state: string; target_url: string | null; created_at: string; updated_at: string }[];
}

export class GitHub implements Host {
  private readonly run: (args: string[]) => string;

  constructor(run: (args: string[]) => string = gh) {
    this.run = run;
  }

  private api(ref: PrRef, ...rest: string[]): unknown {
    const host = ref.hostname === 'github.com' ? [] : ['--hostname', ref.hostname];
    return JSON.parse(this.run(['api', ...host, ...rest]));
  }

  async resolve(ref: PrRef): Promise<PrInfo> {
    const j = this.api(ref, `repos/${ref.project}/pulls/${ref.number}`) as {
      html_url: string; title: string; head: { sha: string }; base: { sha: string };
    };
    return { url: j.html_url, title: j.title, head: j.head.sha, base: j.base.sha };
  }

  // A file, not an argv field: the body holds non-ASCII text that a Windows command line would mangle.
  private send(ref: PrRef, method: string, endpoint: string, payload: unknown): unknown {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-gh-'));
    const file = path.join(dir, 'body.json');
    try {
      fs.writeFileSync(file, JSON.stringify(payload), 'utf8');
      return this.api(ref, '-X', method, endpoint, '--input', file);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  async comment(ref: PrRef, body: string): Promise<{ id: string; url: string }> {
    const j = this.send(ref, 'POST', `repos/${ref.project}/issues/${ref.number}/comments`, { body }) as {
      id: number; html_url: string;
    };
    return { id: String(j.id), url: j.html_url };
  }

  async updateComment(ref: PrRef, id: string, body: string): Promise<{ id: string; url: string } | null> {
    try {
      const j = this.send(ref, 'PATCH', `repos/${ref.project}/issues/comments/${id}`, { body }) as {
        id: number; html_url: string;
      };
      return { id: String(j.id), url: j.html_url };
    } catch (e) {
      // gh ends its message with the status; only a comment that is gone may become a new one.
      if (/\(HTTP 404\)/.test((e as Error).message)) return null;
      throw e;
    }
  }

  // One review that only comments (never approves), pinned to the reviewed commit: all or nothing.
  async inline(ref: PrRef, req: InlineRequest, posted: (p: InlinePosted[]) => void): Promise<void> {
    const j = this.send(ref, 'POST', `repos/${ref.project}/pulls/${ref.number}/reviews`, {
      commit_id: req.head,
      event: 'COMMENT',
      body: `Findings on their lines; the round note: ${req.note}`,
      comments: req.comments.map((c) => ({ path: c.file, line: c.line, side: 'RIGHT', body: c.body })),
    }) as { id: number; html_url: string };
    posted(req.comments.map((c) => ({ finding: c.finding, id: String(j.id), url: j.html_url })));
  }

  // A list of a commit, page by page until a page is not full.
  private pages<J, T>(ref: PrRef, sha: string, list: string, items: (j: J) => T[]): T[] {
    const all: T[] = [];
    for (let page = 1; ; page++) {
      const got = items(this.api(ref, `repos/${ref.project}/commits/${sha}/${list}?per_page=${PAGE}&page=${page}`) as J);
      all.push(...got);
      if (got.length < PAGE) return all;
    }
  }

  // Check runs (Actions and other apps) and commit statuses (older integrations) are two lists.
  // Each entry keeps the commit the host names for it, so the caller can hold it to the head.
  async checks(ref: PrRef, sha: string): Promise<CiCheck[]> {
    const runs = this.pages(ref, sha, 'check-runs', (j: { check_runs: CheckRun[] }) => j.check_runs).map(
      (c): CiCheck => ({
        name: c.name,
        conclusion: c.status === 'completed' ? (c.conclusion ?? 'none') : c.status,
        sha: c.head_sha,
        ...(c.html_url ? { url: c.html_url } : {}),
        ...(c.started_at ? { startedAt: c.started_at } : {}),
        ...(c.completed_at ? { completedAt: c.completed_at } : {}),
      }),
    );
    const statuses = this.pages(ref, sha, 'status', (j: CombinedStatus) =>
      j.statuses.map(
        (s): CiCheck => ({
          name: s.context,
          conclusion: s.state,
          sha: j.sha,
          ...(s.target_url ? { url: s.target_url } : {}),
          startedAt: s.created_at,
          ...(s.state === 'pending' ? {} : { completedAt: s.updated_at }),
        }),
      ),
    );
    return [...runs, ...statuses];
  }

  async readComment(ref: PrRef, id: string): Promise<string> {
    return (this.api(ref, `repos/${ref.project}/issues/comments/${id}`) as { body: string }).body;
  }
}
