import fs from 'node:fs';
import path from 'node:path';
import { codeOf, sleep, whileBusy } from './files.ts';

interface Seen {
  text: string;
  pid?: number;
  at: string;
}

const RETRY_MS = 50;

// EPERM: the process exists but belongs to another user.
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return codeOf(e) === 'EPERM';
  }
}

// The holder's text, or null while another process holds the file (on Windows a lock being
// deleted answers EPERM, not EEXIST).
function create(file: string): string | null {
  const text = JSON.stringify({ pid: process.pid, at: new Date().toISOString() });
  try {
    fs.writeFileSync(file, text, { flag: 'wx' });
    return text;
  } catch (e) {
    if (codeOf(e) === 'EEXIST' || codeOf(e) === 'EPERM') return null;
    throw e;
  }
}

// null: gone, or not readable this instant.
function read(file: string): Seen | null {
  try {
    const text = fs.readFileSync(file, 'utf8');
    const at = fs.statSync(file).mtime.toISOString();
    try {
      return { text, at, ...(JSON.parse(text) as { pid?: number; at?: string }) };
    } catch {
      // Being written this instant, or torn by a crash: only its age can free it.
      return { text, at };
    }
  } catch {
    return null;
  }
}

function stale(seen: Seen, staleMs: number): boolean {
  if (Date.now() - Date.parse(seen.at) > staleMs) return true;
  return typeof seen.pid === 'number' && !alive(seen.pid);
}

// Only while the file still holds `text`, so a lock taken over meanwhile stays its new owner's.
// Never throws: a lock that stays behind is taken over, as its holder has exited or grown stale.
function remove(file: string, text: string): void {
  try {
    whileBusy(() => {
      if (fs.readFileSync(file, 'utf8') === text) fs.unlinkSync(file);
    });
  } catch {
    // gone already, or still busy after the retries
  }
}

/**
 * Runs `fn` while holding `file`, which holds `{ pid, at }`; other processes wait for it. A lock
 * whose process is gone, or held for longer than `staleMs`, is taken over. Two waiters judging the
 * same lock stale can both take it only if one's read and unlink straddle the other's whole
 * takeover: accepted, as a takeover only follows a crash or a hold far longer than any command's.
 */
export function withLock<T>(file: string, fn: () => T, opts: { timeoutMs?: number; staleMs?: number } = {}): T {
  const { timeoutMs = 10_000, staleMs = 30_000 } = opts;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  let mine = create(file);
  while (mine === null) {
    const seen = read(file);
    if (Date.now() >= deadline) {
      throw new Error(`${file} is locked by pid ${seen?.pid ?? 'unknown'} since ${seen?.at ?? 'unknown'}; try again`);
    }
    // A stale lock is taken over at once; a takeover lost to another waiter waits its turn.
    if (seen !== null && stale(seen, staleMs)) {
      remove(file, seen.text);
      mine = create(file);
      if (mine !== null) break;
    }
    sleep(RETRY_MS);
    mine = create(file);
  }
  try {
    return fn();
  } finally {
    remove(file, mine);
  }
}
