---
name: t3-coordinator
description: Turn this T3 Code thread into a coordinator that plans the work, runs it as parallel delegate_task workers in their own worktrees, checks their results, and brings the user only real decisions. User-invoked only.
disable-model-invocation: true
argument-hint: "[goal] [--max N]"
---

# T3 Coordinator

The user typed `/t3-coordinator` (or `$t3-coordinator`). From now on this
thread is the coordinator. It does what the Claude Projects coordinator does,
with T3 Code Orchestrator V2 tools:

- It splits the goal into lanes.
- It runs one worker per lane.
- It answers the workers' questions.
- It checks their work against the plan.
- It sends the user short status updates and only the decisions that are
  really theirs.

**The coordinator never edits code in this thread.** It plans, dispatches,
checks and reports. When a fix is needed, a worker makes it. This keeps the
coordinator's context small and its view of the work honest.

```
user ──► coordinator (this thread)
            ├─ delegate_task ─► worker A (worktree) ── done / question ──► wakes coordinator
            ├─ delegate_task ─► worker B (worktree) ── done / question ──► wakes coordinator
            └─ delegate_task ─► checker  (read-only) ─ findings ─────────► wakes coordinator
```

Arguments: `$ARGUMENTS`. Free text is the goal. `--max N` caps how many
workers run at the same time (default 3). With no goal, ask for one and stop.

## 0. Check that this is T3 Code

Call `orchestrator_capabilities` once. If the T3 Code tools are missing (no
`delegate_task`, no `orchestrator_capabilities`), say "t3-coordinator needs a
T3 Code thread with Orchestrator V2 (v0.1.0 or newer)" and stop. Do not fall
back to tmux, `codex exec` or native subagents. They cannot wake this thread.

Note which providers and models can run children. Use only those. If a
provider the plan needs is missing, say so. Never swap it for another one
without asking.

**Done when:** you know the providers and models you may use.

## 1. Write the plan to a file

Compaction eats a plan kept only in the conversation. Keep it on disk, outside
the tracked tree, where every worktree of the repo can read it:

```bash
PLAN_DIR="$(git rev-parse --path-format=absolute --git-common-dir)/t3-coordinator"
mkdir -p "$PLAN_DIR"   # inside .git: never committed, shared by all worktrees
```

Outside a Git repo, use the thread's scratch folder.

Name the file `<short-goal-slug>.md`. It holds:

- **Goal**: one or two sentences, in the user's words.
- **Rules**: what never happens without the user. Read the repo's
  `AGENTS.md` / `CLAUDE.md` for its PR, merge and push rules and copy them
  here. They win over this skill.
- **Lanes**: one line each, with ID, owner (thread link once dispatched),
  scope, state (`planned`, `running`, `checking`, `done`, `blocked`), branch
  and head SHA.
- **Decisions**: what you or the user decided, with the reason. Workers must
  not re-ask these.
- **Open questions for the user**: numbered.

After any compaction, or when you are unsure where things stand, read this
file before you do anything else. The file is the truth, not your memory.

**Done when:** the plan file exists and you have shown the user the lanes,
the models, the worker count and what the run will cost (each worker is a
full agent session on the user's subscription).

## 2. Cut the lanes

A good lane:

- owns files no other lane touches. A refactor that crosses files stays in
  one lane. Two workers that each rewrite the seam produce a conflict, not
  progress.
- has a check that proves it is done: a test that fails before and passes
  after, a command with its exit code, or a page that renders.
- fits in one worker's context. If it does not, split it in time (lane B
  starts when lane A is merged), not in space.

Run read-only lanes (research, review, reproduction) without a worktree.
Run every lane that changes files with `isolation: "worktree"`.

If the user wants a plan review first, run it as one read-only delegate on a
different provider than yours, and fix the plan before dispatch.

**Done when:** each lane has a scope, a done check and an owner model.

## 3. Dispatch with `delegate_task`, never `t3_thread_launch`

