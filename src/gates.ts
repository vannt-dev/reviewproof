import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { gitEnv } from './git-env.ts';
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
  /** What the command ran on: the checkout's commit, and whether tracked files had changes. */
  head?: string;
  dirty?: boolean;
}

/** The checkout's commit and whether tracked files differ from it; nothing outside a git checkout. */
export function checkoutState(cwd: string): { head?: string; dirty?: boolean } {
  const git = (args: string[]) => execFileSync('git', args, { cwd, env: gitEnv(), encoding: 'utf8', stdio: 'pipe' }).trim();
  try {
    return { head: git(['rev-parse', 'HEAD']), dirty: git(['status', '--porcelain', '--untracked-files=no']) !== '' };
  } catch {
    return {};
  }
}

// The command runs as given; what is kept (the log, the command line in ledger.json and SARIF)
// shows no token value, even one passed as an argument. The checkout's state is taken before
// the run: that is what the command was given to check.
export function captureGate(argv: string[], cwd: string): GateRun {
  const state = checkoutState(cwd);
  const r = runCapture(argv, cwd);
  const redact = redactor();
  const text = r.error === undefined ? r.output : `${r.output}${r.error}\n`;
  return { argv: argv.map(redact), exitCode: r.status, text: redact(text), ...state };
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
    ...(run.head ? { head: run.head } : {}),
    ...(run.dirty ? { dirty: true as const } : {}),
    at: new Date().toISOString(),
  };
  round.gates.push(g);
  return g;
}

/**
 * Why an attempt is no evidence for the round: it ran on another commit, or with uncommitted
 * changes. Null when it counts (an attempt from before heads were recorded counts too).
 */
export function offHead(round: Round, g: GateAttempt): string | null {
  if (g.result === 'not-checked') return null;
  if (g.head && g.head !== round.head) return `ran at ${g.head.slice(0, 7)}, not at the round's head ${round.head.slice(0, 7)}`;
  if (g.dirty) return 'ran with uncommitted changes';
  return null;
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

/**
 * The last attempt of each required gate decides; not-checked is neither missing nor failed.
 * `stale` holds the gates whose last attempt is no evidence for the round's head (see offHead).
 */
export function gateState(
  round: Round,
  required: string[],
): { missing: string[]; failed: string[]; notChecked: string[]; stale: { name: string; why: string }[] } {
  const last = (name: string) => round.gates.findLast((g) => g.name === name);
  const stale = required.flatMap((name) => {
    const g = last(name);
    const why = g ? offHead(round, g) : null;
    return why ? [{ name, why }] : [];
  });
  const counted = (n: string) => !stale.some((s) => s.name === n);
  return {
    missing: required.filter((n) => !last(n)),
    failed: required.filter((n) => last(n)?.result === 'fail' && counted(n)),
    notChecked: required.filter((n) => last(n)?.result === 'not-checked'),
    stale,
  };
}
