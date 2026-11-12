import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mock } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { run } from '../src/cli.ts';
import type { Host, InlineComment, InlineRequest } from '../src/hosts.ts';
import type { PrInfo } from '../src/rounds.ts';
import type { InlinePosted, PrRef } from '../src/types.ts';

// Commits in the temp repos and in the ledger home need an identity on a bare CI runner.
process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = 'Test';
process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = 'test@example.com';
// The suite may itself run inside Claude Code, where post refuses; the test that wants that sets it.
delete process.env.CLAUDECODE;

export const ref: PrRef = { host: 'github', hostname: 'github.com', project: 'o/r', number: 1 };

const tmp: string[] = [];
export function removeTmp(): void {
  for (const d of tmp) fs.rmSync(d, { recursive: true, force: true });
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
}

/** Stands in for GitHub: the test moves `head` and reads what was posted. */
export class FakeHost implements Host {
  head = '';
  base = '';
  readonly comments = new Map<string, string>();
  private nextId = 101;
  // Set to make the host store a note other than the one sent.
  altered: string | null = null;
  // Set to change the ledger while a note is being posted, as a command run meanwhile would.
  meanwhile: (() => void) | null = null;

  async resolve(): Promise<PrInfo> {
    return { url: 'https://github.com/o/r/pull/1', title: 'Add c', head: this.head, base: this.base };
  }

  async comment(_ref: PrRef, body: string): Promise<{ id: string; url: string }> {
    this.meanwhile?.();
    const id = String(this.nextId++);
    this.comments.set(id, this.altered ?? body);
    return { id, url: `https://github.com/o/r/pull/1#issuecomment-${id}` };
  }

  async updateComment(_ref: PrRef, id: string, body: string): Promise<{ id: string; url: string } | null> {
    if (!this.comments.has(id)) return null;
    this.comments.set(id, this.altered ?? body);
    return { id, url: `https://github.com/o/r/pull/1#issuecomment-${id}` };
  }

  async readComment(_ref: PrRef, id: string): Promise<string> {
    return this.comments.get(id) ?? '';
  }

  // Line comments posted, in order, with the note each one named.
  readonly inlines: (InlineComment & { note: string })[] = [];
  // Set to fail the line comments after this many were posted.
  inlineFailAfter: number | null = null;

  async inline(_ref: PrRef, req: InlineRequest, posted: (p: InlinePosted[]) => void): Promise<void> {
    for (const c of req.comments) {
      if (this.inlineFailAfter !== null && this.inlines.length >= this.inlineFailAfter) throw new Error('HTTP 502');
      this.inlines.push({ ...c, note: req.note });
      posted([{ finding: c.finding, id: `d${this.inlines.length}`, url: `https://github.com/o/r/pull/1#d${this.inlines.length}` }]);
    }
  }
}

export interface Result {
  code: number;
  out: string;
  err: string;
}

export interface Review {
  root: string;
  checkout: string;
  home: string;
  host: FakeHost;
  /** Runs the CLI in the checkout and captures what it prints. */
  rp(...argv: string[]): Promise<Result>;
  /** Commits `text` to `file` as a new PR head and pushes it to the pull ref. */
  push(file: string, text: string): string;
}

/** This node (never one from PATH) in a child process; several run at once, so it resolves on exit. */
export function runNode(args: string[], opts: { cwd?: string; env?: Record<string, string> } = {}): Promise<Result> {
  const options = { cwd: opts.cwd, env: { ...process.env, ...opts.env }, encoding: 'utf8' } as const;
  return new Promise((resolve) => {
    execFile(process.execPath, args, options, (e, out, err) => {
      resolve({ code: e ? (typeof e.code === 'number' ? e.code : 1) : 0, out, err });
    });
  });
}

function write(dir: string, file: string, text: string): void {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), text);
}

// A bare remote with main and refs/pull/1/head, a checkout at the PR head, a ledger home that
// requires the `test` gate.
export function setup(): Review {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-e2e-'));
  tmp.push(root);
  const remote = path.join(root, 'remote.git');
  const checkout = path.join(root, 'checkout');
  const home = path.join(root, 'home');
  fs.mkdirSync(checkout);
  git(root, 'init', '-q', '--bare', remote);
  git(checkout, 'init', '-q');
  git(checkout, 'remote', 'add', 'origin', remote);
  write(checkout, 'src/a.ts', 'one\ntwo\n');
  write(checkout, 'src/b.ts', 'b\n');
  git(checkout, 'add', '-A');
  git(checkout, 'commit', '-q', '-m', 'base');
  git(checkout, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
  write(home, 'config.json', JSON.stringify({ requiredGates: ['test'] }));

  const host = new FakeHost();
  host.base = git(checkout, 'rev-parse', 'HEAD');
  const push = (file: string, text: string): string => {
    write(checkout, file, text);
    git(checkout, 'add', '-A');
    git(checkout, 'commit', '-q', '-m', `change ${file}`);
    git(checkout, 'push', '-q', '-f', 'origin', 'HEAD:refs/pull/1/head');
    host.head = git(checkout, 'rev-parse', 'HEAD');
    return host.head;
  };
  write(checkout, 'src/c.ts', 'c\n');
  push('src/a.ts', 'one\nTWO\nthree\n');

  const rp = async (...argv: string[]): Promise<Result> => {
    const r = { code: 0, out: '', err: '' };
    const log = mock.method(console, 'log', (...a: unknown[]) => void (r.out += `${a.join(' ')}\n`));
    const error = mock.method(console, 'error', (...a: unknown[]) => void (r.err += `${a.join(' ')}\n`));
    try {
      r.code = await run(argv, { host, cwd: checkout, home });
    } finally {
      log.mock.restore();
      error.mock.restore();
    }
    return r;
  };
  return { root, checkout, home, host, rp, push };
}

export const passTest = ['gate', 'run', 'test', '--', process.execPath, '-e', '0'];

export async function steps(s: Review, ...runs: string[][]): Promise<void> {
  for (const argv of runs) {
    const r = await s.rp(...argv);
    assert.equal(r.code, 0, `${argv.join(' ')}: ${r.err}`);
  }
}

/** Round 1 where verdict pass is allowed: every file read, the required gate passed. */
export async function ready(): Promise<Review> {
  const s = setup();
  await steps(s, ['start', 'o/r#1'], ['diff'], passTest);
  return s;
}