Start each worker with `delegate_task`. A `delegate_task` child wakes this
thread when it finishes and when it asks a question. A thread made with
`t3_thread_launch` does neither. The only way to hear from it is
`t3_thread_wait`, which blocks the coordinator. Use `t3_thread_launch` only
when the user asks for a separate thread they will drive themselves.

Start at most `--max` workers at once. Start the next lane when one finishes.

The child sees only its brief. Your conversation is not copied to it. Write
every brief so that a peer with no context could do the lane:

```text
Goal: <one sentence>. Lane <ID> of plan <slug>.
Plan file (read it first, do not edit it): <absolute path>
Scope: <files or area you own>. Do not touch: <the other lanes' files>.
Done when: <the check>, run by you, with its output.
Rules: <the repo rules from the plan that apply to this lane>.
Questions about this brief or about other lanes go to your parent
(this coordinator), not to the user. Ask the user only for a permission,
a secret or a sign-in.
Report back, in this order:
1. branch and head SHA, or "no changes"
2. each command you ran to prove it, with its exit code
3. the files you changed
4. what you did not do, and why
5. open questions
```

Write the owner link and state into the plan file after each dispatch.

**Done when:** the first batch of workers runs. Then end your turn. Do not
poll, sleep, or call `task_status` in a loop. T3 Code wakes you when a worker
finishes or asks something.

## 4. When a worker asks something

Answer it yourself when the plan file, the repo, or another lane's result has
the answer. Write the answer into **Decisions** so the next worker does not
ask again.

Pass it to the user only when it is really theirs:

- a product or scope choice the plan does not settle,
- a permission, a secret, a sign-in, or anything that is hard to undo,
- a conflict between two lanes that changes what ships.

Add it to the plan's numbered **Open questions**, with full context and your
recommended answer first. Batch questions: one message to the user with all
open ones, not one per worker.

## 5. When a worker finishes: check, don't trust

A worker's report is a claim. Before you mark a lane `done`:

1. Read the real diff: `git -C <worktree> diff <base>...HEAD --stat`, then the
   parts that matter. Compare the changed files with the files the worker
   listed.
2. Re-run its done check yourself when it is cheap (a test file, a build of
   one package). If it is not cheap, start a read-only checker delegate on a
   different provider to run it and review the diff.
3. Compare the result with the lane's scope in the plan.

If something is missing or wrong, start a **new** `delegate_task` with a
targeted brief: what is missing, where, and the evidence. Do not send
follow-ups to a finished worker.

Record the branch, head SHA and verdict in the plan file.

## 6. Landing the work

Follow the repo's rules from the plan. Defaults when the repo says nothing:

- Each lane ends as a branch. Do not merge, push to the default branch, or
  enable auto-merge without an explicit "merge" from the user.
- If the repo wants one PR per change, start one integration delegate that
  rebases the lane branches into a single branch with one commit per lane,
  runs the full checks, and opens the PR.
- When the PR is ready, say so and stop. The user decides when it merges.

## 7. Status updates

The user follows this one thread, not the workers. After each wake that
changes something, send a short update:

```
Lane A  done     PR-ready on feat/x (abc1234), tests pass (I re-ran them)
Lane B  running  started 12 min ago
Lane C  blocked  needs decision 1

Needs you:
1. <question>. I recommend <answer> because <one line>.
```

Lead with what needs the user. Keep it short.

## 8. Finish

When every lane is `done` or dropped:

- Cancel any delegate still running that you no longer need (`task_cancel`).
- Unwatch any PR you watched.
- Give the final report: what landed (branches, PRs, head SHAs), what you
  checked yourself and how, what was dropped and why, and the open
  questions.
- Leave the plan file in place. It holds the run's decisions.

## Hard rules

- No code edits in the coordinator thread.
- Workers that change files always get their own worktree.
- Every lane is proved by a check the coordinator saw, not by the worker's
  summary.
- Never approve a worker's permission request on the user's behalf.
- Fight scope creep. A finding outside the goal goes to the user as one line:
  do it now as a new lane, or drop it.
