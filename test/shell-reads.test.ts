import { test } from 'node:test';
import assert from 'node:assert/strict';
import { outputLines, pickedLines, shellDisplays, shownRanges, type Dialect, type Display } from '../src/shell-reads.ts';

// The file each command prints and the lines it prints, for a file of 100 lines.
function lines(command: string, dialect: Dialect = 'posix'): [string, number[]][] {
  return shellDisplays(command, dialect).map((d) => {
    const all = pickedLines(d.picks, 100);
    return [d.path, all.length > 6 ? [all[0]!, all.at(-1)!, all.length] : all];
  });
}

test('whole-file displays print every line', () => {
  assert.deepEqual(lines('cat src/a.ts'), [['src/a.ts', [1, 100, 100]]]);
  assert.deepEqual(lines('cat -n src/a.ts'), [['src/a.ts', [1, 100, 100]]]);
  assert.deepEqual(lines('nl -ba src/a.ts'), [['src/a.ts', [1, 100, 100]]]);
  assert.deepEqual(lines('less src/a.ts'), [['src/a.ts', [1, 100, 100]]]);
  assert.deepEqual(lines('more src/a.ts'), [['src/a.ts', [1, 100, 100]]]);
  assert.deepEqual(lines('bat --plain src/a.ts'), [['src/a.ts', [1, 100, 100]]]);
  assert.deepEqual(lines('git show HEAD:src/a.ts'), [['src/a.ts', [1, 100, 100]]]);
  assert.deepEqual(lines('git --no-pager show 1a2b3c4:src/a.ts'), [['src/a.ts', [1, 100, 100]]]);
  assert.deepEqual(lines('git show HEAD~1:src/a.ts'), [['src/a.ts', [1, 100, 100]]]);
  assert.deepEqual(lines('cat a.ts b.ts'), [
    ['a.ts', [1, 100, 100]],
    ['b.ts', [1, 100, 100]],
  ]);
});

test('head, tail, sed -n and bat -r print known line ranges', () => {
  assert.deepEqual(lines('head src/a.ts'), [['src/a.ts', [1, 10, 10]]]);
  assert.deepEqual(lines('head -n 5 src/a.ts'), [['src/a.ts', [1, 2, 3, 4, 5]]]);
  assert.deepEqual(lines('head -n5 src/a.ts'), [['src/a.ts', [1, 2, 3, 4, 5]]]);
  assert.deepEqual(lines('head -3 src/a.ts'), [['src/a.ts', [1, 2, 3]]]);
  assert.deepEqual(lines('head --lines=2 src/a.ts'), [['src/a.ts', [1, 2]]]);
  assert.deepEqual(lines('tail -n 3 src/a.ts'), [['src/a.ts', [98, 99, 100]]]);
  assert.deepEqual(lines('tail -n +96 src/a.ts'), [['src/a.ts', [96, 97, 98, 99, 100]]]);
  assert.deepEqual(lines("sed -n '10,20p' src/a.ts"), [['src/a.ts', [10, 20, 11]]]);
  assert.deepEqual(lines('sed -n 10,12p src/a.ts'), [['src/a.ts', [10, 11, 12]]]);
  assert.deepEqual(lines('sed -n "7p" src/a.ts'), [['src/a.ts', [7]]]);
  assert.deepEqual(lines("sed -n '98,$p' src/a.ts"), [['src/a.ts', [98, 99, 100]]]);
  assert.deepEqual(lines("sed -n '$p' src/a.ts"), [['src/a.ts', [100]]]);
  assert.deepEqual(lines("sed -n '1,2p;50,51p' src/a.ts"), [['src/a.ts', [1, 2, 50, 51]]]);
  assert.deepEqual(lines("sed -n -e '3,4p' src/a.ts"), [['src/a.ts', [3, 4]]]);
  assert.deepEqual(lines("sed -n '1,200p;3q' src/a.ts"), [['src/a.ts', [1, 2, 3]]]);
  assert.deepEqual(lines('bat -r 4:6 src/a.ts'), [['src/a.ts', [4, 5, 6]]]);
  assert.deepEqual(lines('bat --line-range=98: src/a.ts'), [['src/a.ts', [98, 99, 100]]]);
});

