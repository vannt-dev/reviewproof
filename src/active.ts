import fs from 'node:fs';
import path from 'node:path';
import type { PrRef } from './types.ts';

type ActiveMap = Record<string, { ref: PrRef }>;

// One spelling per path on every OS: realpath fixes case and 8.3 short names for paths that
// exist; for the rest, resolve and lower-case on Windows only. Always `/` separators.
export function canon(p: string): string {
  let out: string;
  try {
    out = fs.realpathSync.native(p);
  } catch {
    out = path.resolve(p);
    if (process.platform === 'win32') out = out.toLowerCase();
  }
  return out.replace(/\\/g, '/');
}

// Windows paths differ in case only, so compare folded there.
const key = (p: string): string => (process.platform === 'win32' ? p.toLowerCase() : p);

function inside(checkout: string, file: string): boolean {
  return key(file).startsWith(`${key(checkout).replace(/\/$/, '')}/`);
}

export function relativeTo(checkout: string, file: string): string {
  return file.slice(checkout.replace(/\/$/, '').length + 1);
}

function load(home: string): ActiveMap {
  try {
    return JSON.parse(fs.readFileSync(path.join(home, 'active.json'), 'utf8')) as ActiveMap;
  } catch {
    return {};
  }
}

function save(home: string, map: ActiveMap): void {
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'active.json'), `${JSON.stringify(map, null, 2)}\n`);
}

export function setActive(home: string, checkout: string, ref: PrRef): void {
  const map = load(home);
  map[canon(checkout)] = { ref };
  save(home, map);
}

export function clearActive(home: string, checkout: string): void {
  const map = load(home);
  delete map[canon(checkout)];
  save(home, map);
}

// The longest matching checkout wins, so a checkout nested in another resolves to itself.
export function activeFor(home: string, anyPath: string): { checkout: string; ref: PrRef } | null {
  const file = canon(anyPath);
  let best: { checkout: string; ref: PrRef } | null = null;
  for (const [checkout, { ref }] of Object.entries(load(home))) {
    if (inside(checkout, file) && (!best || checkout.length > best.checkout.length)) {
      best = { checkout, ref };
    }
  }
  return best;
}
