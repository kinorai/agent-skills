---
name: ship
description: Merge the current branch's PR after green CI and exactly one /code-review pass, then audit the post-merge CI run for errors, warnings, flaky tests and slow steps.
disable-model-invocation: true
argument-hint: "[pr-number]"
---

# Ship

One pass from "CI is green" to "merged and verified on the default branch".
The user typed `/ship`: that is their decision to merge, so carry it through
without asking again. Each step has a **Done when** line; reach it before
moving on. When a step says **Stop**, report and hand back. Stopping is cheap.
Merging something broken is not.

The review runs **once**: after CI passes, before the merge.

- **After CI passes**, because reviewing code that fails its own checks is
  wasted work, and its fixes would land on a moving target.
- **Once**, because a second review after the fixes becomes an open-ended
  loop. Anything the fixes break is CI's job to catch.

```
1 resolve PR ─► 2 PR CI green ─► 3 one review ─► 4 local checks + push ─► 5 CI green ─► 6 merge ─► 7 audit default-branch run ─► 8 report
                     │ red: Stop                     │ no changes: skip to 6          │ red: fix breakage only (max 2)
```

## 1. Resolve the PR

PR = `$ARGUMENTS` if given, else the current branch's PR:

```bash
gh pr view ${ARGUMENTS} --json number,title,url,state,isDraft,headRefOid,baseRefName,mergeable
```

**Stop** if any of these hold. Each means the PR is not the one the user
thinks /ship is acting on:

- There is no PR. Offer to open one. The user should see a PR before it gets
  merged.
- The PR is a draft, closed, or merged.
- The checkout is not exactly the PR head: `git rev-parse HEAD` differs from
  `headRefOid`, or `git status --porcelain` shows changes. The review's
  `--fix` edits this working tree, so it has to start from the commit CI
  tested.
- `mergeable` is `CONFLICTING`.

**Done when:** you have the PR number, head SHA and base branch, and the
checkout is clean at that SHA.

## 2. PR CI is green on the head commit

```bash
gh pr checks <n> --watch --interval 30
```

This often outlasts one shell timeout. Run it in the background and wait for
it to exit. Right after a push the check list can be empty for a few seconds.
"No checks" means "not started yet": wait and run it again.

- All checks passed or skipped: continue.
- Any check failed or was cancelled: **Stop**. For each failure, give the job,
  the step, and the first real error line from `gh run view <run-id>
  --log-failed`. A red PR is unfinished work and goes back to its author,
  unreviewed and unfixed.

**Done when:** every check on `headRefOid` has concluded and none failed.

## 3. One review

```
/code-review medium --fix <n>
```

If that skill is unavailable, **Stop**. The user asked for this review at
this depth, and a stand-in review is a different promise.

Sort its findings into two lists for the report:

- **Fixed:** findings it applied to the working tree.
- **Left open:** findings it reported but did not apply.

**Done when:** the review has finished and every finding is in one of the
two lists.

## 4. Local checks, then push (only if the review changed files)

If `git status --porcelain` is empty, go to step 6. CI already passed on this
exact commit.

Otherwise, run the checks CI runs, before pushing. Find them; don't guess:

1. **Repo agent docs.** `AGENTS.md` and `CLAUDE.md` usually name the
   done-checks and say when the slower suites are required.
2. **CI workflow.** `.github/workflows/*.yml` has the exact commands, and the
   preparation steps that are easy to miss locally (codegen such as `next
   typegen` or `prisma generate`). Mirror the fast job: codegen, type-check,
   lint, unit tests.
3. **Slower suites,** only when the fixes touch what they cover, as the repo
   docs define it (for example integration tests when a database adapter
   changed).
4. **Local production build,** only when the fixes touch build config,
   framework or route config, or caching. CI builds anyway, and the type
   check catches most of what a build would.

If a check fails, fix it within the review's changes and re-run. If the fix
needs to reach beyond them, **Stop**.

Commit with a message that says these are review fixes and lists what they
change. Push.