test('pipes into line selectors narrow the lines; numbered output is followed', () => {
  assert.deepEqual(lines("nl -ba src/a.ts | sed -n '20,22p'"), [['src/a.ts', [20, 21, 22]]]);
  assert.deepEqual(lines('cat -n src/a.ts | head -n 2'), [['src/a.ts', [1, 2]]]);
  assert.deepEqual(lines('cat src/a.ts | tail -2'), [['src/a.ts', [99, 100]]]);
  assert.deepEqual(lines("sed -n '10,40p' src/a.ts | head -n 3"), [['src/a.ts', [10, 11, 12]]]);
  const [d] = shellDisplays("sed -n '5,6p' src/a.ts | cat -n", 'posix');
  assert.equal(d?.numbered, true);
});

test('statements: cd changes the folder, && ; and 2>/dev/null keep the display', () => {
  const [d] = shellDisplays('cd src && cat a.ts', 'posix');
  assert.deepEqual(d?.cd, ['src']);
  assert.deepEqual(lines('git status; head -n 2 a.ts 2>/dev/null'), [['a.ts', [1, 2]]]);
  assert.deepEqual(lines('cat a.ts 2>&1'), [['a.ts', [1, 100, 100]]]);
  assert.deepEqual(lines('echo x && cat a.ts || true'), [['a.ts', [1, 100, 100]]]);
  assert.deepEqual(lines("cat 'my file.ts'"), [['my file.ts', [1, 100, 100]]]);
  assert.deepEqual(lines('cat "my file.ts"'), [['my file.ts', [1, 100, 100]]]);
  assert.deepEqual(lines('cat my\\ file.ts'), [['my file.ts', [1, 100, 100]]]);
  assert.deepEqual(lines('cat "C:\\src\\a.ts"'), [['C:\\src\\a.ts', [1, 100, 100]]]);
  assert.deepEqual(lines('cat a.ts # look'), [['a.ts', [1, 100, 100]]]);
});

test('commands whose output is not the file content count for nothing', () => {
  const none = [
    'cat a.ts | grep foo',
    'cat a.ts | wc -l',
    'cat a.ts > copy.ts',
    'cat a.ts >> copy.ts',
    'cat a.ts &> log',
    'cat a.ts >&2',
    'cat a.ts | sort',
    'cat a.ts b.ts | head -n 3',
    'cat -A a.ts',
    'cat < a.ts',
    'cat *.ts',
    'cat src/*.ts',
    'cat "$FILE"',
    'cat $(git ls-files)',
    'cat `ls`',
    'cat ~/a.ts',
    'head -c 100 a.ts',
    'tail -f a.ts',
    'sed s/a/b/ a.ts',
    "sed -n '/foo/p' a.ts",
    "sed -n '1,5d' a.ts",
    "sed -i -n '1p' a.ts",
    'less -N a.ts',
    'bat -n a.ts',
    'git show HEAD',
    'git show HEAD:a.ts --stat',
    'git log -p a.ts',
    'grep -n foo a.ts',
    'echo cat a.ts',
    'cat a.ts &',
    '(cat a.ts)',
    "cat 'unclosed",
    'type a.ts',
    'Get-Content a.ts',
    'cat',
    'cat -',
  ];
  for (const c of none) assert.deepEqual(shellDisplays(c, 'posix'), [], c);
});

test('PowerShell: Get-Content and its aliases, Select-Object, quoting', () => {
  const ps = (c: string) => lines(c, 'powershell');
  assert.deepEqual(ps('Get-Content src/a.ts'), [['src/a.ts', [1, 100, 100]]]);
  assert.deepEqual(ps('get-content -Path src\\a.ts -Raw'), [['src\\a.ts', [1, 100, 100]]]);
  assert.deepEqual(ps("gc 'my file.ts' -Encoding utf8"), [['my file.ts', [1, 100, 100]]]);
  assert.deepEqual(ps('type src/a.ts'), [['src/a.ts', [1, 100, 100]]]);
  assert.deepEqual(ps('cat src/a.ts'), [['src/a.ts', [1, 100, 100]]]);
  assert.deepEqual(ps('Get-Content src/a.ts -TotalCount 3'), [['src/a.ts', [1, 2, 3]]]);
  assert.deepEqual(ps('Get-Content src/a.ts -Head 2'), [['src/a.ts', [1, 2]]]);
  assert.deepEqual(ps('Get-Content src/a.ts -Tail 2'), [['src/a.ts', [99, 100]]]);
  assert.deepEqual(ps('Get-Content -LiteralPath "src/a.ts" -Last 1'), [['src/a.ts', [100]]]);
  assert.deepEqual(ps('Get-Content src/a.ts | Select-Object -Skip 10 -First 2'), [['src/a.ts', [11, 12]]]);
  assert.deepEqual(ps('Get-Content src/a.ts | select -Last 1'), [['src/a.ts', [100]]]);
  assert.deepEqual(ps('Get-Content src/a.ts 2>$null'), [['src/a.ts', [1, 100, 100]]]);
  assert.deepEqual(ps('Set-Location src; Get-Content a.ts -First 1'), [['a.ts', [1]]]);
  assert.deepEqual(ps('git show HEAD:src/a.ts'), [['src/a.ts', [1, 100, 100]]]);
  assert.deepEqual(ps("Get-Content 'it''s.ts'"), [["it's.ts", [1, 100, 100]]]);
  const none = [
    'Get-Content src/a.ts | Select-String foo',
    'Get-Content src/a.ts | Measure-Object',
    'Get-Content src/a.ts | Select-Object -Skip 2 -Last 3',
    'Get-Content $f',
    'Get-Content "$env:TEMP/a.ts"',
    'Get-Content a.ts, b.ts',
    'Get-Content *.ts',
    'Get-Content a.ts -Wait',
    'Get-Content a.ts > b.ts',
    'Get-Content a.ts *> b.ts',
    'Get-Content (Resolve-Path a.ts)',
    'Get-Content a.ts | ForEach-Object { $_ }',
    'head -n 3 a.ts',
    "sed -n '1,3p' a.ts",
  ];
  for (const c of none) assert.deepEqual(shellDisplays(c, 'powershell'), [], c);
});

