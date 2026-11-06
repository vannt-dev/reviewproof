# reviewproof design

Status: draft 2026-11-06, written from the owner's choice of the idea ("CLI + skill: findings
with a source, evidence to withdraw, no verdict before the gates finish, report diff files
nobody read"). The owner skipped the question round; calls marked **(builder's call)** were
made by the author of this document and can be overturned.

## Intent

AI agents now do the first pass of many pull-request reviews, and they fail in the same few
ways: a finding with no source ("this looks wrong"), a claim about a file nobody opened, a
verdict given while the tests still run, a round-1 finding silently dropped in round 2 because
the author pushed back, a note posted before a human looked at it.

reviewproof is the bookkeeping that makes those failures refused or visible. It does not
review code and calls no model: any agent (or person) does the review; reviewproof keeps
a ledger per pull request and enforces the rules below. It comes from a review procedure
used at work; only the general rules are carried over (no project, customer or person names).

## Prior art (survey 2026-11-06)

No tool covers all of it. Copilot code review, Claude Code Review, Cursor Bugbot, CodeRabbit
and Greptile carry findings across rounds but resolve or drop them on their own (Copilot's
"Won't Fix"/"Incorrect" is the escape G2 refuses). Reviewable, Gerrit and GitHub's "Viewed"
box mark files reviewed, but a person declares it; nobody measures what was read. Small
plugins come close on one rule each (Lattice-Data/claude-pr-review: ledger in the PR comment;
davdittrich/review-code: file:line + evidence class, SARIF, asks before posting;
SwiftlyAside/review-ledger: finding ids, `fix --evidence`, local ledger, no posting). Not
found anywhere: refusing a finding without a source, evidence to withdraw, a verdict held
back by gates and unread files, measured read coverage, reading the posted note back.
**Name:** `reviewproof` (owner's pick 2026-11-06: `review-ledger` is taken by the last plugin
above; `reviewproof` is free on npm).

## Users

A developer who lets an agent (Claude Code first) review pull requests on GitHub or GitLab
over several rounds, and who approves what gets posted.

## Goals (v0.1)

- **G1 Sourced findings.** Each finding has a severity (`blocking`, `major`, `minor`), a
  source (`{ kind: "rule" | "design" | "legacy" | "other", ref: string }`, ref non-empty) and
  a location `file:line@sha` where sha is the round's head. A lint refuses a finding missing
  any of them, a file that does not exist at that sha, or a line past the file's end.
- **G2 Rounds.** One ledger per pull request. Round k starts at a head sha; starting a round
  whose head equals the previous round's head is refused (`--force` overrides). Every finding
  still open at the end of round k-1 needs a status in round k:
  `verified` (fixed at the new head), `reopened` (still wrong: needs a location at the new
  head), or `withdrawn` (needs evidence that contains a `file:line@sha` location or a URL;
  free text alone is refused, so "the author disagrees" cannot withdraw a finding).
- **G3 Gates.** `gate run <name> -- <command...>` runs a command (argv array, never a shell
  string), stores its full output and exit code. Append-only: a rerun is attempt 2 next to
  attempt 1; nothing is overwritten. A gate can be recorded `not-checked` with a reason, never
  `pass` without a run. Required gates come from config.
- **G4 Coverage.** The round's diff (round 1: merge-base of base and head..head, computed in
  the checkout; later rounds: the head of the most recent round that has a verdict..head, else the first round's merge-base; `--full` for merge-base..head) gives the changed files and their changed line ranges. Reads come
  from (a) a Claude Code PostToolUse hook on the Read tool (file and line range), (b)
  `reviewproof diff [files]`, which prints the diff and records those files as read, (c)
  `reviewproof read <file> [--lines a-b]` for reads made elsewhere. A Read the tool cut
  short (its response says `PARTIAL view`) covers nothing; subagent reads count and keep
  their `agent_id`. Reads through `cat` in a shell or Grep do not count, and the note says
  so ("opened with Read or reviewproof diff"). A file can be skipped
  with a reason; config globs skip lockfiles and generated files. The report lists unread
  files, files whose changed ranges were never inside a read range, and skipped files.
