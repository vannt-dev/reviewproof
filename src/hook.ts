import { activeFor, canon, relativeTo } from './active.ts';
import { appendRead } from './reads.ts';
import { LedgerStore } from './store.ts';
import type { ReadMark } from './types.ts';

// Also npx reviewproof@0.1.0 post, reviewproof.cmd / .ps1, a quoted ...\reviewproof.js" post, any case.
const POST = /\breviewproof(?:[@.][^\s"']*)?["']?\s+(?:\S+\s+)*?post(?![\w.-])/i;

const DENY = JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: 'deny',
    permissionDecisionReason: 'Only the person posts: they run ! reviewproof post --approved-by <name>',
  },
});

interface HookEvent {
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: { file_path?: unknown; offset?: unknown; limit?: unknown; command?: unknown };
  tool_response?: unknown;
  agent_id?: unknown;
}

// Never throws and never blocks a tool call: anything unexpected answers null.
export function handleHook(event: unknown, home: string): string | null {
  try {
    if (typeof event !== 'object' || event === null) return null;
    const e = event as HookEvent;
    if (e.hook_event_name === 'PreToolUse') return denyPost(e);
    if (e.hook_event_name === 'PostToolUse' && e.tool_name === 'Read') recordRead(e, home);
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
