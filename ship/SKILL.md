---
name: ship
description: Take the current branch's pull request from green CI to merged, with exactly one code review in between, then watch the post-merge CI run and report errors, warnings, flaky tests, and slow steps. Waits for PR CI to pass, runs /code-review medium --fix once, re-checks and pushes any fixes, waits for CI again, merges, and audits the default-branch run logs. Invoked only by the user typing /ship; typing it is the authorization to merge.
disable-model-invocation: true
argument-hint: "[pr-number]"
---

# Ship

One pass from "CI is green" to "merged and verified on the default branch".
The user typed `/ship`, so they have already decided to merge: do not ask
again, but do stop and report whenever a step below says to stop. Stopping is
cheap; merging something broken is not.

The review happens **once**, after CI has passed and before the merge. CI
first, because a review of code that fails its own checks is wasted and its
fixes would be built on a moving target. Once, because a second review after
the fixes turns into an open-ended loop; anything the fixes break is CI's job
to catch.

```
1. resolve PR ─► 2. wait PR CI ─► 3. review once ─► 4. local checks + push
                        │ red: stop                     │ (skip if no changes)
                        ▼                               ▼
                                               5. wait CI on fix commit
                                                        │ red: fix breakage only
                                                        ▼
                                  6. merge ─► 7. watch default-branch CI ─► 8. report
```

## 1. Resolve the PR

PR = `$ARGUMENTS` if given, else the PR for the current branch:

```bash
gh pr view ${ARGUMENTS} --json number,url,state,isDraft,headRefName,headRefOid,baseRefName,mergeable,mergeStateStatus
```

Stop and report if any of these hold, because each means the user's picture of
the PR is not what /ship would act on:

- No PR exists for the branch. Offer to open one; do not merge a PR created in
  the same breath without the user seeing it.
- The PR is a draft, closed, or already merged.
- The local checkout is not the PR head: `git rev-parse HEAD` differs from
  `headRefOid`, or `git status --porcelain` is not empty. The review's `--fix`
  edits the working tree, so it has to start from exactly the commit CI tested.
- `mergeable` is `CONFLICTING`.

## 2. Wait for PR CI on the head commit

```bash
gh pr checks <n> --watch --interval 30
```

This can outlast a single shell timeout: run it in the background and wait
for it to finish rather than polling. Right after a push the checks list can
be empty for a few seconds; if it is, wait briefly and re-run rather than
treating "no checks" as green.

- **All passed (skipped is fine):** continue.
- **Any failed or cancelled:** stop. Summarise each failure from
  `gh run view <run-id> --log-failed` (job, step, the first real error line)
  and hand back to the user. Do not review and do not try to fix: a red PR
  means the work is not finished, and that is the author's call.

## 3. Review once

Run the code-review skill on the PR:

```
/code-review medium --fix <n>
```

If the skill is not available, stop and say so rather than improvising a
review: the user asked for that specific review at that specific depth.

Read what it reports. Findings it applied land in the working tree; findings
it only reported (could not or would not fix) go into the final report as
open items. Do not run a second review later, even after more changes.

## 4. Local checks, then push (only if the review changed files)

If `git status --porcelain` is empty, skip to step 6: CI already passed on
this exact commit.

Otherwise, run the same checks CI runs, locally, before pushing. Discover them
rather than guessing:

1. The repo's agent docs (`AGENTS.md`, `CLAUDE.md`) usually name the
   done-checks and when the slower suites are required.
2. The CI workflow (`.github/workflows/*.yml`) shows the exact commands and
   any preparation steps (codegen such as `next typegen`, `prisma generate`).
   Mirror the fast job: install, codegen, type-check, lint, unit tests.
3. Add the slower suites only when the fixes touch what they cover, as the
   repo docs define it (e.g. integration tests when a database adapter
   changed).
4. Skip a local production build unless the fixes touched build
   configuration, framework/route config, or caching. CI builds anyway, and
   type-checking already catches what a build usually would.

Use the package manager the repo uses (its lockfile tells you).

If a check fails, fix it within the scope of the review's changes and re-run.
If a fix would reach beyond that scope, stop and report.

Commit in the repo's commit style (look at `git log`), with a message that
says these are review fixes and what they change, then `git push`.

## 5. Wait for CI on the fix commit

Same as step 2, against the new head SHA. No review this time.

- **Green:** continue.
- **Red, caused by the fixes:** fix only the breakage, run the local checks
  again, push, wait again. After two failed attempts, stop and report: the
  fixes are fighting the code and a human should look.
- **Red, unrelated to the diff** (a failure in code the fixes did not touch,
  a timeout, a network or runner error): it is probably flaky. Re-run only
  the failed jobs once with `gh run rerun <run-id> --failed`. If it passes,
  continue and record it as flaky for the report. If it fails again, stop.

## 6. Merge

Pick the method the repo allows, preferring squash:

```bash
gh repo view --json squashMergeAllowed,mergeCommitAllowed,rebaseMergeAllowed
```

Merge only the commit CI just passed, so nothing pushed in the meantime slips
in unchecked:

```bash
gh pr merge <n> --squash --match-head-commit <head-sha>
```

Do not pass `--delete-branch`: it also deletes the local branch, which fails
or surprises when the branch is checked out in a worktree. Branch deletion is
the repo's auto-delete setting's job.

If the repo uses a merge queue or the merge is rejected for required
reviews, report the state and stop: those are policies, not obstacles.

## 7. Watch the default-branch run

Find the merge commit and the CI run it triggered:

```bash
gh pr view <n> --json mergeCommit --jq .mergeCommit.oid
gh run list --branch <base> --commit <merge-sha> --json databaseId,workflowName,status
```

The run can take a few seconds to appear. Wait on each run with
`gh run watch <id> --exit-status` (in the background), then scan every run,
**pass or fail**, with the bundled script:

```bash
bash <this-skill-dir>/scripts/scan-ci-log.sh <run-id>
```

It prints, per category, a count and the first few matching lines: errors,
warnings and deprecations, retries and flaky markers, timeouts, plus the
slowest steps. Treat its output as leads, not verdicts: read the matches and
drop noise (a test named `handles error`, `0 errors`, a log line quoting an
expected failure). A green run with a retried test is still a flaky test.

If the default-branch run fails, do not revert on your own. Report the
failure, whether it reproduces what the PR changed, and propose a fix or a
revert for the user to choose.

## 8. Report

Use this shape, and keep each section to what is true; write "none" rather
than dropping a section, so the user can see it was checked.

```
## Shipped #<n>: <title>
<merge-sha short> merged into <base> (<method>)

### Review
- Fixed: <one line per applied finding>
- Left open: <findings not applied, with why>

### CI
- PR: green on <sha> (<duration>); after fixes: green on <sha>
- Flaky: <test or job, what happened, rerun outcome>

### <base> after merge: <pass|fail> (<duration>)
- Errors: ...
- Warnings: ...
- Retries / flaky: ...
- Slowest steps: <job / step: time>

### Follow-ups
- <anything worth a ticket>
```
