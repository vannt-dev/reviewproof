import fs from 'node:fs';
import path from 'node:path';
import { compareFindings, headToReview, humanComments, missesText, oneLine, placeOf } from '../backtest.ts';
import { parsePrRef } from '../hosts.ts';
import { lintFinding } from '../lint.ts';
import type { NewFinding } from '../types.ts';
import { bullets, checkoutOf, git, lineCounter, prName, str, take, type Command } from './context.ts';

function nearOf(text: string | undefined): number {
  if (text === undefined) return 3;
  if (!/^\d+$/.test(text)) throw new Error(`--near "${text}": a number of lines, 0 or more`);
  return Number(text);
}

// The findings, held to the replayed head as `add` holds them to a round's head.
function readFindings(cwd: string, file: string, checkout: string, head: string): NewFinding[] {
  const input: unknown = JSON.parse(fs.readFileSync(path.resolve(cwd, file), 'utf8'));
  if (!Array.isArray(input)) throw new Error(`${file} must hold a JSON array of findings`);
  const linted = input.map((x) => lintFinding(x, head, lineCounter(checkout, head)));
  const errors = linted.flatMap((x, i) => x.errors.map((e) => `finding ${i + 1}: ${e}`));
  if (errors.length > 0) throw new Error(`nothing compared:\n${bullets(errors)}`);
  return linted.map((x) => x.finding as NewFinding);
}

const list = (title: string, items: string[]): string[] => (items.length > 0 ? [`${title}:`, bullets(items)] : []);

// Replays a review on a merged pull request: first the head to review (and nothing of what people
// said, so the replay is blind), then, with --findings, the comparison with their line comments.
const backtest: Command = {
  args: '<pr> [--findings FILE] [--near N] [--misses FILE]',
  about: 'replay a review of a merged pull request and compare it with what people commented (GitHub)',
  options: { findings: { type: 'string' }, near: { type: 'string' }, misses: { type: 'string' } },
  async run(env, a) {
    const ref = parsePrRef(take(a, '<pr>')[0]);
    const near = nearOf(str(a, 'near'));
    const host = env.host(ref);
    if (!host.history) throw new Error('backtest reads review history from GitHub only');
    const h = await host.history(ref);
    if (!h.merged) throw new Error(`${prName(ref)} is not merged: backtest replays merged pull requests`);
    const { sha, why } = headToReview(h);
    const file = str(a, 'findings');
    if (file === undefined) {
      console.log(
        [
          `review ${prName(ref)} at ${sha.slice(0, 7)}: ${why}`,
          `  git fetch origin ${sha} && git switch --detach ${sha}`,
          `  the diff: git diff ${h.base}...${sha}`,
          "Review it without reading the pull request's comments, write the findings as for",
          'reviewproof add, then run:',
          `  reviewproof backtest ${prName(ref)} --findings <file>`,
        ].join('\n'),
      );
      return 0;
    }
    const checkout = checkoutOf(env.cwd);
    try {
      git(checkout, ['cat-file', '-e', `${sha}^{commit}`]);
    } catch {
      throw new Error(`commit ${sha.slice(0, 7)} is not in this checkout: run git fetch origin ${sha}`);
    }
    const findings = readFindings(env.cwd, file, checkout, sha);
    const said = humanComments(h);
    const r = compareFindings(findings, said.lines, near);
    const total = said.lines.length;
    const share = total === 0 ? 'none to compare with' : `${Math.round((100 * r.caught.length) / total)}%`;
    const out = [
      `backtest ${prName(ref)} at ${sha.slice(0, 7)}: ${why}; lines within ${near}`,
      `caught ${r.caught.length} of ${total} line comment${total === 1 ? '' : 's'} (${share})`,
      ...list('caught', r.caught.map((c) => `${placeOf(c.comment)} ${c.comment.by} <- ${c.finding.location.file}:${c.finding.location.line} ${c.finding.title}`)),
      ...list('missed', r.missed.map((c) => `${placeOf(c)} ${c.by}: ${oneLine(c.body, 120)} (${c.url})`)),
      ...list('extra (no human comment near)', r.extra.map((f) => `${f.location.file}:${f.location.line} ${f.severity}: ${f.title}`)),
      ...list('not placed on a line (judge by hand)', said.bodies.map((b) => `${b.by}: ${oneLine(b.body, 120)} (${b.url})`)),
    ];
    // The misses file is what the next review reads to learn from: kept per repository in the
    // ledger home (and committed there), or where --misses says.
    const given = str(a, 'misses');
    const target = given === undefined ? path.join(path.dirname(env.store.dirFor(ref)), 'misses.md') : path.resolve(env.cwd, given);
    const existing = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
    const text = missesText(prName(ref), sha, r.missed, existing, env.now());
    if (text === '') out.push(`no new miss for ${target}`);
    else {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.appendFileSync(target, `${existing === '' || existing.endsWith('\n\n') ? '' : existing.endsWith('\n') ? '\n' : '\n\n'}${text}`);
      const added = text.split('\n').filter((l) => l.startsWith('- ')).length;
      out.push(`${added} miss${added === 1 ? '' : 'es'} added to ${target}`);
      if (given === undefined) env.store.commit(`${prName(ref)} backtest: ${added} missed`);
    }
    console.log(out.join('\n'));
    return 0;
  },
};

export const backtestCommands: Record<string, Command> = { backtest };
