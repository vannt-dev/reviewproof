import fs from 'node:fs';
import path from 'node:path';
import { toSarif } from '../sarif.ts';
import { openReview, str, take, type Command } from './context.ts';

// dist/ nests the sources one level deeper than src/ does, so look upwards for package.json.
function toolVersion(): string {
  let dir = import.meta.dirname;
  for (;;) {
    const file = path.join(dir, 'package.json');
    if (fs.existsSync(file)) return (JSON.parse(fs.readFileSync(file, 'utf8')) as { version: string }).version;
    const up = path.dirname(dir);
    if (up === dir) throw new Error('package.json not found next to reviewproof');
    dir = up;
  }
}

const exportCommand: Command = {
  args: '--sarif [--out FILE]',
  about: 'latest round as SARIF 2.1.0 (stdout, or FILE and its path)',
  options: { sarif: { type: 'boolean' }, out: { type: 'string' } },
  async run(env, a) {
    take(a);
    if (a.values.sarif !== true) throw new Error('say the format: --sarif');
    const r = openReview(env);
    const json = `${JSON.stringify(toSarif(r.ledger, toolVersion(), r.config.requiredGates), null, 2)}\n`;
    const out = str(a, 'out');
    if (out === undefined) {
      process.stdout.write(json);
    } else {
      const file = path.resolve(env.cwd, out);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, json);
      console.log(file);
    }
    return 0;
  },
};

export const exportCommands: Record<string, Command> = { export: exportCommand };
