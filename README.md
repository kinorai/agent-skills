# Agent Skills

A collection of reusable skills for Claude Code — portable across any project or cluster.

## Skills

| Skill | Description |
|-------|-------------|
| [helm-generic-checklist](helm-generic-checklist/) | Universal Helm chart quality checklist. Covers release naming, chart versioning, resources, probes, security, persistence, networking, scaling, RBAC, observability, and common pitfalls. |
| [performant-infinite-scroll](performant-infinite-scroll/) | Production-grade infinite scroll for React / Next.js: cursor pagination + TanStack Query, virtualization (TanStack Virtual, virtua, react-virtuoso), prefetching ahead of the edge, App Router SSR, scroll restoration, bidirectional chat, and accessibility. |

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
