import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Host } from './hosts.ts';
import type { PrInfo } from './rounds.ts';
import { runCapture } from './spawn.ts';
import type { PrRef } from './types.ts';

/** Runs `gh <args>` and returns stdout; throws with gh's message on failure. */
function gh(args: string[]): string {
  const r = runCapture(['gh', ...args], process.cwd());
  if (r.status !== 0) throw new Error(`gh ${args[0] ?? ''} failed: ${r.error ?? r.output.trim()}`);
  return r.output;
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

  async comment(ref: PrRef, body: string): Promise<{ id: string; url: string }> {
    // A file, not an argv field: the body holds non-ASCII text that a Windows command line would mangle.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-gh-'));
    const file = path.join(dir, 'comment.json');
    try {
      fs.writeFileSync(file, JSON.stringify({ body }), 'utf8');
      const j = this.api(
        ref, '-X', 'POST', `repos/${ref.project}/issues/${ref.number}/comments`, '--input', file,
      ) as { id: number; html_url: string };
      return { id: String(j.id), url: j.html_url };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  async readComment(ref: PrRef, id: string): Promise<string> {
    return (this.api(ref, `repos/${ref.project}/issues/comments/${id}`) as { body: string }).body;
  }
}
