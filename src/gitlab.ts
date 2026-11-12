import type { Host, InlineRequest } from './hosts.ts';
import type { PrInfo } from './rounds.ts';
import type { InlinePosted, PrRef } from './types.ts';

interface MergeRequest {
  web_url: string;
  title: string;
  diff_refs: { head_sha: string; base_sha: string; start_sha: string };
}

class GitLabError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export class GitLab implements Host {
  private readonly fetchImpl: typeof fetch;
  private readonly token: string | undefined;

  constructor(fetchImpl: typeof fetch = fetch, token: string | undefined = process.env.GITLAB_TOKEN) {
    this.fetchImpl = fetchImpl;
    this.token = token;
  }

  // The token is checked per request so a missing one only fails when GitLab is really used.
  private async call(ref: PrRef, suffix: string, body?: unknown, method = 'POST'): Promise<unknown> {
    if (!this.token) throw new Error('GITLAB_TOKEN is not set');
    const url = `https://${ref.hostname}/api/v4/projects/${encodeURIComponent(ref.project)}${suffix}`;
    const headers: Record<string, string> = { 'PRIVATE-TOKEN': this.token };
    let init: RequestInit = { headers };
    if (body !== undefined) {
      headers['content-type'] = 'application/json; charset=utf-8';
      init = { method, headers, body: JSON.stringify(body) };
    }
    const res = await this.fetchImpl(url, init);
    const text = await res.text();
    if (!res.ok) throw new GitLabError(res.status, `GitLab ${res.status} for ${suffix}: ${text}`);
    return JSON.parse(text);
  }

  private mrUrl(ref: PrRef): string {
    return `https://${ref.hostname}/${ref.project}/-/merge_requests/${ref.number}`;
  }

  async resolve(ref: PrRef): Promise<PrInfo> {
    const j = (await this.call(ref, `/merge_requests/${ref.number}`)) as MergeRequest;
    return { url: j.web_url, title: j.title, head: j.diff_refs.head_sha, base: j.diff_refs.base_sha };
  }

  async comment(ref: PrRef, body: string): Promise<{ id: string; url: string }> {
    const j = (await this.call(ref, `/merge_requests/${ref.number}/notes`, { body })) as { id: number };
    return { id: String(j.id), url: `${this.mrUrl(ref)}#note_${j.id}` };
  }

  async updateComment(ref: PrRef, id: string, body: string): Promise<{ id: string; url: string } | null> {
    try {
      const j = (await this.call(ref, `/merge_requests/${ref.number}/notes/${id}`, { body }, 'PUT')) as { id: number };
      return { id: String(j.id), url: `${this.mrUrl(ref)}#note_${j.id}` };
    } catch (e) {
      // Only a note that is gone may become a new one; anything else must not post twice.
      if (e instanceof GitLabError && e.status === 404) return null;
      throw e;
    }
  }

  async readComment(ref: PrRef, id: string): Promise<string> {
    return ((await this.call(ref, `/merge_requests/${ref.number}/notes/${id}`)) as { body: string }).body;
  }

  // One discussion per finding, each reported as soon as it exists, so a failure part way loses
  // none. One the merge request refuses (a 4xx other than auth) does not hold up the ones after
  // it; the refusals are named at the end. A position names the diff, so its refs are read first.
  async inline(ref: PrRef, req: InlineRequest, posted: (p: InlinePosted[]) => void): Promise<void> {
    const refs = ((await this.call(ref, `/merge_requests/${ref.number}`)) as MergeRequest).diff_refs;
    if (refs.head_sha.toLowerCase() !== req.head.toLowerCase()) {
      throw new Error(`head moved: the merge request is at ${refs.head_sha}, the round reviewed ${req.head}`);
    }
    const refused: string[] = [];
    for (const c of req.comments) {
      const position = {
        position_type: 'text',
        base_sha: refs.base_sha,
        start_sha: refs.start_sha,
        head_sha: refs.head_sha,
        old_path: c.from ?? c.file,
        new_path: c.file,
        new_line: c.line,
      };
      let j: { id: string; notes: { id: number }[] };
      try {
        j = (await this.call(ref, `/merge_requests/${ref.number}/discussions`, { body: c.body, position })) as typeof j;
      } catch (e) {
        const s = e instanceof GitLabError ? e.status : 0;
        if (s < 400 || s > 499 || s === 401 || s === 403) throw e;
        refused.push(`${c.finding}: ${(e as Error).message}`);
        continue;
      }
      const note = j.notes[0]?.id;
      posted([{ finding: c.finding, id: j.id, url: note === undefined ? this.mrUrl(ref) : `${this.mrUrl(ref)}#note_${note}` }]);
    }
    if (refused.length > 0) throw new Error(`GitLab refused ${refused.join('; ')}`);
  }
}
