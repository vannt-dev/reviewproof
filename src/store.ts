import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { writeAtomic } from './files.ts';
import { withLock } from './lock.ts';
import type { Ledger, PrRef } from './types.ts';

const LOCAL_FILES = ['active.json', '*.tmp', '*.lock'];

export class LedgerStore {
  private readonly home: string;

  constructor(home: string) {
    this.home = home;
  }

  // The project may hold slashes (owner/repo, group/sub/repo): one folder per segment.
  // A port's colon is not allowed in a Windows folder name.
  dirFor(ref: PrRef): string {
    return path.join(this.home, ref.hostname.replace(/:/g, '_'),...ref.project.split('/'), String(ref.number));
  }

  load(ref: PrRef): Ledger | null {
    const file = path.join(this.dirFor(ref), 'ledger.json');
    if (!fs.existsSync(file)) return null;
    const data = JSON.parse(fs.readFileSync(file, 'utf8')) as { schemaVersion?: unknown };
    if (data.schemaVersion !== 1) {
      throw new Error(`ledger schema ${String(data.schemaVersion)} is newer than this reviewproof (1)`);
    }
    return data as Ledger;
  }

  // Readers take no lock (the hook, status), so they must never see a half-written ledger.
  save(l: Ledger): void {
    writeAtomic(path.join(this.dirFor(l.pr), 'ledger.json'), `${JSON.stringify(l, null, 2)}\n`);
  }

  /** One PR's commands take turns: each loads, changes and saves its ledger inside `fn`. */
  locked<T>(ref: PrRef, fn: () => T): T {
    return withLock(path.join(this.dirFor(ref), 'ledger.lock'), fn);
  }

  // Never overwrites: a failed run stays on the record. An existing log throws EEXIST.
  writeLog(ref: PrRef, round: number, name: string, attempt: number, text: string): string {
    const file = path.join(this.dirFor(ref), 'logs', `round-${round}`, `${name}-${attempt}.log`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text, { flag: 'wx' });
    return file;
  }

  draftFile(ref: PrRef, round: number): string {
    return path.join(this.dirFor(ref), 'drafts', `round-${round}.md`);
  }

  // post reads the draft without the lock: never half of one being rewritten.
  writeDraft(ref: PrRef, round: number, md: string): string {
    const file = this.draftFile(ref, round);
    writeAtomic(file, md);
    return file;
  }

  // A re-run that changed nothing must not fail on git's "nothing to commit". Every PR commits to
  // this one repository, and git refuses a second command while one holds its index.
  commit(message: string): void {
    withLock(path.join(this.home, 'commit.lock'), () => {
      if (!fs.existsSync(path.join(this.home, '.git'))) this.git('init');
      this.ignoreLocal();
      if (this.git('status', '--porcelain') === '') return;
      this.git('add', '-A');
      this.git('commit', '-m', message);
    });
  }

  // Checkout paths, temp and lock files are this machine's, not review history. A .gitignore the
  // home already has (hand-made, or from before the lock files) gets the missing patterns added.
  private ignoreLocal(): void {
    const ignore = path.join(this.home, '.gitignore');
    const text = fs.existsSync(ignore) ? fs.readFileSync(ignore, 'utf8') : '';
    const missing = LOCAL_FILES.filter((p) => !text.split(/\r?\n/).includes(p));
    if (missing.length === 0) return;
    fs.appendFileSync(ignore, `${text === '' || text.endsWith('\n') ? '' : '\n'}${missing.join('\n')}\n`);
  }

  private git(...args: string[]): string {
    return execFileSync('git', ['-C', this.home, ...args], { stdio: 'pipe', encoding: 'utf8' });
  }
}
