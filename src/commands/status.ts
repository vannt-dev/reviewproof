import { formatLocation } from '../location.ts';
import { carried, currentStatus } from '../rounds.ts';
import { verdictBlockers } from '../verdict.ts';
import { bullets, count, coverageOf, openReview, prName, take, type Command } from './context.ts';

// The summary is not written yet; a neutral one leaves only the round's own blockers.
const NEUTRAL_SUMMARY = 'status';

const status: Command = {
  args: '',
  about: 'gates, coverage, open findings and what still blocks verdict pass',
  async run(env, a) {
    take(a);
    const r = openReview(env);
    const { ledger: l, round } = r;
    const cov = coverageOf(env, r);
    const names = [...new Set([...r.config.requiredGates, ...round.gates.map((g) => g.name)])];
    const gates = names.map((n) => {
      const mine = round.gates.filter((g) => g.name === n);
      return mine.length === 0 ? `${n} missing` : `${n} ${mine.at(-1)?.result} (${count(mine.length, 'attempt')})`;
    });
    const total = cov.read.length + cov.partial.length + cov.unread.length;
    const open = l.findings.filter((f) => ['open', 'reopened'].includes(currentStatus(f)));
    const blockers = verdictBlockers(l, cov, r.config, 'pass', NEUTRAL_SUMMARY);
    const out = [
      `${prName(r.ref)} round ${round.n}: head ${round.head}, diff from ${round.from}`,
      `gates: ${gates.join(', ') || 'none'}`,
      `coverage: read ${cov.read.length} of ${count(total, 'changed file')}`,
      ...list('unread', cov.unread),
      ...list('partly read', cov.partial),
      ...list('skipped', cov.skipped.map((s) => `${s.file} (${s.reason})`)),
      ...list('carried without a status', carried(l).map((f) => `${f.id} ${f.title}`)),
      ...list('open findings', open.map((f) => `${f.id} ${f.severity} ${formatLocation(f.location)} ${f.title}`)),
    ];
    if (round.verdict) out.push(`verdict: ${round.verdict.value}: ${round.verdict.summary}`);
    if (round.post) out.push(`posted: ${round.post.url} (approved by ${round.post.approvedBy})`);
    out.push(blockers.length > 0 ? `verdict pass is blocked by:\n${bullets(blockers)}` : 'verdict pass is allowed');
    console.log(out.join('\n'));
    return 0;
  },
};

const list = (title: string, items: string[]): string[] => (items.length > 0 ? [`${title}:`, bullets(items)] : []);

export const statusCommands: Record<string, Command> = { status };
