import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { activeFor, canon, relativeTo } from './active.ts';
import { appendRead } from './reads.ts';
import { type Dialect, displayPath, outputLines, shellDisplays, shownRanges } from './shell-reads.ts';
import { LedgerStore } from './store.ts';
import type { ReadMark } from './types.ts';

// Also npx reviewproof@0.1.0 post, reviewproof.cmd / .ps1, a quoted ...\reviewproof.js" post, any case.
const POST = /\breviewproof(?:[@.][^\s"']*)?["']?\s+(?:-\S*\s+)*post(?![\w.-])/i;

const DENY = JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: 'deny',
    permissionDecisionReason: 'Only the person posts: run reviewproof post --approved-by <name> in your own terminal, outside Claude Code',
  },
});

interface HookEvent {
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: { file_path?: unknown; offset?: unknown; limit?: unknown; command?: unknown };
  tool_response?: unknown;
  agent_id?: unknown;
  cwd?: unknown;
}

/**
 * A finished Pi tool call, as reviewproof's Pi extension passes it on: Pi's `tool_result` event
 * without the content, plus the session's folder and whether the content held an image.
 */
export interface PiToolResult {
  pi_event: 'tool_result';
  toolName?: unknown;
  input?: { path?: unknown; offset?: unknown; limit?: unknown };
  isError?: unknown;
  details?: {
    truncation?: { truncated?: unknown; outputLines?: unknown; firstLineExceedsLimit?: unknown };
    imageUnsupportedByModel?: unknown;
  };
  parentToolCallId?: unknown;
  image?: unknown;
  cwd?: unknown;
}

// Never throws and never blocks a tool call: anything unexpected answers null.
export function handleHook(event: unknown, home: string): string | null {
  try {
    if (typeof event !== 'object' || event === null) return null;
    if ((event as PiToolResult).pi_event === 'tool_result') {
      recordPiRead(event as PiToolResult, home);
      return null;
    }
    const e = event as HookEvent;
    if (e.hook_event_name === 'PreToolUse') return denyPost(e);
    if (e.hook_event_name === 'PostToolUse' && e.tool_name === 'Read') recordRead(e, home);
    if (e.hook_event_name === 'PostToolUse' && (e.tool_name === 'Bash' || e.tool_name === 'PowerShell')) {
      recordShellReads(e, home);
    }
    return null;
  } catch {
    return null;
  }
}

function denyPost(e: HookEvent): string | null {
  const cmd = e.tool_input?.command;
  const shell = e.tool_name === 'Bash' || e.tool_name === 'PowerShell';
  return shell && typeof cmd === 'string' && POST.test(cmd) ? DENY : null;
}

function recordRead(e: HookEvent, home: string): void {
  const input = e.tool_input;
  if (typeof input?.file_path !== 'string') return;
  const active = activeFor(home, input.file_path);
  if (!active) return;
  const store = new LedgerStore(home);
  const round = store.load(active.ref)?.rounds.at(-1);
  if (!round) return;
  const response = typeof e.tool_response === 'string' ? e.tool_response : JSON.stringify(e.tool_response);
  const mark: ReadMark = {
    file: relativeTo(active.checkout, canon(input.file_path)),
    via: 'hook',
    at: new Date().toISOString(),
  };
  // Claude Code's Read offset is a 1-based line number and it shows 2000 lines by default, so
  // every Read covers a known range. A limit below 1 is not a real Read: nothing is recorded.
  const offset = typeof input.offset === 'number' ? input.offset : 1;
  const limit = typeof input.limit === 'number' ? input.limit : 2000;
  if (limit < 1) return;
  mark.range = [offset, offset + limit - 1];
  if (response?.includes('PARTIAL view')) mark.partial = true;
  if (typeof e.agent_id === 'string') mark.agent = e.agent_id;
  appendRead(store, active.ref, round.n, mark);
}

/** Pi's lines per read when the call sets no limit, the same as Claude Code's. */
const PI_MAX_LINES = 2000;

// The file Pi's read tool opened: its path as written, a leading `@` dropped, `~` the home
// folder, relative to the session's folder.
function piPath(raw: string, cwd: string): string {
  const p = raw.replace(/^@/, '');
  if (p === '~') return os.homedir();
  if (/^~[/\\]/.test(p)) return path.join(os.homedir(), p.slice(2));
  return path.resolve(cwd, p);
}

