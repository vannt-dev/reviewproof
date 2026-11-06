import fs from 'node:fs';
import path from 'node:path';
import { withLock } from './lock.ts';
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

// The checkout folder itself counts: CLI commands look up the review by the checkout root.
function inside(checkout: string, file: string): boolean {
  const root = key(checkout).replace(/\/$/, '');
  return key(file) === root || key(file).startsWith(`${root}/`);
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

// Agents in other checkouts start their reviews at the same time; each change waits for the
// one before it, or one checkout would be lost.
function update(home: string, change: (map: ActiveMap) => void): void {
  withLock(path.join(home, 'active.lock'), () => {
    const map = load(home);
    change(map);
    fs.writeFileSync(path.join(home, 'active.json'), `${JSON.stringify(map, null, 2)}\n`);
  });
}

export function setActive(home: string, checkout: string, ref: PrRef): void {
  update(home, (map) => {
    map[canon(checkout)] = { ref };
  });
}

export function clearActive(home: string, checkout: string): void {
  update(home, (map) => {
    delete map[canon(checkout)];
  });
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
