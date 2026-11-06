import { parseLocation } from './location.ts';
import type { NewFinding, Severity, SourceKind } from './types.ts';

const SEVERITIES: readonly string[] = ['blocking', 'major', 'minor'] satisfies Severity[];
const KINDS: readonly string[] = ['rule', 'design', 'legacy', 'other'] satisfies SourceKind[];

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

export function lintFinding(
  input: unknown,
  head: string,
  lineCount: (file: string) => number | null,
): { finding?: NewFinding; errors: string[] } {
  if (!isObj(input)) return { errors: ['finding must be an object'] };
  const errors: string[] = [];
  const source = isObj(input.source) ? input.source : {};

  if (!SEVERITIES.includes(input.severity as string)) {
    errors.push(`severity must be one of ${SEVERITIES.join(', ')}`);
  }
  if (!KINDS.includes(source.kind as string)) {
    errors.push(`source.kind must be one of ${KINDS.join(', ')}`);
  }
  if (text(source.ref) === '') errors.push('source.ref is required (rule, design doc or legacy path)');
  if (text(input.title) === '') errors.push('title is required');

  const location = lintAt(text(input.at), head, lineCount, errors);
  if (errors.length > 0 || !location) return { errors };

  const body = text(input.body);
  const finding: NewFinding = {
    severity: input.severity as Severity,
    source: { kind: source.kind as SourceKind, ref: text(source.ref) },
    location,
    title: text(input.title),
    ...(body === '' ? {} : { body }),
  };
  return { finding, errors };
}

function lintAt(
  at: string,
  head: string,
  lineCount: (file: string) => number | null,
  errors: string[],
) {
  // One parsing path: a bare file:line gets the round head so parseLocation judges it.
  const withSha = at.includes('@') ? at : `${at}@${head}`;
  let loc;
  try {
    loc = parseLocation(withSha);
  } catch (e) {
    errors.push(`at: ${(e as Error).message}`);
    return undefined;
  }
  if (loc.sha !== head) {
    errors.push(`at: sha ${loc.sha} is not the round head ${head}`);
    return undefined;
  }
  const count = lineCount(loc.file);
  if (count === null) {
    errors.push(`at: file ${loc.file} does not exist at the round head`);
  } else if (loc.line > count) {
    errors.push(`at: line ${loc.line} is past the end of ${loc.file} (${count} lines)`);
  } else {
    return loc;
  }
  return undefined;
}

export function hedges(textIn: string, words: string[]): string[] {
  const found: string[] = [];
  for (const word of words) {
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'iu');
    if (re.test(textIn) && !found.includes(word)) found.push(word);
  }
  return found;
}
