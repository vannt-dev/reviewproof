import type { ChangedFile } from './diff.ts';
import { whereNow } from './draft.ts';
import type { InlineComment } from './hosts.ts';
import { currentStatus } from './rounds.ts';
import type { Ledger, Round } from './types.ts';

export interface InlinePlan {
  /** Open findings on an added line of the pull request's diff. */
  inline: InlineComment[];
  /** Open findings the hosts take no line comment on: the summary note holds them. */
  summaryOnly: { finding: string; at: string }[];
}

/**
 * Splits the round's open findings by whether their line is an added line of the pull request's
 * diff (`changed`: merge-base to the round's head, no context lines). Hosts accept a comment on
 * such a line by its new line number alone; anything else stays in the summary note only.
 */
export function inlinePlan(l: Ledger, round: Round, changed: ChangedFile[]): InlinePlan {
  const plan: InlinePlan = { inline: [], summaryOnly: [] };
  const open = l.findings.filter((f) => ['open', 'reopened'].includes(currentStatus(f)));
  for (const f of open) {
    const loc = whereNow(f);
    const file = changed.find((c) => c.file === loc.file && c.status !== 'D' && !c.binary);
    const onLine = file?.ranges.some(([a, b]) => loc.line >= a && loc.line <= b) ?? false;
    if (loc.sha !== round.head || !file || !onLine) {
      plan.summaryOnly.push({ finding: f.id, at: `${loc.file}:${loc.line}` });
      continue;
    }
    const tag = `${f.severity}, ${f.source.kind}: ${f.source.ref}${currentStatus(f) === 'reopened' ? ', reopened' : ''}`;
    const body = [`**${f.id} ${f.title}** (${tag})`, ...(f.body?.trim() ? ['', f.body.trim()] : [])].join('\n');
    plan.inline.push({ finding: f.id, file: loc.file, ...(file.from ? { from: file.from } : {}), line: loc.line, body });
  }
  return plan;
}
