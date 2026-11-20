# reviewproof: review-round skill

The Claude plugin directory entry of [reviewproof](https://github.com/vannt-dev/reviewproof), a
per-pull-request review ledger. It holds one skill, `review-round`, which drives a review round
with the reviewproof CLI: start, read the diff, run the gates, record sourced findings and the
verdict, write the draft, then stop so the person can read it and post it.

The skill needs the reviewproof CLI on the PATH. Install it from npm as its
[README](https://github.com/vannt-dev/reviewproof#install) describes.

This entry has no hooks: reads are counted through `reviewproof diff` and `reviewproof read`.
The full plugin from the repository's own marketplace adds a Read hook that counts Read tool
reads too, and a guard that keeps the agent from running `reviewproof post`.

The skill is a copy of `skills/review-round/SKILL.md` at the repository root, kept equal by a test.
