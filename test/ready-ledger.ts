import { addFinding, mark, startRound } from '../src/rounds.ts';
import type { Ledger } from '../src/types.ts';

const ref = { host: 'github', hostname: 'github.com', project: 'o/r', number: 1 } as const;
const pr = (head: string) => ({ url: 'u', title: 't', head, base: 'b' });
const at = { file: 'a.ts', line: 1, sha: 'h2' };

// A ready ledger: round 2, the round-1 blocking finding verified, the required gate passed.
export function ready(): Ledger {
  const l = startRound(null, ref, pr('h1'), 'b', new Date(0), false);
  addFinding(l, {
    severity: 'blocking',
    source: { kind: 'rule', ref: 'R1' },
    location: { ...at, sha: 'h1' },
    title: 'x',
  });
  startRound(l, ref, pr('h2'), 'h1', new Date(0), false);
  mark(l, 'F1-1', 'verified', { evidence: 'fixed' });
  l.rounds[1]?.gates.push({
    name: 'test',
    attempt: 1,
    argv: ['t'],
    exitCode: 0,
    result: 'pass',
    at: '',
  });
  return l;
}
