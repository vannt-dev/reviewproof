import path from 'node:path';
import { runCapture } from './spawn.ts';
import type { LedgerStore } from './store.ts';
import type { GateAttempt, PrRef, Round } from './types.ts';

// Longest values first, so a token that contains another one is replaced whole.
function redactor(): (text: string) => string {
  const secrets = Object.entries(process.env)
    .filter(([name, value]) => name.endsWith('_TOKEN') && value)
    .map(([, value]) => value as string)
    .sort((a, b) => b.length - a.length);
  return (text) => secrets.reduce((t, s) => t.split(s).join('***'), text);
}

// Attempts are only ever appended: a failed run stays in the round next to the run that fixed it.
// After the highest one, not the count: a skipped number (see newLog) is never handed out twice.
function nextAttempt(round: Round, name: string): number {
  return Math.max(0, ...round.gates.filter((g) => g.name === name).map((g) => g.attempt)) + 1;
}

/** A gate command's outcome. Nothing is recorded yet, so it runs outside the ledger lock. */
export interface GateRun {
  argv: string[];
  exitCode: number | null;
  text: string;
}

// The command runs as given; what is kept (the log, the command line in ledger.json and SARIF)
// shows no token value, even one passed as an argument.
export function captureGate(argv: string[], cwd: string): GateRun {
  const r = runCapture(argv, cwd);
  const redact = redactor();
  const text = r.error === undefined ? r.output : `${r.output}${r.error}\n`;
  return { argv: argv.map(redact), exitCode: r.status, text: redact(text) };
}

// A log already there is an attempt the ledger does not hold (its save was lost): it keeps its
// number and its text, and this run takes the next number.
function newLog(store: LedgerStore, ref: PrRef, round: Round, name: string, text: string): { attempt: number; file: string } {
  for (let attempt = nextAttempt(round, name); ; attempt++) {
    try {
      return { attempt, file: store.writeLog(ref, round.n, name, attempt, text) };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
  }
}

/** Numbers the attempt and keeps its log: under the ledger lock, on the ledger loaded there. */
export function recordGate(store: LedgerStore, ref: PrRef, round: Round, name: string, run: GateRun): GateAttempt {
  const { attempt, file } = newLog(store, ref, round, name, run.text);
  const g: GateAttempt = {
    name,
    attempt,
    argv: run.argv,
    exitCode: run.exitCode,
    result: run.exitCode === 0 ? 'pass' : 'fail',
    log: path.relative(store.dirFor(ref), file).split(path.sep).join('/'),
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
