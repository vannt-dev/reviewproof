import type { Coverage } from './coverage.ts';
import { offHead } from './gates.ts';
import { currentStatus } from './rounds.ts';
import type { Finding, GateAttempt, Ledger, Location, Round } from './types.ts';

// A pipe or line break inside a cell would split the table row.
const cell = (s: string): string => s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
const at = (loc: Location): string => `${loc.file}:${loc.line}@${loc.sha}`;

// The last attempt decides; the failed ones before it stay in sight, and where it ran.
function gateLine(name: string, round: Round): string {
  const mine = round.gates.filter((g) => g.name === name);
  const last = mine[mine.length - 1] as GateAttempt;
  const why = last.result === 'not-checked' ? ` (${last.reason ?? ''})` : '';
  const where = last.head ? ` at ${last.head.slice(0, 7)}` : '';
  const off = offHead(round, last);
  const failed = mine.filter((g) => g !== last && g.result === 'fail').map((g) => g.attempt);
  const before = failed.length ? ` (attempt${failed.length === 1 ? '' : 's'} ${failed.join(', ')} failed)` : '';
  return `- ${name}: ${last.result}${why}${where}${off ? ` (${off})` : ''}, ${mine.length} attempt${mine.length === 1 ? '' : 's'}${before}`;
}

function carriedLine(f: Finding, round: number): string {
  const entry = f.history.find((h) => h.round === round);
  const proof = [entry?.evidence, entry?.location && at(entry.location)].filter(Boolean).join('; ');
  return `- ${f.id} ${f.title}: ${currentStatus(f)}${proof ? ` (${proof})` : ''}`;
}

// The table holds one line per finding; the reasoning a reader needs to act on it goes below.
function details(findings: Finding[]): string[] {
  const withBody = findings.filter((f) => f.body?.trim());
  if (withBody.length === 0) return [];
  return [
    '### Details',
    '',
    ...withBody.flatMap((f) => [`**${f.id} ${cell(f.title)}** (${at(f.location)})`, '', (f.body ?? '').trim(), '']),
  ];
}

export function renderDraft(l: Ledger, cov: Coverage): string {
  const round = l.rounds[l.rounds.length - 1];
  if (!round) throw new Error('ledger has no round yet; start one first');
  const v = round.verdict;
  const mine = l.findings.filter((f) => f.round === round.n);
  const earlier = l.findings.filter((f) => f.round < round.n && f.history.some((h) => h.round === round.n));
  const rows = mine.map(
    (f) =>
      `| ${f.id} | ${f.severity} | ${f.source.kind}: ${cell(f.source.ref)} | ${cell(at(f.location))} | ${cell(f.title)} |`,
  );
  const names = [...new Set(round.gates.map((g) => g.name))];
  const skipped = cov.skipped.map((s) => `${s.file} (${s.reason})`).join(', ');
  const total = cov.read.length + cov.partial.length + cov.unread.length;
  return [
    `## Review round ${round.n} (head ${round.head})`,
    '',
    v ? `**Verdict: ${v.value}.** ${v.summary}` : '**Verdict:** not decided yet.',
    '',
    '### Findings',
    '',
    '| id | severity | source | location | title |',
    '| --- | --- | --- | --- | --- |',
    ...rows,
    '',
    ...details(mine),
    '### Carried findings',
    '',
    ...(earlier.length > 0 ? earlier.map((f) => carriedLine(f, round.n)) : ['none']),
    '',
    '### Gates',
    '',
    ...(names.length > 0 ? names.map((n) => gateLine(n, round)) : ['none']),
    '',
    '### Coverage',
    '',
    `read ${cov.read.length} of ${total} changed files (opened with Read or reviewproof diff)${skipped ? `; skipped: ${skipped}` : ''}`,
    '',
  ].join('\n');
}