**Done when:** the local checks pass, the push succeeded, and `gh pr view
<n> --json headRefOid` equals your local `HEAD`.

## 5. CI is green on the fix commit

Same as step 2, on the new head SHA. No second review.

Classify each failure before acting on it:

- **Caused by the fixes** (the failing code or test is in what they
  touched): fix only that breakage, re-run the local checks, push, wait
  again. After **2** attempts, **Stop**: the fixes are fighting the code.
- **Unrelated to the diff** (code the fixes did not touch, a timeout, a
  runner or network error): treat it as flaky. Run `gh run rerun <run-id>
  --failed` **once**. If it passes, continue and record it as flaky. If it
  fails again, **Stop**.

**Done when:** every check on the current head SHA has concluded green.

## 6. Merge

Use the method the repo allows, preferring squash:

```bash
gh repo view --json squashMergeAllowed,mergeCommitAllowed,rebaseMergeAllowed
gh pr merge <n> --squash --match-head-commit <green-head-sha>
```

- **`--match-head-commit`** merges only the commit CI just passed. If
  anything was pushed in the meantime, the merge fails instead of shipping
  unchecked code.
- **Leave out `--delete-branch`.** It also deletes the local branch, which
  breaks when that branch is checked out in a worktree. The repo's
  auto-delete setting handles the remote branch.

If a merge queue or a required review blocks the merge, **Stop** and report
the state. Those are the repo's policies; leave them for the user.

**Done when:** `gh pr view <n> --json state,mergeCommit` shows `MERGED` and
gives you the merge commit SHA.

## 7. Audit the default-branch run

```bash
gh run list --branch <base> --commit <merge-sha> --json databaseId,workflowName,status
```

Runs can take a few seconds to appear. Wait on each with `gh run watch <id>
--exit-status` in the background. Then scan every run, whether it passed or
failed:

```bash
bash <this-skill-dir>/scripts/scan-ci-log.sh <run-id>
```

The script prints a count and sample lines for errors, warnings and
deprecations, retries and flaky markers, and timeouts, plus the slowest
steps. Treat each match as a lead to read. Drop noise:

- a test whose *name* says "error" or "retries"
- `0 errors`
- logged output from a failure the test expects

Keep real findings, including in a green run. A test that passed on retry is
still flaky.

If the default-branch run failed, report the failure, whether it comes from
this PR's change, and a proposed fix or revert. Leave that choice to the
user.

**Done when:** every run on the merge commit has concluded, and each one has
been scanned and triaged.

## 8. Report

Use this shape whether you finished or stopped. Keep every section; write
"none" so the user can see it was checked.

```
## <SHIPPED | STOPPED at step N: reason> #<n>: <title>
<merge-sha short> merged into <base> (<method>)        ← SHIPPED only

### Review
- Fixed: <one line per applied finding>
- Left open: <finding, and why it was not applied>

### CI
- PR: <green|red> on <sha> (<duration>); after fixes: <green|red> on <sha>
- Flaky: <test or job, what happened, rerun outcome>

### <base> after merge: <pass|fail> (<duration>)
- Errors: ...
- Warnings: ...
- Retries / flaky: ...
- Slowest steps: <job / step: time>

### Next
- <what the user should do now: a fix, a ticket, a decision>
```

## Shortcuts that break the contract

| The thought | What it costs |
|---|---|
| "CI is red but it looks flaky, I'll review anyway." | You review unverified code. Stop at step 2; flaky handling belongs to step 5 only. |
| "The fixes changed a lot, a second review would be safer." | The one-review contract becomes a loop. CI checks the fixes. List what you are unsure of under Left open. |
| "The fix is tiny, I can skip the local checks." | A red push costs a full CI cycle and one of your 2 attempts. |
| "`main` went red after the merge, I'll revert it quickly." | Reverting is a second change to shared history that the user never authorized. Report it and propose. |
| "The merge is blocked by a required review, I'll use `--admin`." | It bypasses a policy the repo chose on purpose. Stop. |