- **G5 Verdict.** `verdict pass|not-yet --summary "<text>"` is refused until every required
  gate has a finished result, no diff file is unread or partly read, and every carried
  finding has a status. `pass` is also refused while a `blocking` finding is open or a
  required gate failed. The summary is linted against hedge words (config; default
  `probably`, `seems`, `might`, `maybe`, `likely`).
- **G6 Draft, then post.** `draft` renders one Markdown note per round: verdict, findings
  table (id, severity, source, location), carried findings with their new status, gates,
  and a coverage line ("read 14 of 15 changed files; skipped: package-lock.json (lockfile)").
  `post --approved-by <name>` sends the draft as a pull-request comment (GitHub through
  `gh api`, GitLab through `glab api`), the body passed as a UTF-8 JSON file, then reads the
  comment back, compares it with the draft and stores its id and URL. The plugin's PreToolUse
  hook refuses `reviewproof post` from the agent, so only the person runs it (in Claude Code:
  `! reviewproof post ...`).
- **G7 Ledger store.** `$REVIEWPROOF_HOME` (default `~/.reviewproof`) is a git repository:
  `<host>/<owner>/<repo>/<number>/ledger.json`, `logs/round-<k>/<gate>-<attempt>.log`,
  `drafts/round-<k>.md`. The verdict and the post each make one commit
  ("<repo>#<n> round 2: not-yet, 3 open"). The person may push it anywhere (private).
  **(builder's call:** a separate ledger repo, not a records branch in the reviewed repo: it
  works on repos the reviewer cannot push to and never touches the reviewed repo.)

- **G8 SARIF export.** `export --sarif` writes the latest round as one SARIF 2.1.0 run:
  `level` from the severity, `ruleId` from the source ref, `versionControlProvenance`
  with the head sha, `baselineState` (new / unchanged / updated / absent) from the round
  history, withdrawn findings as `suppressions` with the evidence as justification, gates
  as `invocations`. The ledger itself stays JSON: SARIF has no place for reopened,
  verified, gates' attempts or coverage except `properties`. **(builder's call)**

## Non-goals

- No model calls, no API keys; reviewproof never finds bugs itself.
- No approving, merging or resolving threads; no change to the reviewed repository.
- No inline (per-line) review comments in v0.1: one summary note per round. Later: post as
  a GitHub PENDING review / GitLab draft notes so the person approves in the host's UI.
- No per-file "viewed" marks or review UI (Reviewable, Gerrit and GitHub have them).
- Not a CI bot; it runs on the reviewer's machine.

## Anti-goals (a failure even if everything else works)

- A verdict or a post that the rules above would refuse gets through.
- A gate log edited, or a failed run hidden.
- Anything posted without a named approval.
- A token or secret stored in the ledger (gh keeps its credentials; `GITLAB_TOKEN` is read
  from the environment; gate logs have the values of `*_TOKEN` variables replaced by `***`).
- Claiming more than it enforces: the PreToolUse guard stops this tool's `post` command only;
  an agent calling `gh api` itself is outside it, and the README says so.
- Work, customer or person names in the public repository.

## Constraints

- TypeScript, Node >= 22.18. Built with `tsc` to `dist/` for npm (Node does not strip types
  under `node_modules`); published to npm by trusted publishing with provenance.
- No runtime dependencies: `node:util` parseArgs, `node:test`, JSON config
  (`.reviewproof.json` in the reviewed repo, else in the ledger home).
- Child processes take argv arrays only.
- Each source file at most 150 lines, no dead code, no unused exports (owner's house rules).
- CI on Windows and Ubuntu; repokeeper standard (required "CI result" check, release-please).
- `ledger.json` carries `schemaVersion: 1`; a newer version is refused with a clear message.
- Severity maps to SARIF levels for later export: blocking -> error, major -> warning,
  minor -> note.

## Left to the builder

- The Markdown layout of the note beyond the parts G6 names.
- Module split beyond the plan's file map; wording of messages.
- Ids: `F<round>-<n>` (e.g. `F1-3`) **(builder's call)**.
