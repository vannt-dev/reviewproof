import { isEvidence } from './location.ts';
import type { Finding, Ledger, Location, NewFinding, PrRef, Round, Status, StatusEntry } from './types.ts';

export interface PrInfo {
  url: string;
  title: string;
  head: string;
  base: string;
}

// Every rule below works on the latest round, so a ledger without one is a caller bug.
function currentRound(l: Ledger): Round {
  const r = l.rounds[l.rounds.length - 1];
  if (!r) throw new Error('ledger has no round yet; start one first');
  return r;
}

export function startRound(
  ledger: Ledger | null,
  ref: PrRef,
  pr: PrInfo,
  from: string,
  now: Date,
  force: boolean,
): Ledger {
  const l: Ledger = ledger ?? {
    schemaVersion: 1,
    pr: { ...ref, url: pr.url, title: pr.title },
    rounds: [],
    findings: [],
  };
  const last = l.rounds[l.rounds.length - 1];
  // A new round on the same head would re-review nothing, so make the caller say so.
  if (last && last.head === pr.head && !force) {
    throw new Error(`head ${pr.head} unchanged since round ${last.n}; use force to start anyway`);
  }
  l.pr = { ...l.pr, url: pr.url, title: pr.title };
  l.rounds.push({
    n: (last?.n ?? 0) + 1,
    head: pr.head,
    base: pr.base,
    from,
    startedAt: now.toISOString(),
    gates: [],
    reads: [],
    skips: [],
  });
  return l;
}

export function addFinding(l: Ledger, f: NewFinding): Finding {
  const n = currentRound(l).n;
  const seq = l.findings.filter((x) => x.round === n).length + 1;
  const finding: Finding = { ...f, id: `F${n}-${seq}`, round: n, history: [{ round: n, status: 'open' }] };
  l.findings.push(finding);
  return finding;
}

function lastStatus(f: Finding, entries: StatusEntry[]): Status {
  const last = entries[entries.length - 1];
  if (!last) throw new Error(`finding ${f.id} has no status history`);
  return last.status;
}

export function currentStatus(f: Finding): Status {
  return lastStatus(f, f.history);
}

function statusBefore(f: Finding, round: number): Status {
  return lastStatus(f, f.history.filter((h) => h.round < round));
}

export function carried(l: Ledger): Finding[] {
  const n = currentRound(l).n;
  return l.findings.filter((f) => {
    if (f.round >= n || f.history.some((h) => h.round === n)) return false;
    const s = statusBefore(f, n);
    return s === 'open' || s === 'reopened';
  });
}

export function mark(
  l: Ledger,
  id: string,
  status: 'verified' | 'reopened' | 'withdrawn',
  opts: { evidence?: string; location?: Location },
): void {
  const round = currentRound(l);
  const f = l.findings.find((x) => x.id === id);
  const markedNow = f !== undefined && f.round !== round.n && f.history.some((h) => h.round === round.n);
  if (!f || !(markedNow || carried(l).includes(f))) {
    throw new Error(`finding ${id} is not carried into round ${round.n}`);
  }
  // Withdrawing closes a finding for good, so it has to point at something checkable.
  if (status === 'withdrawn' && !(opts.evidence && isEvidence(opts.evidence))) {
    throw new Error('withdrawn needs evidence: a file:line@sha location or a URL');
  }
  if (status === 'reopened' && opts.location?.sha !== round.head) {
    throw new Error(`reopened needs a location at the new head ${round.head}`);
  }
  const entry: StatusEntry = { round: round.n, status };
  if (opts.evidence) entry.evidence = opts.evidence;
  if (status === 'reopened') entry.location = opts.location;
  f.history = f.history.filter((h) => h.round !== round.n);
  f.history.push(entry);
}
