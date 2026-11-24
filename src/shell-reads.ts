import fs from 'node:fs';
import path from 'node:path';

/**
 * Files a shell command prints, as far as the command alone says: which file, which of its lines
 * the output holds and in what order. Nothing here touches the disk; `shownRanges` then checks
 * the output against the file, so a read counts only when the output is the file's own lines.
 */

export type Dialect = 'posix' | 'powershell';

/** A step that keeps some lines of the stream (1-based positions in the stream so far). */
export type Pick =
  | { kind: 'head'; n: number }
  | { kind: 'tail'; n: number }
  | { kind: 'from'; n: number }
  | { kind: 'lines'; ranges: [number, number | null][] };

export interface Display {
  /** The path as written. */
  path: string;
  /** `git show rev:path`: the path is relative to the repository root unless it starts with ./ or ../ */
  repoRelative?: true;
  /** Folder the command ran in, relative to the hook's cwd, after a leading `cd`. */
  cd: string[];
  /** The output lines carry a line number before a tab (cat -n, nl). */
  numbered: boolean;
  picks: Pick[];
}

interface Word {
  kind: 'word';
  text: string;
  /** Something the shell expands or substitutes: the word's value is not known here. */
  dynamic: boolean;
}
type Op = { kind: 'op'; op: string };
type Token = Word | Op;

const GLOB = /[*?[\]{}]/;

// Splits a command into words and operators the way the shell would, quotes kept apart. Returns
// null for anything this cannot follow (an unclosed quote, a subshell, a block).
function tokenize(cmd: string, dialect: Dialect): Token[] | null {
  const ps = dialect === 'powershell';
  const out: Token[] = [];
  let i = 0;
  let cur: Word | null = null;
  const word = (): Word => (cur ??= { kind: 'word', text: '', dynamic: false });
  const end = (): void => {
    if (cur) out.push(cur);
    cur = null;
  };
  const escape = ps ? '`' : '\\';
  while (i < cmd.length) {
    const c = cmd[i] as string;
    if (c === ' ' || c === '\t') {
      end();
      i++;
      continue;
    }
    if (c === '\r') {
      i++;
      continue;
    }
    if (c === '#' && !cur) {
      while (i < cmd.length && cmd[i] !== '\n') i++;
      continue;
    }
    if (c === escape) {
      const next = cmd[i + 1];
      if (next === undefined) return null;
      if (next === '\n' || (next === '\r' && cmd[i + 2] === '\n')) {
        i += next === '\n' ? 2 : 3; // a line continuation
        continue;
      }
      word().text += next;
      i += 2;
      continue;
    }
    if (c === "'") {
      const w = word();
      i++;
      for (;;) {
        if (i >= cmd.length) return null;
        if (cmd[i] === "'") {
          if (ps && cmd[i + 1] === "'") {
            w.text += "'";
            i += 2;
            continue;
          }
          i++;
          break;
        }
        w.text += cmd[i];
        i++;
      }
      continue;
    }
    if (c === '"') {
      const w = word();
      i++;
      for (;;) {
        if (i >= cmd.length) return null;
        const d = cmd[i] as string;
        if (d === '"') {
          i++;
          break;
        }
        if (d === escape && i + 1 < cmd.length) {
          // In sh a backslash escapes only these inside double quotes; PowerShell's backtick any.
          const e = cmd[i + 1] as string;
          if (ps || '$`"\\\n'.includes(e)) {
            if (e !== '\n') w.text += e;
          } else w.text += d + e;
          i += 2;
          continue;
        }
        if (d === '$' || (!ps && d === '`')) w.dynamic = true;
        w.text += d;
        i++;
      }
      continue;
    }
    if (c === '\n' || c === ';') {
      end();
      out.push({ kind: 'op', op: ';' });
      i++;
      continue;
    }
    if (c === '|' || c === '&') {
      end();
      const two = cmd.slice(i, i + 2);
      if (two === '||' || two === '&&') {
        out.push({ kind: 'op', op: ';' });
        i += 2;
        continue;
      }
      if (c === '&' && cmd[i + 1] === '>') {
        out.push({ kind: 'op', op: '>' }); // &> sends stdout away too
        i += 2;
        continue;
      }
      out.push({ kind: 'op', op: c });
      i++;
      continue;
    }
    if (c === '>' || c === '<') {
      // A redirection: 2> (and 2>&1) keeps stdout where it was; anything else sends it away.
      const open = cur as Word | null; // set inside word()
      const fd = open !== null && !open.dynamic ? open.text : null;
      const stderrOnly = c === '>' && fd === '2';
      if (fd === '1' || fd === '2' || fd === '*') cur = null;
      else end();
      let j = i + 1;
      if (cmd[j] === '>') j++;
      let target = false;
      if (cmd[j] === '&') {
        j++;
        while (j < cmd.length && /[0-9-]/.test(cmd[j] as string)) j++;
        target = true;
      }
      i = j;
      const op = stderrOnly ? '2>' : c === '<' ? '<' : '>';
      out.push({ kind: 'op', op: target ? `${op}&` : op });
      continue;
    }
    if (c === '(' || c === ')' || (ps && (c === '{' || c === '}' || c === '@'))) return null;
    if (c === '$' || c === '`' || (ps && c === ',')) word().dynamic = true;
    const w = word();
    if (GLOB.test(c) || (c === '~' && w.text === '')) w.dynamic = true;
    w.text += c;
    i++;
  }
  end();
  return out;
}

