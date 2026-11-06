import fs from 'node:fs';
import path from 'node:path';

const pause = new Int32Array(new SharedArrayBuffer(4));
// Commands are synchronous between their awaits, so waits are too; Atomics.wait sleeps without spinning.
export const sleep = (ms: number): void => void Atomics.wait(pause, 0, 0, ms);

export const codeOf = (e: unknown): unknown => (e as NodeJS.ErrnoException).code;

const BUSY: unknown[] = ['EPERM', 'EACCES', 'EBUSY'];

/**
 * fn, retried every 50 ms for up to 2 s while the file is busy: Windows refuses to replace or
 * delete a file for as long as another process (an unlocked reader: the hook, status) has it open.
 */
export function whileBusy<T>(fn: () => T): T {
  for (let waited = 0; ; waited += 50) {
    try {
      return fn();
    } catch (e) {
      if (!BUSY.includes(codeOf(e)) || waited >= 2000) throw e;
      sleep(50);
    }
  }
}

/** A temp file in the same folder, then a rename: a reader never sees a half-written file. */
export function writeAtomic(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  try {
    whileBusy(() => fs.renameSync(tmp, file));
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}
