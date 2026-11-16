import type { ReviewHistory } from './hosts.ts';
import type { NewFinding } from './types.ts';

export type LineComment = ReviewHistory['comments'][number];
export type ReviewBody = ReviewHistory['reviews'][number];

/**
 * The commit to replay the review at: where the first person reviewed (a review or a line
 * comment by someone other than the author and not a bot), so the replay sees what they saw.
 * With no human review it is the merged head.
 */
export function headToReview(h: ReviewHistory): { sha: string; why: string } {
  const human = [...h.reviews, ...h.comments]
    .filter((x) => !x.bot && x.by !== h.author)
    .sort((a, b) => a.at.localeCompare(b.at));
  const first = human[0];
  if (!first) return { sha: h.head, why: 'no human review: the merged head' };
  return { sha: first.commit, why: `the head of the first human review (${first.by}, ${first.at.slice(0, 10)})` };
}

/**
 * What people other than the author said: line comments that start a thread (a reply answers one,
 * it raises nothing new), and review bodies that hold text (an approval alone says nothing).
 */
export function humanComments(h: ReviewHistory): { lines: LineComment[]; bodies: ReviewBody[] } {
  const human = (x: { by: string; bot: boolean }): boolean => !x.bot && x.by !== h.author;
  return {
    lines: h.comments.filter((c) => human(c) && !c.reply),
    bodies: h.reviews.filter((r) => human(r) && r.body.trim() !== ''),
  };
}

export interface Comparison {
  caught: { comment: LineComment; finding: NewFinding }[];
  missed: LineComment[];
  /** Findings near no human comment: new points, or noise; a person judges which. */
  extra: NewFinding[];
}

/**
 * A finding catches a line comment in the same file within `near` lines of it; a comment on the
 * whole file is caught by any finding in that file. Lines are compared as numbers: a comment made
 * on a later commit than the replayed head may point a few lines off.
 */
export function compareFindings(findings: NewFinding[], comments: LineComment[], near: number): Comparison {
  const hits = (f: NewFinding, c: LineComment): boolean =>
    f.location.file === c.file && (c.line === null || Math.abs(f.location.line - c.line) <= near);
  const caught: Comparison['caught'] = [];
  const missed: LineComment[] = [];
  for (const c of comments) {
    const f = findings.find((x) => hits(x, c));
    if (f) caught.push({ comment: c, finding: f });
    else missed.push(c);
  }
  return { caught, missed, extra: findings.filter((f) => !comments.some((c) => hits(f, c))) };
}

const oneLine = (s: string, max = 200): string => {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

export const placeOf = (c: LineComment): string => (c.line === null ? c.file : `${c.file}:${c.line}`);

/**
 * The Markdown to append to the misses file: one section for this backtest with each miss whose
 * link the file does not hold yet; '' when every miss is already there.
 */
export function missesText(pr: string, head: string, missed: LineComment[], existing: string, now: Date): string {
  const fresh = missed.filter((c) => !existing.includes(c.url));
  if (fresh.length === 0) return '';
  const lines = fresh.map((c) => `- ${placeOf(c)} (${c.by}): ${oneLine(c.body)} (${c.url})`);
  return `## ${pr} (backtest ${now.toISOString().slice(0, 10)}, head ${head.slice(0, 7)})\n\n${lines.join('\n')}\n`;
}

export { oneLine };
