import { activeFor, canon, relativeTo } from './active.ts';
import { appendRead } from './reads.ts';
import { LedgerStore } from './store.ts';
import type { ReadMark } from './types.ts';

const POST = /\breviewproof(\.js)?\s+post\b/;

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
  const { offset, limit } = input;
  // Claude Code's Read offset is a 1-based line number; a lone offset has no end, so no range.
  if (typeof offset === 'number' && typeof limit === 'number') mark.range = [offset, offset + limit - 1];
  if (response?.includes('PARTIAL view')) mark.partial = true;
  if (typeof e.agent_id === 'string') mark.agent = e.agent_id;
  appendRead(store, active.ref, round.n, mark);
}
