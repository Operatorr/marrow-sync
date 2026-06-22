# Agent-First Engineering

> How to operate in this repo. Adapted from *"Harness engineering: leveraging
> Codex in an agent-first world"* (Ryan Lopopolo, Feb 11 2026).

You are a coding agent working in an agent-built, agent-maintained codebase.
Humans steer; you execute. Follow these rules — they keep the codebase coherent
without a human reviewing every change.

---

## 1. Core philosophy

- Write everything: logic, tests, CI, docs, tooling, dashboards. Nothing is
  hand-edited by humans.
- When you struggle, don't "try harder" — find the missing capability (tool,
  guardrail, abstraction, doc) and build it.
- The scarce resource is human time and attention. Spend less of it. Corrections
  are cheap; waiting is expensive.
- Work depth-first: break a goal into blocks (design → code → review → test),
  build each, then compose. A blocked goal usually means an underspecified
  environment, not an impossible task.

## 2. Treat the repo as the only thing that exists

You act only on what you can see while running. Chat threads, docs tools, and
human memory don't exist to you.

- Push context into the repo as versioned markdown, schema, or executable plan.
  If it isn't discoverable in the repo, it's invisible.
- Use repository-local, versioned artifacts over any external source of truth.
- Optimize for legibility to the next run over a human's stylistic preference.

## 3. Keep docs a map, not a manual

- `AGENTS.md` is a ~100-line map with pointers, not the encyclopedia.
- Put the real knowledge base in `docs/`, structured and indexed.
- Favor progressive disclosure: a small stable entry point that points to what
  to read next.
- When a guideline keeps getting missed, promote it into a lint, structural
  test, or tool — don't add more prose.

Suggested `docs/` layout (create dirs when the need is real, not speculatively):

```text
AGENTS.md            # ~100-line map; injected into context
ARCHITECTURE.md      # top-level map of domains and package layering
docs/
├── index.md         # catalogue of the knowledge base
├── design-docs/     # indexed designs + verification status + core beliefs
├── exec-plans/      # active/ + completed/ + tech-debt-tracker.md
├── generated/       # machine-generated refs (e.g. db-schema.md)
├── product-specs/   # indexed product specs
└── references/      # vendored llms.txt docs for key dependencies
```

- Treat plans as first-class artifacts. Small changes get ephemeral plans;
  complex work gets an execution plan with progress and decision logs in
  `docs/exec-plans/`.
- Enforce the knowledge base mechanically: linters/CI validate docs are current,
  cross-linked, and structured.

## 4. Make the running app inspectable

Anything you can't access while running doesn't exist. Build the system so you
can observe it.

- Boot the app per git worktree — launch and drive the exact version you edit.
- Use browser control (Chrome DevTools Protocol) for DOM snapshots, screenshots,
  navigation — to reproduce bugs, validate fixes, reason about UI directly.
- Use per-worktree observability (logs via LogQL, metrics via PromQL, traces) to
  answer prompts like *"startup completes under 800ms"* or *"no span in these
  four journeys exceeds two seconds"*.
- Let runs go long — a single task may take many hours. Build feedback loops that
  don't require babysitting.

## 5. Enforce architecture and taste mechanically

Enforce invariants; don't micromanage implementations. You work best inside
strict boundaries with predictable structure.

- Keep rigid per-domain layering; dependencies only flow forward:

  ```text
  Types → Config → Repo → Service → Runtime → UI
  ```

  Cross-cutting concerns (auth, connectors, telemetry, feature flags) enter
  through one interface — **Providers** — and nothing else. Reject the rest
  mechanically.
- Write custom linters, and put remediation instructions in the error messages
  so the fix lands straight in your context.
- Statically enforce taste invariants: structured logging, schema/type naming,
  file-size limits, platform reliability requirements.
- Parse at the boundary; never probe data YOLO-style. Validate shapes at
  boundaries or use typed SDKs. Be strict about *that* input is parsed,
  unopinionated about *how*.
- Keep boundaries central, autonomy local: care deeply about boundaries,
  correctness, reproducibility; within them, express the solution freely.
  Correct, maintainable, legible output meets the bar.

## 6. Prefer dependencies you can model

- Choose "boring" tech — composable, API-stable, well-represented in training —
  over novel or opaque alternatives.
- Reimplement a small opaque subset (100% test coverage, first-class telemetry)
  when that's cheaper than working around an opaque upstream library.

## 7. Merge fast (throughput inverts the norms)

- Keep blocking merge gates minimal and PRs short-lived.
- Re-run a flake; don't let it block indefinitely.
- Corrections are cheap, waiting is expensive — valid here *because* these
  guardrails are real and enforced.

## 8. Review agent-to-agent

- Don't require human review. Drive a PR to completion with a self-correcting
  loop: review your own changes locally, request specific agent reviews (local
  and cloud), respond to all feedback, iterate until every reviewer is satisfied.
- Use standard tools directly (`gh`, local scripts, repo-embedded skills) to
  gather context.

## 9. Garbage-collect entropy continuously

You replicate existing patterns — including uneven ones — so the codebase
drifts. Counter it continuously, not in big Friday bursts.

- Encode golden principles as mechanical rules. E.g.: prefer shared utility
  packages over hand-rolled helpers; never probe data shapes YOLO-style.
- Run background tasks on a cadence to scan for deviations, update quality
  grades, and open targeted refactoring PRs (most reviewable in under a minute).
- Pay debt down in small daily increments, not painful periodic ones.

## 10. Drive features end-to-end

Target loop from a single prompt:

1. Validate the current state of the codebase.
2. Reproduce a reported bug; record a video of the failure.
3. Implement a fix.
4. Validate by driving the app; record a second video of the resolution.
5. Open a pull request.
6. Respond to agent and human feedback.
7. Detect and remediate build failures.
8. Escalate to a human only when judgment is required.
9. Merge the change.

This loop depends on *this* repo's tooling and doesn't generalize without
comparable investment.
