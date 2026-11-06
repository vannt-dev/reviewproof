import path from 'node:path';
import { runCapture } from './spawn.ts';
import type { LedgerStore } from './store.ts';
import type { GateAttempt, PrRef, Round } from './types.ts';

// Longest values first, so a token that contains another one is replaced whole.
function redact(text: string): string {
  const secrets = Object.entries(process.env)
    .filter(([name, value]) => name.endsWith('_TOKEN') && value)
    .map(([, value]) => value as string)
    .sort((a, b) => b.length - a.length);
  return secrets.reduce((t, s) => t.split(s).join('***'), text);
}

// Attempts are only ever appended: a failed run stays in the round next to the run that fixed it.
function nextAttempt(round: Round, name: string): number {
  return round.gates.filter((g) => g.name === name).length + 1;
}

export function runGate(
  store: LedgerStore,
  ref: PrRef,
  round: Round,
  name: string,
  argv: string[],
  cwd: string,
): GateAttempt {
  const attempt = nextAttempt(round, name);
  const r = runCapture(argv, cwd);
  const text = redact(r.error === undefined ? r.output : `${r.output}${r.error}\n`);
  const logPath = store.writeLog(ref, round.n, name, attempt, text);
  const g: GateAttempt = {
    name,
    attempt,
    argv,
    exitCode: r.status,
    result: r.status === 0 ? 'pass' : 'fail',
    log: path.relative(store.dirFor(ref), logPath).split(path.sep).join('/'),
    at: new Date().toISOString(),
  };
  round.gates.push(g);
  return g;
}

export function notChecked(round: Round, name: string, reason: string): GateAttempt {
  if (!reason.trim()) throw new Error(`gate ${name}: a not-checked gate needs a reason`);
  const g: GateAttempt = {
    name,
    attempt: nextAttempt(round, name),
    argv: null,
    exitCode: null,
    result: 'not-checked',
    reason,
    at: new Date().toISOString(),
  };
  round.gates.push(g);
  return g;
}

/** The last attempt of each required gate decides; not-checked is neither missing nor failed. */
export function gateState(
  round: Round,
  required: string[],
): { missing: string[]; failed: string[]; notChecked: string[] } {
  const last = (name: string) => round.gates.findLast((g) => g.name === name);
  return {
    missing: required.filter((n) => !last(n)),
    failed: required.filter((n) => last(n)?.result === 'fail'),
    notChecked: required.filter((n) => last(n)?.result === 'not-checked'),
  };
}
