import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { Ledger, PrRef } from './types.ts';

export class LedgerStore {
  private readonly home: string;

  constructor(home: string) {
    this.home = home;
  }

  // The project may hold slashes (owner/repo, group/sub/repo): one folder per segment.
  dirFor(ref: PrRef): string {
    return path.join(this.home, ref.hostname, ...ref.project.split('/'), String(ref.number));
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

  writeLog(ref: PrRef, round: number, name: string, attempt: number, text: string): string {
    return this.write(path.join(this.dirFor(ref), 'logs', `round-${round}`, `${name}-${attempt}.log`), text);
  }

  writeDraft(ref: PrRef, round: number, md: string): string {
    return this.write(path.join(this.dirFor(ref), 'drafts', `round-${round}.md`), md);
  }

  commit(message: string): void {
    if (!fs.existsSync(path.join(this.home, '.git'))) {
      fs.mkdirSync(this.home, { recursive: true });
      this.git('init');
    }
    this.git('add', '-A');
    this.git('commit', '-m', message);
  }

  private write(file: string, text: string): string {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    return file;
  }

  private git(...args: string[]): void {
    execFileSync('git', ['-C', this.home, ...args], { stdio: 'pipe' });
  }
}
