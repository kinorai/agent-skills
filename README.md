# Agent Skills

A collection of reusable skills for Claude Code — portable across any project or cluster.

## Skills

| Skill | Description |
|-------|-------------|
| [helm-generic-checklist](helm-generic-checklist/) | Universal Helm chart quality checklist. Covers release naming, chart versioning, resources, probes, security, persistence, networking, scaling, RBAC, observability, and common pitfalls. |
| [performant-infinite-scroll](performant-infinite-scroll/) | Production-grade infinite scroll for React / Next.js: cursor pagination + TanStack Query, virtualization (TanStack Virtual, virtua, react-virtuoso), prefetching ahead of the edge, App Router SSR, scroll restoration, bidirectional chat, and accessibility. |
| [ui-filmstrip](ui-filmstrip/) | Watch a web UI move frame by frame: Chrome screencast recordings laid out as filmstrip PNGs, with layout shifts and late text swaps, to find flicker, jumps and broken states online, slow, in airplane mode and offline (Toxiproxy). |
| [ship](ship/) | `/ship` a pull request: wait for green CI, run one `/code-review medium --fix`, re-check and push the fixes, wait for CI, merge, then audit the default-branch run logs for errors, warnings, flaky tests, and slow steps. User-invoked only. |
| [t3-coordinator](t3-coordinator/) | `/t3-coordinator` or `$t3-coordinator` in a [T3 Code](https://github.com/pingdotgg/t3code) thread: plan the goal into lanes, run each lane as a `delegate_task` worker in its own worktree, answer their questions, check their diffs and tests, and bring you only the real decisions. Needs Orchestrator V2 (T3 Code v0.1.0+). User-invoked only. |

## Installation

Clone the repo and symlink the skills you want into `~/.claude/skills/`:

```bash
git clone git@github.com:kinorai/agent-skills.git ~/perso/agent-skills

# Symlink individual skills
ln -sf ~/perso/agent-skills/helm-generic-checklist ~/.claude/skills/helm-generic-checklist
```

## Usage

Skills are automatically triggered by Claude Code based on context. You can also reference them explicitly in conversation.

## Contributing

Each skill lives in its own directory with a `SKILL.md` file. Optional subdirectories:
- `references/` — docs loaded into context as needed
- `scripts/` — executable code for deterministic tasks
- `assets/` — templates, icons, fonts

## License

MIT
