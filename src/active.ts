import fs from 'node:fs';
import path from 'node:path';
import { writeAtomic } from './files.ts';
import { withLock } from './lock.ts';
import type { PrRef } from './types.ts';

type ActiveMap = Record<string, { ref: PrRef }>;

// One spelling per path on every OS. A file that does not exist yet still sits under folders that
// do (macOS /var -> /private/var, Windows 8.3 RUNNER~1), so realpath the nearest existing
// ancestor and append the rest; lower-case on Windows only when nothing resolves. `/` separators.
export function canon(p: string): string {
  const abs = path.resolve(p);
  const rest: string[] = [];
  for (let cur = abs; ; cur = path.dirname(cur)) {
    try {
      return path.join(fs.realpathSync.native(cur), ...rest).replace(/\\/g, '/');
    } catch {
      if (path.dirname(cur) === cur) break;
      rest.unshift(path.basename(cur));
    }
  }
  return (process.platform === 'win32' ? abs.toLowerCase() : abs).replace(/\\/g, '/');
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
// one before it, or one checkout would be lost. The hook reads without the lock: never half a file.
function update(home: string, change: (map: ActiveMap) => void): void {
  withLock(path.join(home, 'active.lock'), () => {
    const map = load(home);
    change(map);
    writeAtomic(path.join(home, 'active.json'), `${JSON.stringify(map, null, 2)}\n`);
  });
}

export function setActive(home: string, checkout: string, ref: PrRef): void {
  update(home, (map) => {
    map[canon(checkout)] = { ref };
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
