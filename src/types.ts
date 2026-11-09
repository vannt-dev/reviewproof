export type Severity = 'blocking' | 'major' | 'minor';
export type SourceKind = 'rule' | 'design' | 'legacy' | 'other';
export type Status = 'open' | 'verified' | 'reopened' | 'withdrawn';

export interface Location {
  file: string;
  line: number;
  sha: string;
}

export interface StatusEntry {
  round: number;
  status: Status;
  evidence?: string;
  location?: Location;
}

export interface Finding {
  id: string;
  round: number;
  severity: Severity;
  source: { kind: SourceKind; ref: string };
  location: Location;
  title: string;
  body?: string;
  history: StatusEntry[];
}

export type NewFinding = Omit<Finding, 'id' | 'round' | 'history'>;

export interface GateAttempt {
  name: string;
  attempt: number;
  argv: string[] | null;
  exitCode: number | null;
  result: 'pass' | 'fail' | 'not-checked';
  reason?: string;
  log?: string;
  /** The commit the checkout was at when the command ran; absent in attempts recorded before 0.3. */
  head?: string;
  /** Tracked files had uncommitted changes when the command ran. */
  dirty?: true;
  at: string;
}

export interface ReadMark {
  file: string;
  range?: [number, number];
  via: 'hook' | 'diff' | 'manual';
  partial?: true;
  agent?: string;
  at: string;
}

export interface Round {
  n: number;
  head: string;
  base: string;
  from: string;
  startedAt: string;
  gates: GateAttempt[];
  reads: ReadMark[];
  skips: { file: string; reason: string }[];
  verdict?: { value: 'pass' | 'not-yet'; summary: string; at: string };
  /** When `draft` last rendered the note; post only sends a draft written after the verdict. */
  draftAt?: string;
  post?: { id: string; url: string; approvedBy: string; at: string };
}

export interface PrRef {
  host: 'github' | 'gitlab';
  hostname: string;
  project: string;
  number: number;
}

export interface Ledger {
  schemaVersion: 1;
  pr: PrRef & { url: string; title: string };
  rounds: Round[];
  findings: Finding[];
}
