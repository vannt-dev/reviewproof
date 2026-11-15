import { redactor } from './gates.ts';
import type { CiCheck } from './hosts.ts';

export type CiOutcome = 'pass' | 'fail' | 'unfinished' | 'none';

const FAIL = ['failure', 'cancelled', 'timed_out', 'error'];
const UNFINISHED = ['queued', 'in_progress', 'pending', 'waiting', 'requested'];

// A closed list: only success passes. neutral, skipped, stale, action_required and anything
// unknown are no evidence either way.
export function ciOutcome(conclusion: string): CiOutcome {
  if (conclusion === 'success') return 'pass';
  if (FAIL.includes(conclusion)) return 'fail';
  return UNFINISHED.includes(conclusion) ? 'unfinished' : 'none';
}

// Several runs may share a name (the same job on push and on pull_request). The one that says
// the least good decides, so a pass is only recorded when all of them passed.
const WEIGHT: Record<CiOutcome, number> = { unfinished: 3, fail: 2, none: 1, pass: 0 };

function decisive(runs: CiCheck[]): CiCheck {
  return runs.reduce((a, b) => {
    const d = WEIGHT[ciOutcome(b.conclusion)] - WEIGHT[ciOutcome(a.conclusion)];
    return d > 0 || (d === 0 && (b.completedAt ?? '') > (a.completedAt ?? '')) ? b : a;
  });
}

/** One check per name, in the host's order. */
export function byName(checks: CiCheck[]): CiCheck[] {
  const names = [...new Set(checks.map((c) => c.name))];
  return names.map((n) => decisive(checks.filter((c) => c.name === n)));
}

/** The check called `name`: exactly, else ignoring case; anything else names what there is. */
export function findCheck(checks: CiCheck[], name: string, head: string): CiCheck {
  const all = byName(checks);
  if (all.length === 0) throw new Error(`no checks at the round's head ${head.slice(0, 7)}`);
  const exact = all.find((c) => c.name === name);
  if (exact) return exact;
  const loose = all.filter((c) => c.name.toLowerCase() === name.toLowerCase());
  if (loose.length === 1 && loose[0]) return loose[0];
  const list = (loose.length > 1 ? loose : all).map((c) => `  - ${c.name}`).join('\n');
  if (loose.length > 1) throw new Error(`check "${name}" matches more than one name; say which:\n${list}`);
  throw new Error(`no check "${name}" at the round's head ${head.slice(0, 7)}; the checks there:\n${list}`);
}

/** The result the check gives for this head, or why it cannot be recorded. */
export function ciResult(check: CiCheck, head: string): { result: 'pass' | 'fail' } | { refused: string } {
  if (check.sha.toLowerCase() !== head.toLowerCase()) {
    return { refused: `ran at ${check.sha.slice(0, 7)}, not at the round's head ${head.slice(0, 7)}` };
  }
  const o = ciOutcome(check.conclusion);
  if (o === 'unfinished') return { refused: `is not finished yet (${check.conclusion})` };
  if (o === 'none') return { refused: `ended as ${check.conclusion}, which is no evidence either way` };
  return { result: o };
}

/** A check name as a gate name: what is not a letter, digit, ., _ or - becomes one "-". */
export function gateNameOf(check: string): string {
  return check.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[^A-Za-z0-9]+/, '').replace(/-+$/, '');
}

// The name and the link come from the host, where the pull request's author chooses them, and
// they end up in the posted note: one line each, no token value, and only a web link.
export function cleanCheck(c: CiCheck): CiCheck {
  const redact = redactor();
  const line = (s: string): string => redact(s).replace(/\s+/g, ' ').trim();
  const { url, ...rest } = c;
  const safe = url !== undefined && /^https?:\/\/[^\s<>()]+$/.test(url) ? redact(url) : undefined;
  return { ...rest, name: line(c.name), conclusion: line(c.conclusion), ...(safe ? { url: safe } : {}) };
}
