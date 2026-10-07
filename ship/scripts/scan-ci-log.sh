#!/usr/bin/env bash
# Scan a GitHub Actions run's full log for errors, warnings, retries/flaky
# markers and timeouts, then list the slowest steps. Output is leads for a
# human or agent to read, not verdicts: expect some noise.
#
# Usage: scan-ci-log.sh <run-id> [max-lines-per-category]
# Run from inside the repo: the jobs API call resolves {owner}/{repo} from it.
set -euo pipefail

run_id=${1:?usage: scan-ci-log.sh <run-id> [max-lines-per-category]}
max=${2:-8}

log=$(mktemp)
trap 'rm -f "$log"' EXIT

# `gh run view --log` prints "<job>\t<step>\t<timestamp> <line>"; drop the
# timestamp and ANSI colours so matches read cleanly.
gh run view "$run_id" --log \
  | sed -E 's/\x1b\[[0-9;]*[A-Za-z]//g; s/\t[0-9]{4}-[0-9]{2}-[0-9]{2}T[^ ]+ /\t/' \
  | grep -v -F '##[command]' \
  > "$log"

if [[ ! -s $log ]]; then
  echo "Empty log for run $run_id: it may still be running, or its logs expired." >&2
  exit 1
fi

section() {
  local title=$1 pattern=$2 exclude=${3:-'^$'}
  local matches count
  matches=$(grep -E -i -- "$pattern" "$log" | grep -E -i -v -- "$exclude" || true)
  count=$(printf '%s' "$matches" | grep -c . || true)
  echo "## $title: $count"
  if [[ $count -gt 0 ]]; then
    printf '%s\n' "$matches" | head -n "$max" | cut -c1-300 | sed 's/^/  /'
  fi
  echo
}

# The exclusions drop the commonest zero-count and summary noise.
section "Errors" \
  '##\[error\]|\berror\b|ERR!|\bexception\b|\bpanic\b|\bfailed\b|✗|✘' \
  '\b0 (errors?|failed)\b|errors?: 0\b|failed: 0\b|--no-error|continue-on-error'
section "Warnings and deprecations" \
  '##\[warning\]|\bwarn(ing)?\b|deprecat' \
  '\b0 warnings?\b|warnings?: 0\b'
section "Retries and flaky" \
  '\bretr(y|ying|ied|ies)\b|\bflaky\b|\battempt [0-9]+\b|\brerun\b'
section "Timeouts" \
  'timed out|\btimeout\b|exceeded'

echo "## Slowest steps"
# `gh run view --json jobs` has no step timestamps; the REST API does.
gh api --paginate "repos/{owner}/{repo}/actions/runs/$run_id/jobs" --jq '
  .jobs[] | .name as $job | .steps[]?
  | select(.conclusion != "skipped" and .started_at != null and .completed_at != null)
  | "\((.completed_at | fromdateiso8601) - (.started_at | fromdateiso8601))\t\($job) / \(.name)"' \
  | sort -rn | head -n 8 \
  | awk -F'\t' '{ printf "  %dm%02ds  %s\n", $1 / 60, $1 % 60, $2 }'
