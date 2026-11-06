import fs from 'node:fs';
import path from 'node:path';
import type { LedgerStore } from './store.ts';
import type { PrRef, ReadMark, Round } from './types.ts';

// Parallel hooks must not rewrite ledger.json, so each hook appends one line to its own file.
export function appendRead(store: LedgerStore, ref: PrRef, round: number, mark: ReadMark): void {
  const dir = path.join(store.dirFor(ref), 'reads');
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, `round-${round}.jsonl`), `${JSON.stringify(mark)}\n`);
}

export function allReads(store: LedgerStore, ref: PrRef, round: Round): ReadMark[] {
  const marks = [...round.reads];
  let text: string;
  try {
    text = fs.readFileSync(path.join(store.dirFor(ref), 'reads', `round-${round.n}.jsonl`), 'utf8');
  } catch {
    return marks;
  }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      marks.push(JSON.parse(line) as ReadMark);
    } catch {
      // A torn or foreign line must not hide the other reads.
    }
  }
  return marks;
}
