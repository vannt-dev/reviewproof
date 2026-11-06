# reviewproof

reviewproof keeps a review ledger for each pull request or merge request and refuses review
claims that cannot be checked. It refuses a finding without a source, a withdrawal without
evidence, a verdict before the gates have finished and every changed file has been read, and a
post without a named person. It does not review code and calls no model: an agent or a person does
the review, reviewproof does the bookkeeping. It was built for AI-assisted review over several
rounds, and works for people too.

## Prerequisites

- Node >= 22.18 for the CLI. Claude Code itself does not need Node; only this tool does.
- git.
- GitHub: the `gh` CLI, logged in (`gh auth login`).
- GitLab: a `GITLAB_TOKEN` environment variable (a token with `api` scope). reviewproof calls the
  GitLab API itself; `glab` is not needed.

Works on Windows, macOS and Linux.

## Install

```sh
npm i -g reviewproof
```

As a Claude Code plugin (adds the Read and shell hooks and the `review-round` skill):

```text
/plugin marketplace add vannt-dev/reviewproof
/plugin install reviewproof@reviewproof
```

## One round

Run inside a checkout that is at the head of the pull request.

```sh
reviewproof start o/r#12                  # round 1 (a URL or gitlab:g/r!7 also work)
reviewproof diff                          # prints the round diff, counts the files read
reviewproof gate run tests -- npm test    # no shell; the log is kept, a rerun is attempt 2
reviewproof gate skip e2e --reason "needs a staging server"
reviewproof add findings.json             # sourced findings, linted
reviewproof status                        # what still blocks a verdict
reviewproof verdict not-yet --summary "Two findings open; tests pass."
reviewproof draft                         # writes the note and prints it
reviewproof post --approved-by alice      # the person runs this, never the agent
```

`post` sends the draft as a comment, reads it back, compares it with the draft and stores the
comment's id and URL. It refuses when the draft file differs from the note the ledger renders (run
`reviewproof draft` again), and it refuses inside Claude Code (`CLAUDECODE=1`): post from your own
terminal, not from the agent. After the author pushes, run `start` again: every finding still open
needs a status before the next verdict. A new round diffs from the head of the most recent round
that has a verdict, so files from a round nobody finished are still in it; with no earlier verdict
it diffs from the merge-base, as `start --full` always does.

```sh
reviewproof mark F1-1 verified
reviewproof mark F1-2 reopened --at src/api/client.ts:91
reviewproof mark F1-3 withdrawn --evidence "src/api/client.ts:40@3f9c2ab handles it"
```

Other commands: `read <file> [--lines a-b]` counts a file read elsewhere, `skip <file> --reason R`
leaves a changed file out of coverage, `start --force` starts a round at an unchanged head,
`start --full` diffs from the merge-base, `export --sarif [--out FILE]` writes the latest round as
SARIF 2.1.0 (to FILE, or to stdout without `--out`) for code-scanning tools.

`diff` prints at most 25000 characters per call. Files are printed in order while they fit; the
others are not printed and not counted as read, and the last line (on stderr) names them:
`not shown (too long for one call): <files> - run reviewproof diff <files>`. A file larger than
the budget is printed alone when it is the only one asked for. Gate names start with a letter or
digit and then hold only letters, digits, `.`, `_` and `-` (for example `test-unit`, not
`test:unit` or `../x`).

### Findings file

```json
[
  {
    "severity": "major",
    "source": { "kind": "rule", "ref": "CONTRIBUTING.md#error-handling" },
    "at": "src/api/client.ts:88",
    "title": "Network errors are swallowed",
    "body": "The catch block returns null, which callers read as 'not found'."
  }
]
```

Severity: `blocking`, `major`, `minor`. Source kind: `rule`, `design`, `legacy`, `other`; `ref` must
not be empty. `at` is checked at the round's head: the file must exist and the line must be inside it.
Withdrawal evidence must contain a `file:line@sha` location or a URL.

## Parallel reviews

The ledger is locked per pull request while a command changes it, so commands run at the same
time are safe: none loses another's change, and a gate's log is never overwritten.

- Start each gate as its own background command right after `start`, and review while they run.
  `status` shows a gate still running as missing.
- Split a large diff among helper agents: their Reads count, each recorded with the agent's id.
- Several pull requests: one checkout (a git worktree) and one agent per pull request; each pull
  request has its own ledger, so they never wait for each other.

## Config

`.reviewproof.json` in the reviewed checkout, else `config.json` in the ledger home. The first file
found is used whole; a missing or wrong-typed key falls back to its default, but a file that is
not valid JSON is an error.

| Key | Default | Meaning |
| --- | --- | --- |
| `requiredGates` | `[]` | gate names that must have a finished run before a verdict |
| `skip` | `["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "**/*.snap"]` | changed files left out of coverage |
| `hedgeWords` | `["probably", "seems", "might", "maybe", "likely"]` | words refused in a verdict summary |

## Ledger

`$REVIEWPROOF_HOME`, default `~/.reviewproof`, is a git repository of its own, so reviews never touch
the reviewed repository. Each verdict and each post makes one commit. You may push it to a private
remote. `active.json` (this machine's checkout paths) and the `*.lock` files are git-ignored.

```text
<host>/<owner>/<repo>/<number>/
  ledger.json                    # schemaVersion 1
  logs/round-<k>/<gate>-<attempt>.log
  reads/round-<k>.jsonl          # one line per counted Read, diff or read
  drafts/round-<k>.md
  ledger.lock                    # held while a command changes this pull request; git-ignored
```

reviewproof never writes a token to disk. The values of `*_TOKEN` variables are replaced by `***` in
gate logs and in the command line stored for each gate attempt (`ledger.json` and the SARIF
`commandLine`).

## Prior art

- Copilot code review, Claude Code Review, Cursor Bugbot, CodeRabbit, Greptile: carry findings across rounds, but resolve or drop them on their own.
- Reviewable, Gerrit, GitHub "Viewed": mark files reviewed, but a person declares it; nothing measures what was read.
- Lattice-Data/claude-pr-review: keeps the ledger in the PR comment.
- davdittrich/review-code: file:line plus an evidence class, SARIF output, asks before posting.
- SwiftlyAside/review-ledger: finding ids, `fix --evidence`, a local ledger, no posting.

reviewproof adds the refusals: no finding without a source, no withdrawal without evidence, no verdict
before the gates and reads are done, measured read coverage, and the posted note read back.

## Limits

- The Read hook works in Claude Code only. A Read always counts as a line range: from `offset` (default
  1) for `limit` lines (default 2000, the Read tool's own default). A Read cut short by the token limit
  counts only when Claude Code marks it `PARTIAL view`; reads through `cat` in a shell or Grep are not
  counted.
- Other agents use `reviewproof diff` and `reviewproof read`. These are declarations, not
  measurements: reviewproof records that the file was shown or that you said you read it, not that
  anyone understood it.
- On Windows a `.cmd` tool (such as `npm`) is retried through `cmd.exe`, which expands `%VAR%` in the
  arguments.
- The person posts by running `reviewproof post --approved-by <name>` in their own terminal. The
  PreToolUse guard stops this tool's `post` command only. It does not stop an agent that calls the
  GitHub or GitLab API itself (`gh api`, `curl`, ...).
- One summary note per round; no inline comments, approving or merging.

## License

MIT