interface Stage {
  words: Word[];
  /** stdout goes to a file or another stream, not to the output. */
  away: boolean;
}

// Statements (split at ; && || and newlines), each a pipeline of stages. Null when the command
// runs something in the background or reads from a redirection.
function statements(tokens: Token[]): Stage[][] | null {
  const all: Stage[][] = [];
  let pipe: Stage[] = [];
  let stage: Stage = { words: [], away: false };
  let skipTarget = false;
  const endStage = (): void => {
    pipe.push(stage);
    stage = { words: [], away: false };
  };
  for (const t of tokens) {
    if (t.kind === 'word') {
      if (skipTarget) skipTarget = false;
      else stage.words.push(t);
      continue;
    }
    if (t.op === '&' || t.op === '<') return null;
    if (t.op.startsWith('>') || t.op.startsWith('2>')) {
      if (t.op.startsWith('>')) stage.away = true;
      skipTarget = !t.op.endsWith('&');
      continue;
    }
    if (t.op === '|') {
      endStage();
      continue;
    }
    endStage();
    all.push(pipe.filter((s) => s.words.length > 0 || s.away));
    pipe = [];
  }
  endStage();
  all.push(pipe.filter((s) => s.words.length > 0 || s.away));
  return all.filter((p) => p.length > 0);
}

const int = (s: string | undefined): number | null => (s !== undefined && /^\d+$/.test(s) ? Number(s) : null);

/** The value of an option given as `-n 5`, `-n5`, `--lines=5` or `--lines 5`. */
function optionValue(args: string[], i: number, short: string, long: string): { value: string; used: number } | null {
  const a = args[i] as string;
  if (a === short || a === long) return args[i + 1] === undefined ? null : { value: args[i + 1] as string, used: 2 };
  if (a.startsWith(`${long}=`)) return { value: a.slice(long.length + 1), used: 1 };
  if (short.length === 2 && a.startsWith(short) && a.length > 2) return { value: a.slice(2), used: 1 };
  return null;
}

// head and tail options; `files` gets the file operands.
function headTail(name: 'head' | 'tail', args: string[]): { pick: Pick; files: string[] } | null {
  let pick: Pick = { kind: name, n: 10 };
  const files: string[] = [];
  for (let i = 0; i < args.length; ) {
    const a = args[i] as string;
    if (a === '--') {
      files.push(...args.slice(i + 1));
      break;
    }
    const v = optionValue(args, i, '-n', '--lines');
    if (v) {
      const plus = name === 'tail' && v.value.startsWith('+');
      const n = int(plus ? v.value.slice(1) : v.value);
      if (n === null) return null;
      pick = plus ? { kind: 'from', n: Math.max(n, 1) } : { kind: name, n };
      i += v.used;
      continue;
    }
    if (/^-\d+$/.test(a)) {
      pick = { kind: name, n: Number(a.slice(1)) };
      i++;
      continue;
    }
    if (a === '-q' || a === '--quiet' || a === '--silent') {
      i++;
      continue;
    }
    if (a.startsWith('-') && a !== '-') return null; // bytes, follow, zero-terminated, ...
    files.push(a);
    i++;
  }
  return { pick, files };
}

