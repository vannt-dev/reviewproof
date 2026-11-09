# Changelog

## [0.3.0](https://github.com/vannt-dev/reviewproof/compare/v0.2.0...v0.3.0) (2026-11-09)


### Features

* **gates:** a run counts only at the round's head, on a clean checkout ([#12](https://github.com/vannt-dev/reviewproof/issues/12)) ([11dd12a](https://github.com/vannt-dev/reviewproof/commit/11dd12a2556f8be46474cfe6d105c7b7f938784d))

## [0.2.0](https://github.com/vannt-dev/reviewproof/compare/v0.1.0...v0.2.0) (2026-11-08)


### Features

* put each finding's body in the draft ([#9](https://github.com/vannt-dev/reviewproof/issues/9)) ([f5ea9a2](https://github.com/vannt-dev/reviewproof/commit/f5ea9a277b8e21bf86160c70c59bbfb0ebd06531))

## 0.1.0 (2026-11-06)


### Features

* active reviews and the read/post hook ([0293371](https://github.com/vannt-dev/reviewproof/commit/029337167cc82f49c992c5bc69cb47baa7d34c80))
* append-only gates ([cebbca7](https://github.com/vannt-dev/reviewproof/commit/cebbca75fbed5334c5e3cc06c3b50b0f300dc350))
* changed ranges and read coverage ([f26cb29](https://github.com/vannt-dev/reviewproof/commit/f26cb29d4176ee83b3ae4f0eeafe75134a8d8bdb))
* Claude Code plugin and review-round skill ([ab021b5](https://github.com/vannt-dev/reviewproof/commit/ab021b5b952064a1f54e03036d9d083e153a84a5))
* finding lint and hedge words ([c2bb274](https://github.com/vannt-dev/reviewproof/commit/c2bb2746450852812a43f49ff46f69b355c5e61a))
* GitHub and GitLab hosts ([2c8fcd2](https://github.com/vannt-dev/reviewproof/commit/2c8fcd21c5c2b630c9b0d5e5adf886628ff8d8f4))
* ledger store in a git repo, config ([d00c9de](https://github.com/vannt-dev/reviewproof/commit/d00c9ded720ffcfa4843219e71e4d92b782bdb64))
* parallel-safe ledger and parallel review steps ([5582060](https://github.com/vannt-dev/reviewproof/commit/5582060ac1ef1ef3856e9206dff02957b446b725))
* reviewproof command line ([3ed8a17](https://github.com/vannt-dev/reviewproof/commit/3ed8a17a0fb5d09bcdb880ec4683347cbcd97abe))
* reviewproof v0.1 ([6b963ad](https://github.com/vannt-dev/reviewproof/commit/6b963ad7c09f50f27510cec96ed8ba936cff0a1a))
* rounds, findings and carried statuses ([e4de8c8](https://github.com/vannt-dev/reviewproof/commit/e4de8c8ec74ebb4073946071dacd1dcaee4c74df))
* SARIF export of the latest round ([8343e5d](https://github.com/vannt-dev/reviewproof/commit/8343e5dc0a8ac0f42c6a0d3a491696c86f53d74d))
* types and file:line@sha locations ([7ebab04](https://github.com/vannt-dev/reviewproof/commit/7ebab049a64e1b8535f56bcc6942261b5f1d8bb8))
* verdict blockers and the round note ([57d5308](https://github.com/vannt-dev/reviewproof/commit/57d5308808747f48b4c8c6451462adacbe72f879))


### Bug Fixes

* accept short head shas and @ in paths ([51860a0](https://github.com/vannt-dev/reviewproof/commit/51860a095b7d724d6911968eb5ab6c7a60cc48ad))
* canonical paths, read ranges, post guard, quoting ([2955aa7](https://github.com/vannt-dev/reviewproof/commit/2955aa7e686cbd4f3c1467fc51353ee8669cb9b4))
* escape pipes in note table cells ([f6d1e1d](https://github.com/vannt-dev/reviewproof/commit/f6d1e1d6a4ddd489ba97947cb671d5cc553bbe4c))
* never count an oversized diff as read; docs match behaviour ([72b1f3d](https://github.com/vannt-dev/reviewproof/commit/72b1f3df690492f3c2f2264f9c327e0777ee8f1a))
* next-round coverage, draft check, gate names, diff budget ([add94e1](https://github.com/vannt-dev/reviewproof/commit/add94e1e684f22d12b27dc8d2892d499c2590195))
* post guard false positives, deleted files, post instructions ([a8027bc](https://github.com/vannt-dev/reviewproof/commit/a8027bc6ffccd981d2a1b6c90eafe61fd57f791a))
* post re-checks the verdict, ledger home ignores active.json ([ce930e6](https://github.com/vannt-dev/reviewproof/commit/ce930e6fbf3c06b3a001e7811fb8b27b228e4b50))
* README GitLab prerequisite, build before pack ([759bab0](https://github.com/vannt-dev/reviewproof/commit/759bab031e731d2d4438e100121b3e2adf4269e5))
* run git without the caller's repository variables ([#3](https://github.com/vannt-dev/reviewproof/issues/3)) ([1fed61b](https://github.com/vannt-dev/reviewproof/commit/1fed61b18a2ba2a468e1ef6c2973968d8f675e72))
* store robustness, config errors, SARIF gates, README, package metadata ([f34f811](https://github.com/vannt-dev/reviewproof/commit/f34f811750a5d3f56b7415000131709f2846b022))
* Windows-safe saves, ignore lock files, stale post signal ([5c67453](https://github.com/vannt-dev/reviewproof/commit/5c67453e55e68be63fe826863e00c419e22c9afc))
