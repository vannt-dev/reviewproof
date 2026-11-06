import fs from 'node:fs';
import path from 'node:path';

export interface Config {
  requiredGates: string[];
  skip: string[];
  hedgeWords: string[];
}

const DEFAULTS: Config = {
  requiredGates: [],
  skip: ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', '**/*.snap'],
  hedgeWords: ['probably', 'seems', 'might', 'maybe', 'likely'],
};

// Checkout file wins over the home file; the first one found is used whole.
export function loadConfig(checkout: string, home: string): Config {
  const file = [path.join(checkout, '.reviewproof.json'), path.join(home, 'config.json')].find((f) =>
    fs.existsSync(f),
  );
  const raw: Record<string, unknown> = file ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  const list = (key: keyof Config): string[] => {
    const v = raw[key];
    return Array.isArray(v) && v.every((s) => typeof s === 'string') ? v : [...DEFAULTS[key]];
  };
  return { requiredGates: list('requiredGates'), skip: list('skip'), hedgeWords: list('hedgeWords') };
}