// `sed -n` with print commands only: `5p`, `10,20p`, `30,$p`, `$p`, and `Nq` to stop early.
function sedScript(script: string): Pick[] | null {
  const ranges: [number, number | null][] = [];
  let quit: number | null = null;
  for (const raw of script.split(/[;\n]/)) {
    const cmd = raw.trim();
    if (!cmd) continue;
    let m = /^(\d+|\$)(?:,(\d+|\$))?\s*p$/.exec(cmd);
    if (m) {
      const a = m[1] === '$' ? null : Number(m[1]);
      const b = m[2] === undefined ? a : m[2] === '$' ? null : Number(m[2]);
      if (a === null) {
        ranges.push([-1, -1]); // the last line
        continue;
      }
      if (a < 1) return null;
      ranges.push([a, b === null ? null : Math.max(a, b)]);
      continue;
    }
    m = /^(\d+)\s*q$/.exec(cmd);
    if (m) {
      quit = Math.min(quit ?? Infinity, Number(m[1]));
      continue;
    }
    return null;
  }
  if (ranges.length === 0) return null;
  const picks: Pick[] = [];
  if (quit !== null) picks.push({ kind: 'head', n: quit });
  picks.push({ kind: 'lines', ranges });
  return picks;
}

function sed(args: string[]): { picks: Pick[]; files: string[] } | null {
  let quiet = false;
  const scripts: string[] = [];
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a === '--') {
      rest.push(...args.slice(i + 1));
      break;
    }
    if (a === '-n' || a === '--quiet' || a === '--silent') quiet = true;
    else if (a === '-e' || a === '--expression') {
      if (args[i + 1] === undefined) return null;
      scripts.push(args[++i] as string);
    } else if (/^-[nEru]+$/.test(a)) {
      if (a.includes('n')) quiet = true;
    } else if (a.startsWith('-')) return null; // -i edits in place, -f reads a script file, ...
    else rest.push(a);
  }
  if (!quiet) return null;
  if (scripts.length === 0) {
    const s = rest.shift();
    if (s === undefined) return null;
    scripts.push(s);
  }
  const picks = sedScript(scripts.join('\n'));
  return picks ? { picks, files: rest } : null;
}

// nl options that change only how the numbers look; -ba numbers blank lines too.
function nl(args: string[]): { files: string[] } | null {
  const files: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (/^-b[at]$/.test(a) || /^-w\d+$/.test(a) || /^-n(ln|rn|rz)$/.test(a)) continue;
    if ((a === '-b' && /^[at]$/.test(args[i + 1] ?? '')) || (a === '-w' && int(args[i + 1]) !== null)) {
      i++;
      continue;
    }
    if (a === '-n' && /^(ln|rn|rz)$/.test(args[i + 1] ?? '')) {
      i++;
      continue;
    }
    if (a.startsWith('-') && a !== '-') return null;
    files.push(a);
  }
  return { files };
}

// bat prints the file as it is when its output is not a terminal; -r/--line-range picks lines.
function bat(args: string[]): { picks: Pick[]; files: string[] } | null {
  const ranges: [number, number | null][] = [];
  const files: string[] = [];
  for (let i = 0; i < args.length; ) {
    const a = args[i] as string;
    const v = optionValue(args, i, '-r', '--line-range');
    if (v) {
      const m = /^(\d*):(\d*)$/.exec(v.value);
      if (!m) return null;
      const s = m[1] ? Number(m[1]) : 1;
      const e = m[2] ? Number(m[2]) : null;
      if (s < 1) return null;
      ranges.push([s, e === null ? null : Math.max(s, e)]);
      i += v.used;
      continue;
    }
    if (/^(-p|-pp|-P|--plain|--paging=never|--color=never|--decorations=never|--style=plain)$/.test(a)) {
      i++;
      continue;
    }
    if (a === '-l' || a === '--language') {
      i += 2;
      continue;
    }
    if (a.startsWith('-')) return null;
    files.push(a);
    i++;
  }
  return { picks: ranges.length ? [{ kind: 'lines', ranges }] : [], files };
}

