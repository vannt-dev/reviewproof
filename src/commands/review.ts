import fs from 'node:fs';
import path from 'node:path';
import { setActive } from '../active.ts';
import { changedFiles } from '../diff.ts';
import { parsePrRef } from '../hosts.ts';
import { lintFinding, resolveAt } from '../lint.ts';
import { addFinding, mark, startRound } from '../rounds.ts';
import type { Location, NewFinding } from '../types.ts';
import { bullets, checkoutOf, count, git, lineCounter, openReview, str, take, type Command } from './context.ts';

const start: Command = {
  args: '<pr> [--force] [--full]',
  about: 'next round at the PR head (the checkout on it); --full: diff from the merge-base',
  options: { force: { type: 'boolean' }, full: { type: 'boolean' } },
  async run(env, a) {
    const [input] = take(a, '<pr>');
    const ref = parsePrRef(input);
    const checkout = checkoutOf(env.cwd);
    const pr = await env.host(ref).resolve(ref);
    // The pull ref also holds heads pushed from forks, which no branch of origin has.
    const pull = ref.host === 'github' ? `pull/${ref.number}/head` : `merge-requests/${ref.number}/head`;
    git(checkout, ['fetch', '--quiet', 'origin', pull]);
    const at = git(checkout, ['rev-parse', 'HEAD']).trim();
    if (at.toLowerCase() !== pr.head.toLowerCase()) {
      throw new Error(`the checkout is at ${at}, the PR head is ${pr.head}: run git switch --detach ${pr.head}`);
    }
    const ledger = env.store.load(ref);
    const last = ledger?.rounds.at(-1);
    const from = !last || a.values.full === true ? mergeBase(checkout, pr.base, pr.head) : last.head;
    const l = startRound(ledger, ref, pr, from, env.now(), a.values.force === true);
    env.store.save(l);
    setActive(env.home, checkout, ref);
    const changed = count(changedFiles(checkout, from, pr.head).length, 'changed file');
    console.log(`round ${l.rounds.at(-1)?.n} of ${l.pr.url}: head ${pr.head}, ${changed} since ${from}`);
    return 0;
  },
};

function mergeBase(checkout: string, base: string, head: string): string {
  try {
    return git(checkout, ['merge-base', base, head]).trim();
  } catch {
    throw new Error(`base ${base} is not in the checkout: run git fetch origin`);
  }
}

const add: Command = {
  args: '<json-file>',
  about: 'add findings: [{ severity, source: { kind, ref }, at: "file:line", title, body? }]',
  async run(env, a) {
    const [file] = take(a, '<json-file>');
    const r = openReview(env);
    const input: unknown = JSON.parse(fs.readFileSync(path.resolve(env.cwd, file), 'utf8'));
    if (!Array.isArray(input)) throw new Error(`${file} must hold a JSON array of findings`);
    const lines = lineCounter(r.checkout, r.round.head);
    const linted = input.map((x) => lintFinding(x, r.round.head, lines));
    const errors = linted.flatMap((x, i) => x.errors.map((e) => `finding ${i + 1}: ${e}`));
    // All or nothing: after a half-added batch nobody knows which ids exist.
    if (errors.length > 0) {
      console.error(`nothing added:\n${bullets(errors)}`);
      return 1;
    }
    const ids = linted.map((x) => addFinding(r.ledger, x.finding as NewFinding).id);
    env.store.save(r.ledger);
    console.log(ids.length > 0 ? `added ${ids.join(', ')}` : 'no findings in the file');
    return 0;
  },
};

const STATUSES: readonly string[] = ['verified', 'reopened', 'withdrawn'];

const markCommand: Command = {
  args: '<id> <status> [--evidence E] [--at file:line]',
  about: 'status of a carried finding: verified, reopened (--at) or withdrawn (--evidence)',
  options: { evidence: { type: 'string' }, at: { type: 'string' } },
  async run(env, a) {
    const [id, status] = take(a, '<id>', '<status>');
    if (!STATUSES.includes(status)) throw new Error(`status must be one of ${STATUSES.join(', ')}`);
    const r = openReview(env);
    const atText = str(a, 'at');
    let location: Location | undefined;
    if (atText !== undefined) {
      const at = resolveAt(atText, r.round.head, lineCounter(r.checkout, r.round.head));
      if ('error' in at) throw new Error(at.error);
      location = at.location;
    }
    mark(r.ledger, id, status as 'verified' | 'reopened' | 'withdrawn', { evidence: str(a, 'evidence'), location });
    env.store.save(r.ledger);
    console.log(`${id}: ${status} in round ${r.round.n}`);
    return 0;
  },
};

export const review: Record<string, Command> = { start, add, mark: markCommand };
