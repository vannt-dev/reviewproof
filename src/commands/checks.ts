import path from 'node:path';
import { byName, ciResult, cleanCheck, findCheck, gateNameOf } from '../ci.ts';
import { captureGate, notChecked, recordCi, recordGate } from '../gates.ts';
import type { CiCheck } from '../hosts.ts';
import type { GateAttempt } from '../types.ts';
import { assertOpen, bullets, locked, openReview, saveChange, str, take, type Command } from './context.ts';
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
    if (g.head && g.head !== seen.round.head) {
      console.log(`note: the checkout is at ${g.head.slice(0, 7)}, not at the round's head ${seen.round.head.slice(0, 7)}: ` +
        'this attempt does not count for the verdict');
    } else if (g.dirty) {
      console.log('note: uncommitted changes in the checkout: this attempt does not count for the verdict');
    }
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

function ciLine(g: GateAttempt): string {
  const url = g.ci?.url ? `, ${g.ci.url}` : '';
  return `gate ${g.name} attempt ${g.attempt}: ${g.result} (ci check "${g.ci?.check}" ${g.ci?.conclusion} at ${g.head?.slice(0, 7)}${url})`;
}

// The check ran on the host, so the checkout's state does not matter: what ties it to the round
// is the commit the host names for it.
const gateCi: Command = {
  args: '<check> [--as NAME] | --all',
  about: "record a CI check at the round's head as a gate (GitHub); exit 1 when it failed",
  options: { as: { type: 'string' }, all: { type: 'boolean' } },
  async run(env, a) {
    const as = str(a, 'as');
    const all = a.values.all === true;
    if (all && as !== undefined) throw new Error('--as names one gate: it does not go with --all');
    if (all) take(a);
    const wanted = all ? undefined : take(a, '<check>')[0];
    if (as !== undefined) gateName(as);
    const seen = assertOpen(openReview(env));
    const head = seen.round.head;
    const host = env.host(seen.ref);
    if (!host.checks) throw new Error('only GitHub checks are read: record this gate with gate run or gate skip');
    // The host is asked before the lock, as a gate's command runs before it.
    const found = (await host.checks(seen.ref, head)).map(cleanCheck);
    const picked: { name: string; check: CiCheck; result: 'pass' | 'fail' }[] = [];
    const left: string[] = [];
    for (const check of wanted === undefined ? byName(found) : [findCheck(found, wanted, head)]) {
      const r = ciResult(check, head);
      if ('refused' in r) {
        if (!all) throw new Error(`check "${check.name}" ${r.refused}: nothing recorded`);
        left.push(`${check.name} ${r.refused}`);
        continue;
      }
      const name = as ?? gateNameOf(check.name);
      if (name === '') throw new Error(`check "${check.name}" has no letter or digit to name a gate: record it alone with --as NAME`);
      picked.push({ name, check, result: r.result });
    }
    const twice = picked.filter((p) => picked.some((q) => q !== p && q.name === p.name)).map((p) => p.check.name);
    if (twice.length > 0) {
      throw new Error(`these checks would share a gate name; record each alone with --as NAME:\n${bullets(twice)}`);
    }
    if (picked.length === 0) {
      throw new Error(`no finished check at the round's head ${head.slice(0, 7)}${left.length > 0 ? `:\n${bullets(left)}` : ''}`);
    }
    const gates = locked(env, seen, (r) => {
      const round = assertOpen(r).round;
      const gates = picked.map((p) => recordCi(round, p.name, p.check, p.result));
      saveChange(env, r);
      return gates;
    });
    for (const g of gates) console.log(ciLine(g));
    for (const l of left) console.log(`not recorded: ${l}`);
    return gates.every((g) => g.result === 'pass') ? 0 : 1;
  },
};

export const checks: Record<string, Command> = { 'gate run': gateRun, 'gate ci': gateCi, 'gate skip': gateSkip, ...reading };