const isFile = (f: string): boolean => f !== '' && f !== '-';

// One file display at the start of a pipeline; null when the stage is not one this can follow.
function source(stage: string[], dialect: Dialect): Omit<Display, 'cd'>[] | null {
  const [name0, ...args] = stage;
  if (name0 === undefined) return null;
  const name = dialect === 'powershell' ? name0.toLowerCase() : name0;
  const many = (files: string[], numbered: boolean, picks: Pick[] = []): Omit<Display, 'cd'>[] | null =>
    files.length > 0 && files.every(isFile) ? files.map((p) => ({ path: p, numbered, picks })) : null;

  if (dialect === 'powershell' && ['get-content', 'gc', 'cat', 'type'].includes(name)) return getContent(args);
  if (name === 'git') return gitShow(args);
  if (dialect === 'powershell') return null;
  if (name === 'cat') {
    let numbered = false;
    const files: string[] = [];
    for (const a of args) {
      if (a === '-n' || a === '--number' || a === '-b' || a === '--number-nonblank') numbered = true;
      else if (a === '--') continue;
      else if (a.startsWith('-') && a !== '-') return null;
      else files.push(a);
    }
    return many(files, numbered);
  }
  if (name === 'head' || name === 'tail') {
    const r = headTail(name, args);
    return r ? many(r.files, false, [r.pick]) : null;
  }
  if (name === 'sed') {
    const r = sed(args);
    return r && r.files.length === 1 ? many(r.files, false, r.picks) : null;
  }
  if (name === 'nl') {
    const r = nl(args);
    return r && r.files.length === 1 ? many(r.files, true) : null;
  }
  if (name === 'less' || name === 'more') return args.some((a) => a.startsWith('-')) ? null : many(args, false);
  if (name === 'bat' || name === 'batcat') {
    const r = bat(args);
    return r && (r.picks.length === 0 || r.files.length === 1) ? many(r.files, false, r.picks) : null;
  }
  return null;
}

// PowerShell's Get-Content (and its aliases gc, cat, type) with one path.
function getContent(args: string[]): Omit<Display, 'cd'>[] | null {
  let file: string | null = null;
  let pick: Pick | null = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    const p = a.toLowerCase();
    if (p.startsWith('-')) {
      const next = args[i + 1];
      if (['-path', '-literalpath', '-lp', '-pspath'].includes(p)) {
        if (next === undefined || file !== null) return null;
        file = next;
        i++;
      } else if (['-totalcount', '-head', '-first'].includes(p) || ['-tail', '-last'].includes(p)) {
        const n = int(next);
        if (n === null || pick !== null) return null;
        pick = { kind: ['-tail', '-last'].includes(p) ? 'tail' : 'head', n };
        i++;
      } else if (p === '-encoding') i++;
      else if (p !== '-raw') return null; // -Wait, -Delimiter, -Stream, -ReadCount, ...
      continue;
    }
    if (file !== null) return null;
    file = a;
  }
  if (file === null || !isFile(file)) return null;
  return [{ path: file, numbered: false, picks: pick ? [pick] : [] }];
}

// `git show <rev>:<path>`: the file as it is at that commit.
function gitShow(args: string[]): Omit<Display, 'cd'>[] | null {
  let i = 0;
  while (args[i] === '--no-pager' || args[i] === '-P') i++;
  if (args[i] !== 'show') return null;
  let object: string | null = null;
  for (const a of args.slice(i + 1)) {
    if (a === '--no-color' || a === '--color=never') continue;
    if (a.startsWith('-') || object !== null) return null;
    object = a;
  }
  const m = object === null ? null : /^([^:]+):(.+)$/.exec(object);
  if (!m) return null;
  const file = m[2] as string;
  const relative = file.startsWith('./') || file.startsWith('../');
  return [{ path: file, numbered: false, picks: [], ...(relative ? {} : { repoRelative: true as const }) }];
}

