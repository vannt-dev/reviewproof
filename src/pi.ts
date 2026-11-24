import { handleHook, type PiToolResult } from './hook.ts';
import { defaultHome } from './store.ts';

// The Pi coding agent's extension API, as far as this extension uses it.
interface PiEvent {
  toolName?: unknown;
  input?: PiToolResult['input'];
  content?: unknown;
  details?: PiToolResult['details'];
  isError?: unknown;
  parentToolCallId?: unknown;
}
interface PiApi {
  on(event: 'tool_result', handler: (event: PiEvent, ctx: { cwd?: unknown }) => void): void;
}

const hasImage = (content: unknown): boolean =>
  Array.isArray(content) && content.some((c) => (c as { type?: unknown } | null)?.type === 'image');

/**
 * reviewproof's extension for Pi: every file Pi's read tool shows the model becomes review
 * evidence in the active review round, as the Claude Code hook records a Read. It never changes
 * a result and never throws.
 */
export default function reviewproof(pi: PiApi): void {
  pi.on('tool_result', (event, ctx) => {
    try {
      if (event.toolName !== 'read') return;
      const result: PiToolResult = {
        pi_event: 'tool_result',
        toolName: event.toolName,
        input: event.input,
        isError: event.isError,
        details: event.details,
        parentToolCallId: event.parentToolCallId,
        image: hasImage(event.content),
        cwd: ctx?.cwd,
      };
      handleHook(result, defaultHome());
    } catch {
      // nothing to record
    }
  });
}