const file = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
const disp = (over: Partial<Display> = {}): Display => ({ path: 'a', cd: [], numbered: false, picks: [], ...over });

test('a read counts only the lines the output shows, in the file order', () => {
  const sed = disp({ picks: [{ kind: 'lines', ranges: [[3, 7]] }] });
  assert.deepEqual(shownRanges(file, sed, outputLines('line 3\nline 4\nline 5\nline 6\nline 7'), 0).ranges, [[3, 7]]);
  // Cut short (a truncated output keeps its start): only the whole lines shown.
  assert.deepEqual(shownRanges(file, sed, outputLines('line 3\nline 4\nli'), 0).ranges, [[3, 4]]);
  // Codex adds a warning before a truncated output and a marker inside it.
  const codex = 'Warning: truncated output (original token count: 900)\n\nline 3\nline 4\nline…40 tokens truncated…7';
  assert.deepEqual(shownRanges(file, sed, outputLines(codex), 0).ranges, [[3, 4]]);
  // The command failed or printed something else: nothing.
  assert.deepEqual(shownRanges(file, sed, outputLines('sed: can\'t read a: No such file'), 0).ranges, []);
  assert.deepEqual(shownRanges(file, sed, outputLines(''), 0).ranges, []);
  // The file changed since: only lines that still match count.
  assert.deepEqual(shownRanges(file, sed, outputLines('line 3\nline 4\nOTHER\nline 6'), 0).ranges, [[3, 4]]);
});

test('CRLF, trimmed output, numbered lines and two files in one output', () => {
  const crlf = file.replace(/\n/g, '\r\n');
  const whole = disp();
  assert.deepEqual(shownRanges(crlf, whole, outputLines(crlf), 0).ranges, [[1, 30]]);
  const indented = '  first\n  second\n';
  assert.deepEqual(shownRanges(indented, whole, outputLines('first\n  second'), 0).ranges, [[1, 2]]);
  const numbered = disp({ numbered: true, picks: [{ kind: 'head', n: 3 }] });
  assert.deepEqual(shownRanges(file, numbered, outputLines('     1\tline 1\n     2\tline 2\n     3\tline 3'), 0).ranges, [[1, 3]]);
  assert.deepEqual(shownRanges(file, numbered, outputLines('line 1\nline 2'), 0).ranges, []);
  const blanks = 'a\n\nb\n';
  assert.deepEqual(shownRanges(blanks, disp({ numbered: true }), outputLines('     1\ta\n       \n     2\tb'), 0).ranges, [[1, 3]]);
  const two = outputLines('x 1\nx 2\nline 1\nline 2');
  const first = shownRanges('x 1\nx 2\n', whole, two, 0);
  assert.deepEqual(first, { ranges: [[1, 2]], next: 2 });
  assert.deepEqual(shownRanges('line 1\nline 2\n', whole, two, first.next).ranges, [[1, 2]]);
  const multi = disp({ picks: [{ kind: 'lines', ranges: [[1, 2], [10, 11]] }] });
  assert.deepEqual(shownRanges(file, multi, outputLines('line 1\nline 2\nline 10\nline 11'), 0).ranges, [[1, 2], [10, 11]]);
});
