import type { Location } from './types.ts';

const SHA = /^[0-9a-f]{7,40}$/i;
const URL_RE = /\bhttps?:\/\/\S+/;
// Same shape as parseLocation accepts, but unanchored so it can find one inside prose.
const LOCATION_IN_TEXT = /[^\s:@]+:[1-9]\d*@[0-9a-f]{7,40}\b/i;

export function parseLocation(text: string): Location {
  const at = text.lastIndexOf('@');
  if (at < 0) throw new Error(`location "${text}" needs @<sha>`);
  const head = text.slice(0, at);
  const sha = text.slice(at + 1);
  if (!SHA.test(sha)) throw new Error(`location sha "${sha}" must be 7-40 hex characters`);

  const colon = head.lastIndexOf(':');
  if (colon < 0) throw new Error(`location "${text}" needs :<line> before @<sha>`);
  const file = head.slice(0, colon);
  const lineText = head.slice(colon + 1);
  if (!/^\d+$/.test(lineText) || Number(lineText) < 1) {
    throw new Error(`location line "${lineText}" must be an integer >= 1`);
  }

  // Drive letters, UNC and rooted paths would leak the author's machine layout.
  if (file === '' || file.startsWith('/') || file.startsWith('\\') ||/^[a-z]:/i.test(file)) {
    throw new Error(`location file "${file}" must be repo-relative`);
  }
  return { file, line: Number(lineText), sha };
}

export function formatLocation(l: Location): string {
  return `${l.file}:${l.line}@${l.sha}`;
}

export function isEvidence(text: string): boolean {
  return LOCATION_IN_TEXT.test(text) || URL_RE.test(text);
}
