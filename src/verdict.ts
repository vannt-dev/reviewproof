import type { Config } from './config.ts';
import type { Coverage } from './coverage.ts';
import { gateState } from './gates.ts';
import { hedges } from './lint.ts';
import { carried, currentStatus } from './rounds.ts';
import type { Ledger } from './types.ts';

/** One line per reason the verdict is not allowed yet; an empty list means the value may be recorded. */
export function verdictBlockers(
  l: Ledger,
  cov: Coverage,
  cfg: Config,
  value: 'pass' | 'not-yet',
  summary: string,
): string[] {
  const round = l.rounds[l.rounds.length - 1];
  if (!round) throw new Error('ledger has no round yet; start one first');
  const pass = value === 'pass';
  const gates = gateState(round, cfg.requiredGates);
  const out: string[] = gates.missing.map((n) => `gate ${n} missing`);
  if (pass) {
    out.push(...gates.failed.map((n) => `gate ${n} failed`));
    for (const n of gates.notChecked) {
      out.push(`gate ${n} not checked: ${round.gates.findLast((g) => g.name === n)?.reason ?? ''}`);
    }
  }
  out.push(...cov.unread.map((f) => `file ${f} unread`));
  out.push(...cov.partial.map((f) => `file ${f} only partly read`));
  out.push(...carried(l).map((f) => `finding ${f.id} carried without a status this round`));
  if (pass) {
    const open = l.findings.filter(
      (f) => f.severity === 'blocking' && currentStatus(f) !== 'verified' && currentStatus(f) !== 'withdrawn',
    );
    out.push(...open.map((f) => `blocking finding ${f.id} is ${currentStatus(f)}`));
  }
  out.push(...hedges(summary, cfg.hedgeWords).map((w) => `summary hedges: ${w}`));
  if (summary.trim() === '') out.push('summary is empty');
  return out;
}
