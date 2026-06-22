# AGENTS.md

A **map, not a manual**. Injected into agent context, so it stays short and
points to the real sources of truth in [`docs/`](docs/index.md).

## How we build here

Built and maintained primarily by coding agents. **Humans steer; agents
execute.** No code written by hand — prompt for changes. Read the operating
principles first:

- **[Agent-First Engineering](docs/agent-first-engineering.md)** — the rules of
  the road. Read this first.

Key invariants (that doc is authoritative):

- The repository is the system of record. Knowledge not in the repo is invisible
  to the agent — push it in as versioned markdown, schemas, or plans.
- Keep this file a short table of contents. Real knowledge lives in `docs/`.
- Enforce architecture and taste mechanically (custom linters, structural
  tests), not by adding prose.
- Parse data at boundaries; never build on guessed shapes.
- Optimize for the scarce resource: human time and attention.

## Where things live

- [`docs/`](docs/index.md) — knowledge base / system of record (start here).
- [`docs/agent-first-engineering.md`](docs/agent-first-engineering.md) — operating principles.
- `.agents/skills/` — repo-embedded skills agents invoke directly.
- `client/` — frontend code.
- `server/` — backend code.