// A later stage of the pipeline that only keeps lines; null for anything else.
function filter(stage: string[], dialect: Dialect): { picks: Pick[]; numbered?: true } | null {
  const [name0, ...args] = stage;
  if (name0 === undefined) return null;
  if (dialect === 'powershell') {
    const name = name0.toLowerCase();
    if (name === 'out-string' || name === 'out-host') return args.length === 0 ? { picks: [] } : null;
    if (name !== 'select-object' && name !== 'select') return null;
    let skip = 0;
    let first: number | null = null;
    let last: number | null = null;
    for (let i = 0; i < args.length; i += 2) {
      const n = int(args[i + 1]);
      const p = (args[i] as string).toLowerCase();
      if (n === null) return null;
      if (p === '-skip') skip = n;
      else if (p === '-first') first = n;
      else if (p === '-last') last = n;
      else return null;
    }
    // With -Last, -Skip counts from the end: not followed.
    if (last !== null && (first !== null || skip > 0)) return null;
    const picks: Pick[] = [];
    if (skip > 0) picks.push({ kind: 'from', n: skip + 1 });
    if (first !== null) picks.push({ kind: 'head', n: first });
    if (last !== null) picks.push({ kind: 'tail', n: last });
    return { picks };
  }
  if (name0 === 'head' || name0 === 'tail') {
    const r = headTail(name0, args);
    return r && r.files.length === 0 ? { picks: [r.pick] } : null;
  }
  if (name0 === 'sed') {
    const r = sed(args);
    return r && r.files.length === 0 ? { picks: r.picks } : null;
  }
  if (name0 === 'cat' && args.every((a) => a === '-n')) return args.length ? { picks: [], numbered: true } : { picks: [] };
  if (name0 === 'nl') {
    const r = nl(args);
    return r && r.files.length === 0 ? { picks: [], numbered: true } : null;
  }
  return null;
}

const DISPLAY_NAMES = /\b(?:cat|head|tail|sed|nl|less|more|bat|batcat|type|gc|get-content|git)\b/i;

/** The file displays a shell command makes, in the order their output appears. */
export function shellDisplays(command: string, dialect: Dialect): Display[] {
  if (!DISPLAY_NAMES.test(command)) return [];
  const tokens = tokenize(command, dialect);
  const list = tokens && statements(tokens);
  if (!list) return [];
  const out: Display[] = [];
  let cd: string[] = [];
  for (const pipe of list) {
    const first = pipe[0] as Stage;
    const words = first.words;
    const name = (words[0]?.text ?? '').toLowerCase();
    if (pipe.length === 1 && (name === 'cd' || name === 'set-location' || name === 'sl')) {
      // Later statements run in that folder; one this cannot follow ends the reading here.
      const dir = words.length === 2 ? words[1] : undefined;
      if (!dir || dir.dynamic || dir.text === '-') break;
      cd = [...cd, dir.text];
      continue;
    }
    if (pipe.some((s) => s.away) || pipe.some((s) => s.words.some((w) => w.dynamic))) continue;
    const found = source(
      words.map((w) => w.text),
      dialect,
    );
    if (!found) continue;
    let numbered = false;
    const picks: Pick[] = [];
    let ok = true;
    for (const s of pipe.slice(1)) {
      const f = filter(
        s.words.map((w) => w.text),
        dialect,
      );
      if (!f) {
        ok = false;
        break;
      }
      picks.push(...f.picks);
      if (f.numbered) numbered = true;
    }
    // A later stage sees all files' lines as one stream: only one file can be followed then.
    if (!ok || (pipe.length > 1 && found.length > 1)) continue;
    for (const d of found) {
      out.push({ ...d, cd, numbered: d.numbered || numbered, picks: [...d.picks, ...picks] });
    }
  }
  return out;
}

