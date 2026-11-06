import { parseLocation } from './location.ts';
import type { Location, NewFinding, Severity, SourceKind } from './types.ts';

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

  const at = resolveAt(text(input.at), head, lineCount);
  if ('error' in at) errors.push(at.error);
  if (errors.length > 0 || !('location' in at)) return { errors };

  const body = text(input.body);
  const finding: NewFinding = {
    severity: input.severity as Severity,
    source: { kind: source.kind as SourceKind, ref: text(source.ref) },
    location: at.location,
    title: text(input.title),
    ...(body === '' ? {} : { body }),
  };
  return { finding, errors };
}

/** `file:line[@sha]` as a location at the round head; findings and `mark --at` share it. */
export function resolveAt(
  at: string,
  head: string,
  lineCount: (file: string) => number | null,
): { location: Location } | { error: string } {
  // One parsing path: a bare file:line gets the round head so parseLocation judges it.
  // Only a trailing @<hex> counts as a sha; an @ inside a path (monorepo scopes) does not.
  const withSha = /@[0-9a-f]{7,40}$/i.test(at) ? at : `${at}@${head}`;
  let loc: Location;
  try {
    loc = parseLocation(withSha);
  } catch (e) {
    return { error: `at: ${(e as Error).message}` };
  }
  // A prefix of the head is accepted (parseLocation already demands >= 7 hex) and widened to the full head.
  if (!head.toLowerCase().startsWith(loc.sha.toLowerCase())) {
    return { error: `at: sha ${loc.sha} is not the round head ${head}` };
  }
  loc.sha = head;
  const count = lineCount(loc.file);
  if (count === null) return { error: `at: file ${loc.file} does not exist at the round head` };
  if (loc.line > count) return { error: `at: line ${loc.line} is past the end of ${loc.file} (${count} lines)` };
  return { location: loc };
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
