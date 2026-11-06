import { spawnSync } from 'node:child_process';

export interface SpawnResult {
  status: number | null;
  output: string;
  error?: string;
}

const OPTS = { encoding: 'utf8', windowsHide: true, maxBuffer: 256 * 1024 * 1024 } as const;

// Node refuses to start npm, pnpm and yarn (.cmd shims) without a shell on Windows.
const quote = (a: string): string => (/^[\w./:=@+-]+$/.test(a) ? a : `"${a.replace(/"/g, '""')}"`);

function codeOf(e: Error | undefined): string | undefined {
  return e && 'code' in e && typeof e.code === 'string' ? e.code : undefined;
}

// cmd.exe reports an unknown program as exit 1, which would pass for a real failure; so a
// shell retry after ENOENT only happens when the program resolves on PATH (a .cmd shim).
function resolvesOnPath(program: string): boolean {
  return spawnSync('where', [program], { ...OPTS }).status === 0;
}

/** Runs argv without a shell in cwd; stdout then stderr in `output`. status null = never started. */
export function runCapture(argv: string[], cwd: string): SpawnResult {
  const [program, ...args] = argv;
  if (program === undefined) return { status: null, output: '', error: 'no command given' };
  let r = spawnSync(program, args, { ...OPTS, cwd });
  const code = codeOf(r.error);
  if (
    r.error &&
    process.platform === 'win32' &&
    (code === 'EINVAL' || (code === 'ENOENT' && resolvesOnPath(program)))
  ) {
    r = spawnSync(argv.map(quote).join(' '), { ...OPTS, cwd, shell: true });
  }
  const output = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  return r.error ? { status: null, output, error: r.error.message } : { status: r.status, output };
}
