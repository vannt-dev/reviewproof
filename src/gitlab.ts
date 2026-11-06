import type { Host } from './hosts.ts';
import type { PrInfo } from './rounds.ts';
import type { PrRef } from './types.ts';

export class GitLab implements Host {
  private readonly fetchImpl: typeof fetch;
  private readonly token: string | undefined;

  constructor(fetchImpl: typeof fetch = fetch, token: string | undefined = process.env.GITLAB_TOKEN) {
    this.fetchImpl = fetchImpl;
    this.token = token;
  }

  // The token is checked per request so a missing one only fails when GitLab is really used.
  private async call(ref: PrRef, suffix: string, body?: unknown): Promise<unknown> {
    if (!this.token) throw new Error('GITLAB_TOKEN is not set');
    const url = `https://${ref.hostname}/api/v4/projects/${encodeURIComponent(ref.project)}${suffix}`;
    const headers: Record<string, string> = { 'PRIVATE-TOKEN': this.token };
    let init: RequestInit = { headers };
    if (body !== undefined) {
      headers['content-type'] = 'application/json; charset=utf-8';
      init = { method: 'POST', headers, body: JSON.stringify(body) };
    }
    const res = await this.fetchImpl(url, init);
    const text = await res.text();
    if (!res.ok) throw new Error(`GitLab ${res.status} for ${suffix}: ${text}`);
    return JSON.parse(text);
  }

  async resolve(ref: PrRef): Promise<PrInfo> {
    const j = (await this.call(ref, `/merge_requests/${ref.number}`)) as {
      web_url: string; title: string; diff_refs: { head_sha: string; base_sha: string };
    };
    return { url: j.web_url, title: j.title, head: j.diff_refs.head_sha, base: j.diff_refs.base_sha };
  }

  async comment(ref: PrRef, body: string): Promise<{ id: string; url: string }> {
    const j = (await this.call(ref, `/merge_requests/${ref.number}/notes`, { body })) as { id: number };
    const mr = `https://${ref.hostname}/${ref.project}/-/merge_requests/${ref.number}`;
    return { id: String(j.id), url: `${mr}#note_${j.id}` };
  }

  async readComment(ref: PrRef, id: string): Promise<string> {
    return ((await this.call(ref, `/merge_requests/${ref.number}/notes/${id}`)) as { body: string }).body;
  }
}
