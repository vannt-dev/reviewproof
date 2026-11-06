import path from 'node:path';
import { captureGate, notChecked, recordGate } from '../gates.ts';
import { assertOpen, locked, openReview, saveChange, str, take, type Command } from './context.ts';
import { reading } from './reading.ts';

// The name becomes a log file name (logs/round-<n>/<name>-<attempt>.log), on every OS.
function gateName(name: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
    throw new Error(`gate name "${name}": use letters, digits, ., _ and -, from a letter or digit (e.g. test-unit)`);
  }
  return name;
}

const gateRun: Command = {
  args: '<name> -- <command...>',
  about: 'run a gate (no shell) and keep its log; exit 1 when it failed',
  tail: true,
  async run(env, a) {
    const name = gateName(take(a, '<name>')[0]);
    if (a.tail.length === 0) throw new Error('the gate command goes after --');
    const seen = assertOpen(openReview(env));
    // The command may take minutes, so it runs before the lock; other commands go on meanwhile.
    const ran = captureGate(a.tail, env.cwd);
    const g = locked(env, seen, (r) => {
      const g = recordGate(env.store, r.ref, assertOpen(r).round, name, ran);
      saveChange(env, r);
      return g;
    });
    const log = path.join(env.store.dirFor(seen.ref), g.log ?? '');
    console.log(`gate ${name} attempt ${g.attempt}: ${g.result} (exit code ${g.exitCode ?? 'none'}), log ${log}`);
    return g.result === 'pass' ? 0 : 1;
  },
};

const gateSkip: Command = {
  args: '<name> --reason R',
  about: 'record a gate as not checked (verdict pass still refuses it)',
  options: { reason: { type: 'string' } },
  async run(env, a) {
    const name = gateName(take(a, '<name>')[0]);
    const g = locked(env, openReview(env), (r) => {
      const g = notChecked(assertOpen(r).round, name, str(a, 'reason') ?? '');
      saveChange(env, r);
      return g;
    });
    console.log(`gate ${name} attempt ${g.attempt}: not checked (${g.reason})`);
    return 0;
  },
};

export const checks: Record<string, Command> = { 'gate run': gateRun, 'gate skip': gateSkip, ...reading };
