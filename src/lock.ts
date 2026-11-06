import fs from 'node:fs';
import path from 'node:path';

interface Seen {
  text: string;
  pid?: number;
  at: string;
}

const RETRY_MS = 50;
const pause = new Int32Array(new SharedArrayBuffer(4));
// Commands are synchronous between their awaits, so the wait is too; Atomics.wait sleeps without spinning.
const sleep = (ms: number): void => void Atomics.wait(pause, 0, 0, ms);

const codeOf = (e: unknown): unknown => (e as NodeJS.ErrnoException).code;

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
// Windows refuses an unlink for a moment while another process has the file open: retried.
// Never throws: a lock that stays behind is taken over, as its holder has exited or grown stale.
function remove(file: string, text: string): void {
  for (let tries = 0; tries < 20; tries++, sleep(10)) {
    try {
      if (fs.readFileSync(file, 'utf8') !== text) return;
      fs.unlinkSync(file);
      return;
    } catch (e) {
      if (codeOf(e) !== 'EPERM' && codeOf(e) !== 'EBUSY') return;
    }
  }
}

/**
 * Runs `fn` while holding `file`, which holds `{ pid, at }`; other processes wait for it. A lock
 * whose process is gone, or older than `staleMs`, is taken over. Two waiters judging the same
 * dead lock can both take it only if one's read and unlink straddle the other's whole takeover:
 * accepted, as a takeover only follows a crash.
 */
export function withLock<T>(file: string, fn: () => T, opts: { timeoutMs?: number; staleMs?: number } = {}): T {
  const { timeoutMs = 10_000, staleMs = 30_000 } = opts;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  let mine = create(file);
  while (mine === null) {
    const seen = read(file);
    if (Date.now() >= deadline) {
      throw new Error(`ledger is locked by pid ${seen?.pid ?? 'unknown'} since ${seen?.at ?? 'unknown'}; try again`);
    }
    if (seen !== null && stale(seen, staleMs)) remove(file, seen.text);
    else sleep(RETRY_MS);
    mine = create(file);
  }
  try {
    return fn();
  } finally {
    remove(file, mine);
  }
}
