import { parseArgs } from 'node:util';
import { checks } from './commands/checks.ts';
import { envFrom, type Command, type Deps } from './commands/context.ts';
import { finish } from './commands/finish.ts';
import { review } from './commands/review.ts';
import { statusCommands } from './commands/status.ts';
import { handleHook } from './hook.ts';

const hook: Command = {
  args: '',
  about: 'Claude Code hook: one event on stdin (installed by the plugin)',
  async run(env) {
    // A hook must never break the tool call it watches: bad input is ignored, exit is 0.
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
      const out = handleHook(JSON.parse(Buffer.concat(chunks).toString('utf8')), env.home);
      if (out !== null) console.log(out);
    } catch {
      // nothing to record
    }
    return 0;
  },
};

const COMMANDS: Record<string, Command> = { ...review, ...statusCommands, ...checks, ...finish, hook };

function help(): string {
  const rows = Object.entries(COMMANDS).map(([name, c]) => [`${name} ${c.args}`.trim(), c.about] as const);
  const width = Math.max(...rows.map(([usage]) => usage.length));
  return [
    'reviewproof: a review ledger per pull request that refuses unchecked review claims',
    '',
    'Run inside the checkout of the pull request. Commands:',
    ...rows.map(([usage, about]) => `  ${usage.padEnd(width)}  ${about}`),
    '',
    'A <pr> is https://github.com/o/r/pull/12, o/r#12, a GitLab merge request URL or gitlab:g/r!7.',
    'Ledgers live in REVIEWPROOF_HOME (default ~/.reviewproof), a git repository.',
  ].join('\n');
}

/** The whole command line; returns the exit code. Errors go to stderr. */
export async function run(argv: string[], deps: Deps = {}): Promise<number> {
  // Everything after the first "--" is a gate's command, passed through untouched.
  const dash = argv.indexOf('--');
  const words = dash < 0 ? argv : argv.slice(0, dash);
  const tail = dash < 0 ? [] : argv.slice(dash + 1);
  if (words.length === 0 || words.includes('--help') || words.includes('-h')) {
    console.log(help());
    return words.length === 0 ? 1 : 0;
  }
  const pair = words.slice(0, 2).join(' ');
  const name = pair in COMMANDS ? pair : (words[0] as string);
  const cmd = COMMANDS[name];
  if (!cmd) {
    console.error(`unknown command "${name}": see reviewproof --help`);
    return 1;
  }
  try {
    const { values, positionals } = parseArgs({
      args: words.slice(name.split(' ').length),
      options: cmd.options ?? {},
      allowPositionals: true,
      strict: true,
    });
    return await cmd.run(envFrom(deps), { values, positionals: cmd.tail ? positionals : [...positionals, ...tail], tail });
  } catch (e) {
    console.error(`reviewproof ${name}: ${(e as Error).message}`);
    return 1;
  }
}
