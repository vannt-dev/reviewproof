import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import type { ParseArgsOptionsConfig } from 'node:util';
import { activeFor } from '../active.ts';
import { loadConfig, type Config } from '../config.ts';
import { coverage, type Coverage } from '../coverage.ts';
import { changedFiles } from '../diff.ts';
import { hostFor, type Host } from '../hosts.ts';
import { allReads } from '../reads.ts';
import { LedgerStore } from '../store.ts';
import type { Ledger, PrRef, Round } from '../types.ts';

export interface Deps {
  host?: Host;
  cwd?: string;
  home?: string;
  now?: () => Date;
}

/** The dependencies with their defaults filled in; the host is picked once the PR is known. */
interface Env {
  cwd: string;
  home: string;
  now: () => Date;
  store: LedgerStore;
  host(ref: PrRef): Host;
}

export function envFrom(deps: Deps): Env {
  const home = deps.home ?? (process.env.REVIEWPROOF_HOME || path.join(os.homedir(), '.reviewproof'));
  return {
    cwd: deps.cwd ?? process.cwd(),
    home,
    now: deps.now ?? (() => new Date()),
    store: new LedgerStore(home),
    host: (ref) => deps.host ?? hostFor(ref),
  };
}

interface Args {
  positionals: string[];
  values: Record<string, unknown>;
  /** Everything after `--`, untouched (only commands with `tail` get it apart). */
  tail: string[];
}

export interface Command {
  args: string;
  about: string;
  options?: ParseArgsOptionsConfig;
  tail?: true;
  run(env: Env, a: Args): Promise<number>;
}

/** Exactly the positionals named (usage names, for the message). */
export function take<T extends string[]>(a: Args, ...names: T): { [K in keyof T]: string } {
  const got = a.positionals;
  if (got.length < names.length) throw new Error(`missing ${names[got.length]}`);
  if (got.length > names.length) throw new Error(`unexpected argument "${got[names.length]}"`);
  return got as { [K in keyof T]: string };
}

export function str(a: Args, name: string): string | undefined {
  const v = a.values[name];
  return typeof v === 'string' ? v : undefined;
}

export const prName = (ref: PrRef): string => `${ref.project}#${ref.number}`;
export const count = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? '' : 's'}`;
export const bullets = (lines: string[]): string => lines.map((l) => `  - ${l}`).join('\n');

export function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe', maxBuffer: 256 * 1024 * 1024 });
}

export function checkoutOf(cwd: string): string {
  try {
    return git(cwd, ['rev-parse', '--show-toplevel']).trim();
  } catch {
    throw new Error(`${cwd} is not inside a git checkout`);
  }
}

// Lines of a file at a commit; null when it is not a file there.
export function lineCounter(checkout: string, sha: string): (file: string) => number | null {
  return (file) => {
    let text: string;
    try {
      text = git(checkout, ['cat-file', 'blob', `${sha}:${file}`]);
    } catch {
      return null;
    }
    return text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
  };
}

export interface Review {
  checkout: string;
  ref: PrRef;
  ledger: Ledger;
  round: Round;
  config: Config;
}

/** The review started in this checkout, at its latest round. */
export function openReview(env: Env): Review {
  const checkout = checkoutOf(env.cwd);
  const active = activeFor(env.home, checkout);
  if (!active) throw new Error(`no active review in ${checkout}: run reviewproof start <pr>`);
  const ledger = env.store.load(active.ref);
  const round = ledger?.rounds.at(-1);
  if (!ledger || !round) throw new Error(`no ledger for ${prName(active.ref)}: run reviewproof start <pr>`);
  return { checkout, ref: active.ref, ledger, round, config: loadConfig(checkout, env.home) };
}

// Hook reads live in their own file, so coverage always merges them in.
export function coverageOf(env: Env, r: Review): Coverage {
  const changed = changedFiles(r.checkout, r.round.from, r.round.head);
  return coverage(changed, allReads(env.store, r.ref, r.round), r.round.skips, r.config.skip);
}

// A verdict and a post speak about one head; a push since the round started makes both stale.
export async function assertHead(env: Env, r: Review): Promise<void> {
  const pr = await env.host(r.ref).resolve(r.ref);
  if (pr.head.toLowerCase() !== r.round.head.toLowerCase()) {
    throw new Error(
      `head moved: the PR is at ${pr.head}, round ${r.round.n} reviewed ${r.round.head}; ` +
        `start the next round with reviewproof start ${r.ledger.pr.url}`,
    );
  }
}
