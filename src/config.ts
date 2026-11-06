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

// A bad file must say which file, or the reader hunts for it.
function parseObject(file: string): Record<string, unknown> {
  let data: unknown;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`${file} is not valid JSON: ${(e as Error).message}`);
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new Error(`${file} must hold a JSON object`);
  }
  return data as Record<string, unknown>;
}

// Checkout file wins over the home file; the first one found is used whole.
export function loadConfig(checkout: string, home: string): Config {
  const file = [path.join(checkout, '.reviewproof.json'), path.join(home, 'config.json')].find((f) =>
    fs.existsSync(f),
  );
  const raw = file ? parseObject(file) : {};
  const list = (key: keyof Config): string[] => {
    const v = raw[key];
    return Array.isArray(v) && v.every((s) => typeof s === 'string') ? v : [...DEFAULTS[key]];
  };
  return { requiredGates: list('requiredGates'), skip: list('skip'), hedgeWords: list('hedgeWords') };
}