function recordPiRead(e: PiToolResult, home: string): void {
  // A failed read showed nothing; a read made by another tool (a codemode script) was not shown
  // to the model as it is.
  if (e.toolName !== 'read' || e.isError === true || e.parentToolCallId !== undefined) return;
  // An image the model cannot take in reached it as a placeholder only.
  if (e.image === true && e.details?.imageUnsupportedByModel !== undefined) return;
  const input = e.input;
  if (typeof input?.path !== 'string' || !input.path || typeof e.cwd !== 'string') return;
  const file = piPath(input.path, e.cwd);
  const active = activeFor(home, file);
  if (!active) return;
  const store = new LedgerStore(home);
  const round = store.load(active.ref)?.rounds.at(-1);
  if (!round) return;
  const mark: ReadMark = { file: relativeTo(active.checkout, canon(file)), via: 'hook', at: new Date().toISOString() };
  if (e.image !== true) {
    // Pi's offset is a 1-based line number. It shows up to `limit` lines, at most 2000 lines and
    // 50 KB: when it cuts the text, its truncation details say how many whole lines it showed.
    const start = typeof input.offset === 'number' && input.offset >= 1 ? Math.floor(input.offset) : 1;
    const t = e.details?.truncation;
    let shown: number;
    if (t?.firstLineExceedsLimit === true) return;
    if (t?.truncated === true && typeof t.outputLines === 'number') shown = t.outputLines;
    else if (typeof input.limit === 'number') shown = Math.min(Math.floor(input.limit), PI_MAX_LINES);
    else shown = PI_MAX_LINES;
    if (shown < 1) return;
    mark.range = [start, start + shown - 1];
  }
  appendRead(store, active.ref, round.n, mark);
}

// What the model was shown of a shell command's output: Claude Code's stdout, or the text Codex
// passes for its Bash tool. Null when the model got something else (a preview of output too
// large to show, an image) or the call was stopped.
function shownOutput(response: unknown): string | null {
  if (typeof response === 'string') return response; // Codex: the output as the model got it
  if (typeof response !== 'object' || response === null) return null;
  const r = response as { stdout?: unknown; interrupted?: unknown; isImage?: unknown; persistedOutputPath?: unknown };
  // Claude Code saves a large output to a file and shows the model only its first 2 KB.
  if (r.persistedOutputPath !== undefined || r.interrupted === true || r.isImage === true) return null;
  return typeof r.stdout === 'string' ? r.stdout : null;
}

function recordShellReads(e: HookEvent, home: string): void {
  const command = e.tool_input?.command;
  if (typeof command !== 'string') return;
  // Codex passes no shell: its commands run in PowerShell on Windows and sh elsewhere, unless the
  // model picked another one, so the other dialect is tried when the first finds no file.
  const codex = typeof e.tool_response === 'string';
  const first: Dialect = e.tool_name === 'PowerShell' || (codex && process.platform === 'win32') ? 'powershell' : 'posix';
  let displays = shellDisplays(command, first);
  if (displays.length === 0 && codex) displays = shellDisplays(command, first === 'posix' ? 'powershell' : 'posix');
  if (displays.length === 0) return;
  const text = shownOutput(e.tool_response);
  if (!text) return;
  const output = outputLines(text);
  const cwd = typeof e.cwd === 'string' ? e.cwd : null;
  const at = new Date().toISOString();
  let from = 0;
  for (const d of displays) {
    const file = displayPath(d, cwd);
    if (file === null) continue;
    const active = activeFor(home, file);
    if (!active) continue;
    let content: string;
    try {
      content = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const shown = shownRanges(content, d, output, from);
    from = shown.next;
    if (shown.ranges.length === 0) continue;
    const store = new LedgerStore(home);
    const round = store.load(active.ref)?.rounds.at(-1);
    if (!round) continue;
    for (const range of shown.ranges) {
      const mark: ReadMark = { file: relativeTo(active.checkout, canon(file)), range, via: 'hook', at };
      if (typeof e.agent_id === 'string') mark.agent = e.agent_id;
      appendRead(store, active.ref, round.n, mark);
    }
  }
}
