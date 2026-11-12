import { execFileSync } from 'node:child_process';
import { gitEnv } from '../git-env.ts';
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
export interface Env {
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

export function git(cwd: string, args: string[], env: Record<string, string> = {}): string {
  return execFileSync('git', args, { cwd, env: gitEnv(env), maxBuffer: 256 * 1024 * 1024, encoding: 'utf8', stdio: 'pipe' });
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

export function mergeBase(checkout: string, base: string, head: string): string {
  try {
    return git(checkout, ['merge-base', base, head]).trim();
  } catch {
    throw new Error(`base ${base} is not in the checkout: run git fetch origin`);
  }
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

/** For a command that changes the round: a posted round is closed. */
export function assertOpen(r: Review): Review {
  if (r.round.post) throw new Error(`round ${r.round.n} is already posted: start the next round`);
  return r;
}

// Parallel commands take turns on a PR's ledger and none saves a copy loaded before the lock.
// Work done before it (a gate run, a head check) was for `seen`'s round: a newer one is refused.
export function locked<T>(env: Env, seen: Review, fn: (r: Review) => T): T {
  return env.store.locked(seen.ref, () => {
    const ledger = env.store.load(seen.ref);
    const round = ledger?.rounds.at(-1);
    if (!ledger || round?.n !== seen.round.n) {
      throw new Error(`round ${round?.n} of ${prName(seen.ref)} started meanwhile: run the command again`);
    }
    return fn({ ...seen, ledger, round });
  });
}

// The verdict and its draft described the round before this change, so both go.
export function saveChange(env: Env, r: Review): void {
  const cleared = r.round.verdict !== undefined;
  delete r.round.verdict;
  delete r.round.draftAt;
  env.store.save(r.ledger);
  if (cleared) console.log('verdict cleared: run reviewproof verdict again');
}

// Hook reads live in their own file, so coverage always merges them in.
export function coverageOf(env: Env, r: Review): Coverage {
  const changed = changedFiles(r.checkout, r.round.from, r.round.head);
  return coverage(changed, allReads(env.store, r.ref, r.round), r.round.skips, r.config.skip);
}