/** The file's line numbers a display prints, in order, for a file of `total` lines. */
export function pickedLines(picks: Pick[], total: number): number[] {
  let lines = Array.from({ length: total }, (_, i) => i + 1);
  for (const p of picks) {
    if (p.kind === 'head') lines = lines.slice(0, p.n);
    else if (p.kind === 'tail') lines = p.n === 0 ? [] : lines.slice(-p.n);
    else if (p.kind === 'from') lines = lines.slice(p.n - 1);
    else {
      const n = lines.length;
      lines = lines.filter((_, i) =>
        p.ranges.some(([a, b]) => (a === -1 ? i === n - 1 : i + 1 >= a && (b === null || i + 1 <= b))),
      );
    }
  }
  return lines;
}

/** Output text as lines, without line ends. */
export function outputLines(text: string): string[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

const NUMBER = /^\s*\d+\s*\t/;

function sameLine(out: string, want: string, numbered: boolean, first: boolean): boolean {
  let o = out;
  if (numbered) {
    if (NUMBER.test(o)) o = o.replace(NUMBER, '');
    else if (want.trim() !== '' || o.trim() !== '') return false; // nl leaves a blank line unnumbered
  }
  if (o.trimEnd() === want.trimEnd()) return true;
  // The agent may trim the whole output, which takes the first line's indentation.
  return first && o.trim() === want.trim() && o.trim() !== '';
}

/**
 * The line ranges of the file that `output` shows for `display`, searching from output line
 * `from`: the longest run of output lines that equal the file's lines in the order the display
 * prints them. A cut-short output counts only its whole lines from the start of the display.
 */
export function shownRanges(
  fileText: string,
  display: Display,
  output: string[],
  from: number,
): { ranges: [number, number][]; next: number } {
  const fileLines = outputLines(fileText);
  const lines = pickedLines(display.picks, fileLines.length);
  const want = lines.map((n) => fileLines[n - 1] as string);
  // Blank lines at the start of the display may be gone if the output was trimmed.
  let lead = 0;
  while (lead < want.length && (want[lead] as string).trim() === '') lead++;
  let best = { at: -1, skip: 0, run: 0 };
  for (let skip = 0; skip <= lead && skip < want.length; skip++) {
    for (let at = from; at < output.length; at++) {
      let run = 0;
      while (
        at + run < output.length &&
        skip + run < want.length &&
        sameLine(output[at + run] as string, want[skip + run] as string, display.numbered, at + run === 0)
      ) {
        run++;
      }
      if (run > best.run) best = { at, skip, run };
      if (best.run === want.length - skip) break;
    }
    if (best.run === want.length - skip) break;
  }
  if (best.run === 0) return { ranges: [], next: from };
  const seen = lines.slice(best.skip, best.skip + best.run);
  const ranges: [number, number][] = [];
  for (const n of seen) {
    const last = ranges.at(-1);
    if (last && n === last[1] + 1) last[1] = n;
    else ranges.push([n, n]);
  }
  return { ranges, next: best.at + best.run };
}

// Git Bash writes C:\x as /c/x.
function nativePath(p: string): string {
  if (process.platform === 'win32') {
    const m = /^\/([a-zA-Z])(\/.*)?$/.exec(p);
    if (m) return `${m[1]}:${m[2] ?? '/'}`;
  }
  return p;
}

function repoRoot(dir: string): string | null {
  for (let cur = path.resolve(dir); ; cur = path.dirname(cur)) {
    if (fs.existsSync(path.join(cur, '.git'))) return cur;
    if (path.dirname(cur) === cur) return null;
  }
}

/** The absolute path of the file a display prints, or null when it cannot be told. */
export function displayPath(d: Display, cwd: string | null): string | null {
  let dir = cwd === null ? null : nativePath(cwd);
  for (const c of d.cd) {
    const next = nativePath(c);
    if (path.isAbsolute(next)) dir = next;
    else if (dir === null) return null;
    else dir = path.resolve(dir, next);
  }
  const file = nativePath(d.path);
  if (d.repoRelative) {
    if (dir === null) return null;
    const root = repoRoot(dir);
    return root === null ? null : path.resolve(root, file);
  }
  if (path.isAbsolute(file)) return path.resolve(file);
  return dir === null ? null : path.resolve(dir, file);
}
