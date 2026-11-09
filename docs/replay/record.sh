#!/bin/sh
# Records the replay on the landing page: a real two-round review of a pull request made for it.
# Writes docs/replay/reviewproof.jsonl, one {"cmd", "sec", "out"} per step.
#
#   ROOT=F:/demo sh docs/replay/record.sh vannt-dev/lane 25 F:/demo/lane
#
# ROOT is a short folder (short paths in the output). The checkout is at the pull request's head.
# Nothing is posted: the agent's `post` is refused inside Claude Code, and the person's post is the
# step the replay waits for.
set -e
ROOT="${ROOT:?set ROOT to a short folder}"
REPO="$1"; PR="$2"; CO="$3"
OUT="$(cd "$(dirname "$0")" && pwd)/reviewproof.jsonl"
export REVIEWPROOF_HOME="$ROOT/rp"
rm -rf "$REVIEWPROOF_HOME" "$ROOT/tools" "$OUT"
mkdir -p "$REVIEWPROOF_HOME" "$ROOT/tools"
(cd "$ROOT/tools" && npm init -y >/dev/null && npm i --silent reviewproof@0.3.0 >/dev/null 2>&1)
RP="$ROOT/tools/node_modules/.bin/reviewproof"
printf '{"requiredGates":["test"]}\n' > "$REVIEWPROOF_HOME/config.json"
(cd "$CO" && npm ci --silent >/dev/null 2>&1)
grep -qx findings.json "$CO/.git/info/exclude" || printf 'findings.json\n' >> "$CO/.git/info/exclude"

json() { node -e 'const [c,s,o]=process.argv.slice(1);process.stdout.write(JSON.stringify({cmd:c,sec:Number(s),out:o})+"\n")' "$@"; }
# Runs a `reviewproof ...` line with the installed reviewproof and records it as typed.
step() {
  start=$(date +%s)
  out=$(cd "$CO" && eval "$RP ${1#reviewproof }" 2>&1) || true
  json "$1" "$(( $(date +%s) - start ))" "$out" >> "$OUT"
}
note() { json "# $1" 0 "" >> "$OUT"; }
# GitHub shows a push as the pull request's head a few seconds later.
wait_head() {
  until [ "$(gh pr view "$PR" -R "$REPO" --json headRefOid -q .headRefOid)" = "$(git -C "$CO" rev-parse HEAD)" ]; do sleep 3; done
}
wait_head

# Round 1
step "reviewproof start $REPO#$PR"
step "reviewproof diff"
step "reviewproof gate run test -- npm test"
cat > "$CO/findings.json" <<'EOF'
[
  {
    "severity": "blocking",
    "source": { "kind": "rule", "ref": "README.md#big-repositories-sparse-slots" },
    "at": "src/sparse.ts:17",
    "title": "--sparse takes a folder outside the repository again",
    "body": "Without the .. check, sparseDirs accepts ../other and a/../../b; the README says --sparse takes folders inside the repository, and the test of sparseDirs fails."
  }
]
EOF
note "the agent writes findings.json from what it read and the failing test"
step "reviewproof add findings.json"
step "reviewproof verdict pass --summary \"Ready to merge.\""
step "reviewproof verdict not-yet --summary \"One blocking finding: --sparse takes ../ folders; the tests fail.\""
step "reviewproof draft"
note "the agent tries to post the note itself"
step "reviewproof post --approved-by vannt-dev"
json "gate: you read the draft and post it from your own terminal" 0 "" >> "$OUT"

# Round 2: the author restores the check
sed -i "17s/parts.some((p) => p === '' || p === '.')/parts.some((p) => p === '' || p === '.' || p === '..')/" "$CO/src/sparse.ts"
sed -i '16d' "$CO/src/sparse.ts"
(cd "$CO" && git commit -qam "fix(sparse): refuse .. again" && git push -q) >/dev/null 2>&1
wait_head
note "the author pushes a fix"
step "reviewproof start $REPO#$PR"
step "reviewproof diff"
step "reviewproof gate run test -- npm test"
step "reviewproof mark F1-1 verified"
step "reviewproof verdict pass --summary \"The .. check is back and the tests pass.\""
step "reviewproof draft"
echo "recorded $(wc -l < "$OUT") steps to $OUT"
