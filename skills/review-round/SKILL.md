---
name: review-round
description: Use when reviewing a pull request or merge request over one or more rounds with reviewproof, the per-PR review ledger. Drives one round - start, read the diff, run the gates, review against the repository's own rules, record sourced findings, mark carried findings, record the verdict, write the draft - then stops so the person can read the draft and post it.
---

# One review round with reviewproof

reviewproof keeps the ledger and refuses unchecked claims. It finds no bugs itself: you do the
review. Run every command inside the checkout of the pull request. When a command refuses,
read the message, fix what it names, and run the command again. Do not work around a refusal.

## Steps

1. `reviewproof start <pr>` (a URL, `owner/repo#12`, or `gitlab:group/repo!7`). The checkout
   must be at the PR head: check it out first. Round 2 and later list the carried findings.
2. Read the PR context: title, description, linked issue, earlier comments. Note what the
   author says the change is for.
3. `reviewproof diff` prints the round diff and counts every changed file as read. For a very
   large diff name files: `reviewproof diff <file>...`. Reads with the Read tool count too, but
   only whole, not cut short (a result marked `PARTIAL view` counts for nothing). Reading with
   `cat` or Grep does not count. A file you will not review: `reviewproof skip <file> --reason "..."`.
4. Gates: `reviewproof gate run <name> -- <command...>` for each required gate (tests, lint,
   build). The command runs without a shell and the log is kept. A failed run stays on the
   record; fixing and rerunning makes attempt 2. If a gate cannot run, say so honestly:
   `reviewproof gate skip <name> --reason "..."`. A skipped gate blocks verdict `pass`.
   Start the gates in the background right after step 1 (see Work in parallel).
5. Review the diff against the repository's own rules (contributing guide, style and design
   documents, existing code), not against your taste. Each finding needs a source you can point to.
6. Write `findings.json` (outside the repository, or a file you do not commit) and run
   `reviewproof add findings.json`:

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

   Severity is `blocking`, `major` or `minor`. Source kind is `rule`, `design`, `legacy` or
   `other`; `ref` is never empty. `at` is `file:line` at the round's head. The lint refuses a
   missing field, a file that does not exist at the head, or a line past the end of the file.
7. Round 2 and later: `reviewproof mark <id> <status>` for every carried finding.
   - `verified`: the new head fixes it.
   - `reopened --at file:line`: still wrong; give the place at the new head.
   - `withdrawn --evidence "..."`: only with evidence that holds a `file:line@sha` or a URL.
     The author disagreeing is not evidence. If you have none, do not withdraw.
8. `reviewproof status` lists what still blocks a verdict. Resolve each item.
9. `reviewproof verdict pass --summary "..."` or `reviewproof verdict not-yet --summary "..."`.
   The summary states facts, with no hedge words (probably, seems, might, maybe, likely). The
   verdict is refused while a gate is unfinished, a changed file is unread, or a carried
   finding has no status. `pass` is also refused while a blocking finding is open.
10. `reviewproof draft` writes the round note and prints it.

## Work in parallel

Do not sit idle while a gate runs. The ledger of a pull request is locked while a command
changes it, so reviewproof commands may run at the same time; none loses another's change.

1. Right after `reviewproof start`, start every gate as its own background command
   (`reviewproof gate run lint -- npm run lint`, `reviewproof gate run tests -- npm test`, ...)
   and do not wait for them.
2. While they run: read the PR description and linked issue, then `reviewproof diff` and review.
3. A large diff (more than ~800 changed lines or ~15 files): split the changed files into groups
   and give each group to a subagent that reads its files with the Read tool (its Reads count,
   recorded with its agent id) and returns candidate findings with source and `file:line`.
   Subagents do not run `reviewproof add` or `reviewproof diff`. The main session reads the code
   of every candidate of severity major or blocking itself before `reviewproof add` (helpers tend
   to confirm what they were asked to look for). This is checked: once a helper has read for the
   round, `add` refuses a major or blocking finding, and `mark ... reopened` such a location, on
   a line the main session has not read itself (its own Read, the lines `reviewproof diff`
   printed, or `reviewproof read`). A minor finding is taken on the helper's word.
4. Several pull requests: one checkout per PR (a git worktree, or a lane slot) and one agent per
   PR; each PR has its own ledger, so they never wait for each other.
5. Before `verdict`: `reviewproof status` until no gate is missing (a background gate still
   running shows as missing).

## Stop here

Show the full draft to the person and wait. Posting is the person's decision: they run
`reviewproof post --approved-by <name>` in their own terminal. You never run reviewproof post,
never call `gh api` or `glab api` to post the note, and never edit the ledger by hand.
