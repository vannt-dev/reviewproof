# reviewproof v0.1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A CLI, a Claude Code hook and a skill that keep a per-pull-request review ledger and refuse unsourced findings, silent withdrawals, early verdicts, unread diff files and unapproved posts.

**Architecture:** Pure rule modules (location, lint, rounds, coverage, verdict, draft) over one JSON
ledger per PR, stored in a git repo at `$REVIEWPROOF_HOME`. Thin edges do I/O: `store` (files +
git), `gates` (child processes), `hosts` (GitHub through `gh api`, GitLab through REST), `hook`
(Claude Code hook JSON on stdin), `cli` (parseArgs). An `active.json` maps a checkout folder to
the review going on in it, so commands and hooks run inside the checkout need no PR argument.

**Tech Stack:** TypeScript 5.9+/tsc 7, Node >= 22.18, `node:test`, no runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-11-06-reviewproof-design.md`

## Global Constraints

- Node >= 22.18; `tsc` builds `src/` and `bin/` to `dist/`; tests run on the `.ts` sources with Node type stripping.
- Zero runtime dependencies; dev dependencies only `typescript` and `@types/node`.
- Child processes: `spawnSync`/`execFileSync` with argv arrays, never a shell string.
- Every source and test file <= 150 lines; `noUnusedLocals`, `noUnusedParameters`, `noUncheckedIndexedAccess`, `strict`.
- Severities exactly `blocking`, `major`, `minor`; source kinds exactly `rule`, `design`, `legacy`, `other`.
- Location text exactly `<repo-relative file>:<line>@<sha>` (sha 7-40 hex).
- `ledger.json` has `schemaVersion: 1`; any other value is refused with `ledger schema <v> is newer than this reviewproof (1)`.
- Default hedge words: `probably`, `seems`, `might`, `maybe`, `likely`.
- No token, cookie or secret is ever written to the ledger home.
- English in code, messages, docs and commits; no work, customer or person names anywhere.
- Commit messages: no trailers; body lines under 100 characters.

## Review Focus

- Windows paths in hook input (`C:\Users\...\src\a.ts`, other case or slash style than git prints) must map to `src/a.ts` of the active checkout. Test in Task 9.
- A Read in a folder with no active review (another lane, the main clone) must record nothing and never fail the tool call. Test in Task 9.
- The author pushes during the round: `verdict` and `post` refuse when the PR head is no longer the round's head. Test in Task 10.
- Japanese and Vietnamese text in the note survives posting and the read-back compare (CRLF vs LF ignored, nothing else). Test in Task 8.
- Renamed, deleted and binary files in the diff: renamed counted at the new path, deleted only by `reviewproof diff`, binary by any read. Test in Task 5.

---

### Task 1: Repository, types and locations

**Files:**
- Create: `package.json`, `tsconfig.json`, `tsconfig.build.json`, `.gitignore`, `LICENSE` (MIT), `.github/workflows/ci.yml`
- Create: `src/types.ts`, `src/location.ts`
- Test: `test/location.test.ts`

**Interfaces:**
- Produces (`src/types.ts`): `Severity`, `SourceKind`, `Location { file; line; sha }`, `Status = 'open'|'verified'|'reopened'|'withdrawn'`, `StatusEntry { round; status; evidence?; location? }`, `Finding { id; round; severity; source: { kind; ref }; location; title; body?; history: StatusEntry[] }`, `NewFinding = Omit<Finding, 'id'|'round'|'history'>`, `GateAttempt { name; attempt; argv: string[]|null; exitCode: number|null; result: 'pass'|'fail'|'not-checked'; reason?; log?; at }`, `ReadMark { file; range?: [number, number]; via: 'hook'|'diff'|'manual'; partial?: true; agent?: string; at }`, `Round { n; head; base; from; startedAt; gates; reads; skips: {file; reason}[]; verdict?: { value: 'pass'|'not-yet'; summary; at }; post?: { id; url; approvedBy; at } }`, `PrRef { host: 'github'|'gitlab'; hostname; project; number }`, `Ledger { schemaVersion: 1; pr: PrRef & { url; title }; rounds: Round[]; findings: Finding[] }`.
- Produces (`src/location.ts`): `parseLocation(text: string): Location` (throws `Error` naming the bad part), `formatLocation(l: Location): string`, `isEvidence(text: string): boolean`.

- [ ] **Step 1: Write the failing tests** in `test/location.test.ts`:
  `parseLocation('src/a.ts:12@abc1234')` deep-equals `{ file: 'src/a.ts', line: 12, sha: 'abc1234' }`;
  throws `/needs @<sha>/` for `src/a.ts:12`; throws `/line/` for `src/a.ts:0@abc1234`; throws `/repo-relative/` for `C:/x/a.ts:3@abc1234` and `/x/a.ts:3@abc1234`;
  `formatLocation` round-trips; `isEvidence('fixed in src/a.ts:3@abc1234')` and `isEvidence('see https://example.com/x')` are true, `isEvidence('the author disagrees')` is false.
- [ ] **Step 2: Run** `node --test test/location.test.ts` — expect FAIL (module missing).
- [ ] **Step 3: Scaffold and implement.** `package.json`: name `reviewproof`, `type: module`, `bin: { "reviewproof": "dist/bin/reviewproof.js" }`, `files: ["dist", "hooks", ".claude-plugin", "skills"]`, scripts `build: tsc -p tsconfig.build.json`, `typecheck: tsc --noEmit`, `test: node --test "test/*.test.ts"`, `engines.node: ">=22.18"`. `tsconfig.json` as in the lane repo (strict flags above, `allowImportingTsExtensions`, `noEmit`); `tsconfig.build.json` extends it with `noEmit: false`, `rewriteRelativeImportExtensions: true`, `outDir: dist`, `include: ["src", "bin"]`. CI: windows-latest + ubuntu-latest, Node 22.18 and 24: `npm ci`, typecheck, test, build, `node dist/bin/reviewproof.js --help`.
- [ ] **Step 4: Run** `npm test && npm run typecheck` — expect PASS.
- [ ] **Step 5: Commit** `feat: types and file:line@sha locations`.

### Task 2: Ledger store and config

**Files:**
- Create: `src/store.ts`, `src/config.ts`
- Test: `test/store.test.ts`

**Interfaces:**
- Consumes: `Ledger`, `PrRef` (Task 1).
- Produces: `class LedgerStore { constructor(home: string); dirFor(ref: PrRef): string; load(ref: PrRef): Ledger | null; save(l: Ledger): void; writeLog(ref, round: number, name: string, attempt: number, text: string): string; writeDraft(ref, round: number, md: string): string; commit(message: string): void }` — paths `<home>/<hostname>/<project>/<number>/{ledger.json, logs/round-<k>/<name>-<attempt>.log, drafts/round-<k>.md}`; `save` writes a temp file then renames; `commit` runs `git init` on first use, `git add -A`, `git commit -m`.
- Produces: `interface Config { requiredGates: string[]; skip: string[]; hedgeWords: string[] }`, `loadConfig(checkout: string, home: string): Config` — first `<checkout>/.reviewproof.json`, else `<home>/config.json`, else defaults (`requiredGates: []`, `skip: ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', '**/*.snap']`, hedge words from Global Constraints).

- [ ] **Step 1: Failing tests:** save then load deep-equals; a file with `schemaVersion: 2` throws the exact Global Constraints message; `writeLog` twice for attempts 1 and 2 leaves both files; `commit` in a fresh home creates a git repo with one commit whose subject is the message; `loadConfig` prefers the checkout file over the home file and fills missing keys from defaults.
- [ ] **Step 2: Run** `node --test test/store.test.ts` — FAIL.
- [ ] **Step 3: Implement** both files.
- [ ] **Step 4: Run** `npm test` — PASS.
- [ ] **Step 5: Commit** `feat: ledger store in a git repo, config`.

### Task 3: Finding lint and hedge words

**Files:**
- Create: `src/lint.ts`
- Test: `test/lint.test.ts`

**Interfaces:**
- Consumes: `NewFinding`, `parseLocation` (Task 1).
- Produces: `lintFinding(input: unknown, head: string, lineCount: (file: string) => number | null): { finding?: NewFinding; errors: string[] }` — input shape `{ severity, source: { kind, ref }, at: "file:line" | "file:line@sha", title, body? }`; a missing sha takes `head`; a sha other than `head` is an error. `hedges(text: string, words: string[]): string[]` — case-insensitive whole-word match that also works for non-ASCII words (letters judged with `\p{L}`).

- [ ] **Step 1: Failing tests:** a full valid input gives no errors and `location.sha === head`; each of: severity `critical`, missing `source.ref`, `source.kind: 'opinion'`, `at` on a file where `lineCount` returns null, line 50 where `lineCount` returns 40, sha not equal to head — gives exactly one error naming that field; `hedges('This probably breaks', words)` is `['probably']`; `hedges('Probabilistic test', words)` is `[]`; `hedges('Có vẻ sai', ['có vẻ'])` is `['có vẻ']`.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat: finding lint and hedge words`.

### Task 4: Rounds, findings and carried statuses

**Files:**
- Create: `src/rounds.ts`
- Test: `test/rounds.test.ts`

**Interfaces:**
- Consumes: types, `isEvidence`.
- Produces: `interface PrInfo { url: string; title: string; head: string; base: string }`; `startRound(ledger: Ledger | null, ref: PrRef, pr: PrInfo, from: string, now: Date, force: boolean): Ledger` (throws `/head .* unchanged since round/` when `pr.head` equals the last round's head and not `force`); `addFinding(l: Ledger, f: NewFinding): Finding` (id `F<round>-<n>`, history `[{ round, status: 'open' }]`); `currentStatus(f: Finding): Status`; `carried(l: Ledger): Finding[]` (findings from earlier rounds whose status is `open` or `reopened` and that have no entry for the current round); `mark(l: Ledger, id: string, status: 'verified'|'reopened'|'withdrawn', opts: { evidence?: string; location?: Location }): void`.

- [ ] **Step 1: Failing tests:** round 2 with the same head throws, with `force` passes; ids run `F1-1`, `F1-2`, then `F2-1`; after round 2 starts, both round-1 findings are in `carried`; `mark(..., 'withdrawn', { evidence: 'the author disagrees' })` throws `/evidence/`; with `evidence: 'handled in src/a.ts:9@def5678'` it passes and the finding leaves `carried`; `mark(..., 'reopened', {})` throws `/location at the new head/`; marking an id from the current round throws `/carried/`.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat: rounds, findings and carried statuses`.

### Task 5: Diff ranges and coverage

**Files:**
- Create: `src/diff.ts`, `src/coverage.ts`
- Test: `test/coverage.test.ts`

**Interfaces:**
- Produces: `interface ChangedFile { file: string; status: 'A'|'M'|'D'|'R'; binary: boolean; ranges: [number, number][] }`; `changedFiles(repo: string, from: string, to: string): ChangedFile[]` from `git diff --unified=0 -M --no-color <from> <to>` (ranges are new-side line spans from `@@ -a,b +c,d @@`; pure-deletion hunks give no range); `parseDiff(text: string): ChangedFile[]` (the pure part, exported for tests).
- Produces: `interface Coverage { read: string[]; partial: string[]; unread: string[]; skipped: { file: string; reason: string }[] }`; `coverage(changed: ChangedFile[], reads: ReadMark[], skips: { file; reason }[], skipGlobs: string[]): Coverage` — a `via: 'diff'` read or a read without range covers the whole file; ranged reads must together contain every changed range; a `partial` read covers nothing; `D` files count only with a `diff` read; binary files count with any read; glob skips use `path.matchesGlob`.

- [ ] **Step 1: Failing tests** on a real temp repo (commit, then a commit that modifies lines 3-4 of `a.ts`, adds `b.ts`, renames `c.ts` to `d.ts` with one line changed, deletes `e.ts`, adds `img.png` bytes): `changedFiles` gives `a.ts` ranges `[[3,4]]`, `d.ts` status `R`, `e.ts` status `D`, `img.png` `binary: true`; `coverage` with reads `a.ts [1,2]` lists `a.ts` in `partial`, with `a.ts [1,10]` in `read`; `e.ts` read by `manual` stays `unread`, by `diff` is `read`; `b.ts` read once with `partial: true` stays `unread`; `package-lock.json` changed is `skipped` with reason `config`.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat: changed ranges and read coverage`.

### Task 6: Gates

**Files:**
- Create: `src/gates.ts`
- Test: `test/gates.test.ts`

**Interfaces:**
- Consumes: `Round`, `GateAttempt`, `LedgerStore.writeLog`.
- Produces: `runGate(store: LedgerStore, ref: PrRef, round: Round, name: string, argv: string[], cwd: string): GateAttempt` (spawnSync with argv, stdout+stderr into the log after replacing the value of every `process.env` variable whose name ends in `_TOKEN` (non-empty) by `***`; a missing program gives `result: 'fail'`, `exitCode: null`, the spawn error in the log; attempt = previous attempts of that name + 1); `notChecked(round: Round, name: string, reason: string): GateAttempt` (reason required, non-empty); `gateState(round: Round, required: string[]): { missing: string[]; failed: string[] }` (the last attempt of each name decides).

- [ ] **Step 1: Failing tests:** `node -e "process.exit(1)"` then `node -e "0"` under the same name leaves attempts 1 (`fail`) and 2 (`pass`) and two log files; `gateState` with required `['test']` then has no `failed`; a program `no-such-program-xyz` records `fail` with `exitCode: null`; with `process.env.TEST_TOKEN = 's3cr3t-value'`, `node -e "console.log(process.env.TEST_TOKEN)"` gives a log containing `***` and not `s3cr3t-value`; `notChecked` with `''` throws; `gateState` with required `['lint']` and no attempts lists `lint` in `missing`.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat: append-only gates`.

### Task 7: Verdict and draft

**Files:**
- Create: `src/verdict.ts`, `src/draft.ts`
- Test: `test/verdict.test.ts`

**Interfaces:**
- Consumes: `carried`, `currentStatus` (Task 4), `Coverage` (Task 5), `gateState` (Task 6), `hedges` (Task 3), `Config`.
- Produces: `verdictBlockers(l: Ledger, cov: Coverage, cfg: Config, value: 'pass'|'not-yet', summary: string): string[]` — one line per blocker: missing gate, failed gate (`pass` only), unread or partial file, carried finding without status, open `blocking` finding (`pass` only), hedge word in summary. `renderDraft(l: Ledger, cov: Coverage): string` — sections: verdict line, findings table `| id | severity | source | location | title |`, carried findings with their new status and evidence, gates (name, last result, attempts), coverage line `read <r> of <n> changed files (opened with Read or reviewproof diff); skipped: <file> (<reason>), ...`.

- [ ] **Step 1: Failing tests:** each blocker kind appears alone in an otherwise ready ledger; `not-yet` is allowed with an open blocking finding and a failed gate; `pass` with summary `Looks fine, probably` lists the hedge; the draft of a ready two-round ledger contains `F1-1`, `verified`, `read 3 of 3 changed files`.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat: verdict blockers and the round note`.

### Task 8: Hosts

**Files:**
- Create: `src/hosts.ts`, `src/github.ts`, `src/gitlab.ts`
- Test: `test/hosts.test.ts`

**Interfaces:**
- Consumes: `PrRef`, `PrInfo`.
- Produces: `parsePrRef(input: string): PrRef` — `https://github.com/o/r/pull/12`, `o/r#12` (GitHub), `https://<host>/g/sub/r/-/merge_requests/7`, `gitlab:g/r!7`; `interface Host { resolve(ref: PrRef): Promise<PrInfo>; comment(ref: PrRef, body: string): Promise<{ id: string; url: string }>; readComment(ref: PrRef, id: string): Promise<string> }`; `hostFor(ref: PrRef): Host`; `sameNote(a: string, b: string): boolean` (equal after CRLF -> LF and trailing whitespace trim).
- `GitHub(run: (argv: string[]) => string = gh)`: `gh api repos/<p>/pulls/<n>`; comment `gh api -X POST repos/<p>/issues/<n>/comments --input <tmp.json>` (JSON written UTF-8); read `gh api repos/<p>/issues/comments/<id>`.
- `GitLab(fetchImpl = fetch, token = process.env.GITLAB_TOKEN)`: `GET /api/v4/projects/<url-encoded project>/merge_requests/<n>` (`diff_refs.head_sha`, `diff_refs.base_sha`); `POST .../notes` with JSON body `{ body }`; `GET .../notes/<id>`; a missing token throws `GITLAB_TOKEN is not set`.

- [ ] **Step 1: Failing tests** with a fake runner and a fake fetch: `parsePrRef` for all four forms (subgroup project kept whole); GitHub `resolve` maps `head.sha`/`base.sha`/`title`/`html_url`; `comment` passes a JSON file whose UTF-8 content holds `レビュー` and `chưa đạt`; `sameNote('a\r\nb  \n', 'a\nb\n')` true, `sameNote('a', 'b')` false; GitLab `resolve` URL-encodes `g/sub/r`; missing token throws.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat: GitHub and GitLab hosts`.

### Task 9: Active reviews and the Claude Code hook

**Files:**
- Create: `src/active.ts`, `src/hook.ts`
- Test: `test/hook.test.ts`

**Interfaces:**
- Consumes: `LedgerStore`, `ReadMark`.
- Produces: `setActive(home: string, checkout: string, ref: PrRef): void`, `activeFor(home: string, anyPath: string): { checkout: string; ref: PrRef } | null` (the active checkout that contains `anyPath`; paths compared resolved, `/`-separated, lower-cased on Windows), `clearActive(home, checkout)`.
- Produces: `handleHook(event: unknown, home: string): string | null` — PostToolUse with `tool_name: 'Read'`: records `{ file, range, via: 'hook' }` on the active round (range from `tool_input.offset` and `tool_input.limit`, 1-based, none when both absent; `partial: true` when `tool_response` contains `PARTIAL view`; `agent` from `agent_id`); PreToolUse with `tool_name: 'Bash'` or `'PowerShell'` whose `tool_input.command` matches `/\breviewproof(\.js)?\s+post\b/`: returns the deny JSON `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Only the person posts: they run ! reviewproof post --approved-by <name>"}}`. Anything else, or an error inside, returns null (the hook never breaks a tool call).

- [ ] **Step 1: Failing tests:** a Read of `C:\…\Checkout\src\A.ts` (other case, backslashes) inside an active checkout `c:/…/checkout` records `src/A.ts`; offset 10 limit 20 records `[10, 29]`; a response containing `PARTIAL view` records `partial: true`; an event with `agent_id: 'a1'` records `agent: 'a1'`; a Read outside any active checkout records nothing and returns null; a Bash `npx reviewproof post --approved-by me` is denied; `reviewproof status` is not; malformed JSON returns null.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat: active reviews and the read/post hook`.

### Task 10: CLI and an end-to-end round

**Files:**
- Create: `src/cli.ts`, `bin/reviewproof.ts`
- Test: `test/e2e.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces commands (run inside the checkout; `REVIEWPROOF_HOME` overrides the home): `start <pr> [--force] [--full]` (resolve; fetch the PR head the way forks need it too: `git fetch origin pull/<n>/head` on GitHub, `merge-requests/<n>/head` on GitLab; refuse unless checkout HEAD is the PR head; `from` = `git merge-base <base> <head>` in round 1 or with `--full`, else the previous round's head; start round, set active), `add <json-file>` (array of finding inputs; all-or-nothing on lint errors; `lineCount` from `git cat-file -p <head>:<file>` in the checkout, null when it fails), `mark <id> <status> [--evidence E] [--at file:line]`, `gate run <name> -- <cmd...>`, `gate skip <name> --reason R`, `diff [files...]`, `read <file> [--lines a-b]`, `skip <file> --reason R`, `status`, `verdict <pass|not-yet> --summary S`, `draft`, `post --approved-by NAME`, `hook`, `--help`. `verdict` and `post` re-resolve the PR and refuse `/head moved/` when it changed; `verdict` commits `<project>#<n> round <k>: <value>, <open> open`; `post` commits `... posted`. `run(argv: string[], deps: { host?: Host }): Promise<number>` is the testable entry; `bin/reviewproof.ts` calls it with `process.argv.slice(2)`.

- [ ] **Step 1: Failing test** — one full flow on a temp repo with a fake host: start round 1, add a blocking finding, `verdict pass` refused (blocking open, file unread), `diff` all files, `gate run test -- node -e 0`, `verdict not-yet` passes, `draft` written, `post --approved-by tester` stores the fake comment id; then a new head commit, `start` round 2, `verdict pass` refused while `F1-1` has no status, `mark F1-1 verified`, `verdict pass` passes; the ledger repo has 4 commits; changing the fake host's head before `post` gives exit code 1 and `head moved`.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** `npm test && npm run build && node dist/bin/reviewproof.js --help` — PASS.
- [ ] **Step 5: Commit** `feat: reviewproof command line`.

### Task 11: Claude Code plugin, skill, README

**Files:**
- Create: `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `hooks/hooks.json`, `skills/review-round/SKILL.md`, `README.md`
- Test: `test/plugin.test.ts`

**Interfaces:**
- Consumes: `reviewproof hook` (Task 10).
- Produces: hooks `PostToolUse` matcher `Read` and `PreToolUse` matcher `Bash|PowerShell`, each `{ "type": "command", "command": "reviewproof", "args": ["hook"] }`; the skill's steps: start → read the PR context → `diff` → gates through `gate run` → review against the repository's rules → `add` findings with sources → `mark` every carried finding → `status` → `verdict` → `draft` → STOP and show the draft; never run `post`.

- [ ] **Step 1: Failing test:** `hooks/hooks.json` exists (the plugin default location); every hook command is `reviewproof hook`; `SKILL.md` front matter has `name: review-round` and a description under 1024 characters; the skill text contains `never run reviewproof post`.
- [ ] **Step 2: Run** — FAIL. **Step 3: Write the files.** README: what it refuses (the five rules), install (`npm i -g reviewproof`, `/plugin marketplace add vannt-dev/reviewproof`), one round walkthrough, config keys, ledger layout, prior art (the spec's list, one line each), limits (the guard stops this tool's `post` only, not an agent calling `gh api` itself; Read hook is Claude Code only, `cat`/Grep reads are not counted; other agents use `diff` and `read`; the hook needs the CLI on PATH).
- [ ] **Step 4: Run** `npm test` — PASS. Then by hand, with the plugin loaded in Claude Code: run `! reviewproof post --approved-by me` in a test review. If the guard fires on a `!` command too, the README and the skill say "post from a separate terminal" instead of `!`.
- [ ] **Step 5: Commit** `feat: Claude Code plugin and review-round skill`.

### Task 12: SARIF export

**Files:**
- Create: `src/sarif.ts`
- Test: `test/sarif.test.ts`

**Interfaces:**
- Consumes: `Ledger`, `currentStatus`, `gateState`.
- Produces: `toSarif(l: Ledger, toolVersion: string): object` (SARIF 2.1.0, one run for the latest round; `level` blocking/major/minor -> error/warning/note; `ruleId` = source ref; `partialFingerprints.findingId` = finding id; `baselineState`: `new` for this round's findings, `unchanged` for carried ones still open, `updated` for reopened, `absent` for verified; withdrawn -> `suppressions: [{ kind: 'external', justification: <evidence> }]`; `versionControlProvenance[0].revisionId` = head; `invocations[]` one per required gate with `executionSuccessful`); CLI `export --sarif [--out file]` (Task 10's `run` gains this command).

- [ ] **Step 1: Failing test:** for a two-round ledger, the output has `version: '2.1.0'`, one run, levels and baseline states as listed for each status, a suppression carrying the withdraw evidence, `revisionId` equal to round 2's head.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat: SARIF export of the latest round`.

### Task 13: Publish setup (needs the owner)

- [ ] Owner OK, then create the public repo `vannt-dev/reviewproof`, push, apply the repokeeper standard (`repokeeper apply`), check the required "CI result" check is green.
- [ ] Release-please config for npm; npm trusted publisher set by the owner on npmjs.com (first publish: see the openapi-drift notes on the 404/403 publisher gotcha).
- [ ] Profile README, personal site and landing pages per the landing-pages map.
