import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { withLock } from './lock.ts';
import type { Ledger, PrRef } from './types.ts';

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

  // Temp file in the same folder, then rename: readers never see a half-written ledger.
  save(l: Ledger): void {
    const dir = this.dirFor(l.pr);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, `ledger.json.${process.pid}.tmp`);
    fs.writeFileSync(tmp, `${JSON.stringify(l, null, 2)}\n`);
    fs.renameSync(tmp, path.join(dir, 'ledger.json'));
  }

  /** One PR's commands take turns: each loads, changes and saves its ledger inside `fn`. */
  locked<T>(ref: PrRef, fn: () => T): T {
    return withLock(path.join(this.dirFor(ref), 'ledger.lock'), fn);
  }

  // Never overwrites: a failed run stays on the record. An existing log throws EEXIST.
  writeLog(ref: PrRef, round: number, name: string, attempt: number, text: string): string {
    return this.write(path.join(this.dirFor(ref), 'logs', `round-${round}`, `${name}-${attempt}.log`), text, 'wx');
  }

  draftFile(ref: PrRef, round: number): string {
    return path.join(this.dirFor(ref), 'drafts', `round-${round}.md`);
  }

  writeDraft(ref: PrRef, round: number, md: string): string {
    return this.write(this.draftFile(ref, round), md);
  }

  // A re-run that changed nothing must not fail on git's "nothing to commit". Every PR commits to
  // this one repository, and git refuses a second command while one holds its index.
  commit(message: string): void {
    withLock(path.join(this.home, 'commit.lock'), () => {
      if (!fs.existsSync(path.join(this.home, '.git'))) this.git('init');
      // Checkout paths, temp and lock files are this machine's, not review history (a hand-made home too).
      const ignore = path.join(this.home, '.gitignore');
      if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, 'active.json\n*.tmp\n*.lock\n');
      if (this.git('status', '--porcelain') === '') return;
      this.git('add', '-A');
      this.git('commit', '-m', message);
    });
  }

  private write(file: string, text: string, flag = 'w'): string {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text, { flag });
    return file;
  }

  private git(...args: string[]): string {
    return execFileSync('git', ['-C', this.home, ...args], { stdio: 'pipe', encoding: 'utf8' });
  }
}
