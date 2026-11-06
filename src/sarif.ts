import { carried, currentStatus } from './rounds.ts';
import type { Finding, Ledger, Round, Severity } from './types.ts';

const LEVEL: Record<Severity, string> = { blocking: 'error', major: 'warning', minor: 'note' };

// Where the round left the finding relative to the run before it, in SARIF's words.
function baselineState(f: Finding, n: number): string {
  if (f.round === n) return 'new';
  const entry = f.history.find((h) => h.round === n);
  if (!entry) return 'unchanged';
  return entry.status === 'reopened' ? 'updated' : 'absent';
}

function resultOf(f: Finding, round: Round): object {
  const entry = f.history.find((h) => h.round === round.n);
  const at = entry?.location ?? f.location;
  const out: Record<string, unknown> = {
    ruleId: f.source.ref,
    level: LEVEL[f.severity],
    message: { text: f.body ? `${f.title}\n\n${f.body}` : f.title },
    locations: [
      {
        physicalLocation: {
          artifactLocation: { uri: at.file.split('\\').join('/') },
          region: { startLine: at.line },
        },
      },
    ],
    partialFingerprints: { findingId: f.id },
    baselineState: baselineState(f, round.n),
    properties: { status: currentStatus(f) },
  };
  if (entry?.status === 'withdrawn') {
    out.suppressions = [{ kind: 'external', justification: entry.evidence ?? '' }];
  }
  return out;
}

// One invocation per gate; the last attempt decides, as it does for the verdict.
function invocationOf(round: Round, name: string): object {
  const last = round.gates.findLast((g) => g.name === name);
  return {
    executionSuccessful: last?.result === 'pass',
    commandLine: last?.argv?.join(' '),
    properties: { gate: name, result: last?.result ?? 'missing' },
  };
}

/** The latest round as SARIF 2.1.0: its own findings, the carried ones and the ones it settled. */
export function toSarif(l: Ledger, toolVersion: string, requiredGates?: string[]): object {
  const round = l.rounds[l.rounds.length - 1];
  if (!round) throw new Error('ledger has no round yet; start one first');
  const stillOpen = new Set(carried(l));
  const findings = l.findings.filter(
    (f) => f.round === round.n || stillOpen.has(f) || f.history.some((h) => h.round === round.n),
  );
  const rules = new Map<string, object>();
  for (const f of findings) {
    if (!rules.has(f.source.ref)) rules.set(f.source.ref, { id: f.source.ref, properties: { kind: f.source.kind } });
  }
  const gates = requiredGates ?? [...new Set(round.gates.map((g) => g.name))];
  return {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'reviewproof',
            version: toolVersion,
            informationUri: 'https://github.com/vannt-dev/reviewproof',
            rules: [...rules.values()],
          },
        },
        versionControlProvenance: [{ repositoryUri: l.pr.url, revisionId: round.head }],
        invocations: gates.map((n) => invocationOf(round, n)),
        results: findings.map((f) => resultOf(f, round)),
      },
    ],
  };
}
