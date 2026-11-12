# cadenway-search-service: Claude Code tooling

This `.claude/` folder ships the Claude Code tooling of cadenway-search-service: **16 agents**,
17 slash commands, 13 rules, 19 skills, 3 hooks, the project
settings and launch configuration. The application launch requires the planned package scripts.

Start from [AGENTS.md](../AGENTS.md) (the rules every assistant follows) and [CLAUDE.md](../CLAUDE.md)
(the Claude entry point).

## Settings (`settings.json`)

- **Hooks** are wired through `${CLAUDE_PROJECT_DIR}` so they resolve from any working directory:
  `guard.mjs` before every `Write` / `Edit` / `MultiEdit`, `guard-git.mjs` before every `Bash` /
  `PowerShell` command, and `format.mjs` after matching edit events for supported files.
  Apply the repository rules across tools.
- **Permissions** allow specific repository commands and read-only Git commands. The project
  denies `Read` on `.env` and `.env.*`. Follow the repository secret-handling rules across tools.
  The project does not pre-approve `git push`, `gh` writes or arbitrary shell commands.
- **Fast mode is off** (`fastMode: false` and `CLAUDE_CODE_DISABLE_FAST_MODE=1`). Agent models and
  efforts are explicit in each agent's frontmatter; do not silently substitute a model.
- **MCP**: `enabledMcpjsonServers` enables `context7` from the root `.mcp.json`.
- **No plugins** are enabled (`enabledPlugins: {}`). The folder is itself a plugin
  (`.claude-plugin/plugin.json`, `hooks/hooks.json`) for installations outside this checkout.

## Working with the sibling repositories

Start from this checkout and attach the peers you need, for example:

```powershell
claude --add-dir ../cadenway-api-contracts ../cadenway-service-kit ../cadenway-ops
```

Their `.claude/agents/` are discovered too, so their `cw-*` roles become available. Peer checkouts
are **read-only** from a cadenway-search-service session (the guard refuses edits there): change them in their
own session and pull request.

## Agents

Builders write only assigned files, inherit permissions and preserve concurrent work. Reviewers are
read-only: their tools exclude `Edit` and `Write`, and they ask the parent for the output of any
check that writes files. No agent delegates further.

| Agent | Responsibility | Model | Effort | Mode |
| --- | --- | --- | --- | --- |
| `cw-search-module-explorer` | Map a module: files, invariants, flows, events, dependencies. | sonnet | medium | Read-only |
| `cw-search-module-builder` | Create a new module skeleton with its MODULE.md. | opus | high | Assigned writes |
| `cw-search-domain-builder` | Pure domain: entities, value objects, invariants, domain events. | opus | high | Assigned writes |
| `cw-search-usecase-builder` | Application use cases: orchestration, transactions, outbox. | sonnet | high | Assigned writes |
| `cw-search-endpoint-builder` | Internal REST routes from the contract. | sonnet | high | Assigned writes |
| `cw-search-event-builder` | Publish and consume events: outbox, idempotency, versions. | opus | high | Assigned writes |
| `cw-search-persistence-builder` | Repositories, mapping, queries and indexes. | sonnet | high | Assigned writes |
| `cw-search-migration-builder` | Expand/contract schema migrations. | sonnet | high | Assigned writes |
| `cw-search-test-writer` | Unit, integration and contract tests. | sonnet | high | Assigned writes |
| `cw-search-deploy-maintainer` | Dockerfile, deploy/compose.yaml, health checks, env. | sonnet | medium | Assigned writes |
| `cw-search-architecture-reviewer` | Layering, ownership, boundaries, contracts. | opus | xhigh | Read-only |
| `cw-search-contract-reviewer` | Code against OpenAPI and AsyncAPI. | opus | high | Read-only |
| `cw-search-security-auditor` | Tenant isolation, authorization, input, secrets, personal data. | opus | xhigh | Read-only |
| `cw-search-observability-reviewer` | Logs, traces, metrics, health. | sonnet | high | Read-only |
| `cw-search-performance-reviewer` | Queries, indexes, pagination, N+1. | sonnet | high | Read-only |
| `cw-search-github-maintainer` | Workflows, templates and community files in .github/. | sonnet | medium | Assigned writes |

## Commands

| Command | What it does | Runs |
| --- | --- | --- |
| `/cw-explore` | Map an existing module before changing it. | `cw-search-module-explorer` |
| `/cw-module` | Create a new module skeleton with its MODULE.md. | `cw-search-module-builder` |
| `/cw-domain` | Add or change a domain rule (pure TypeScript). | `cw-search-domain-builder` |
| `/cw-usecase` | Add a use case (command or query). | `cw-search-usecase-builder` |
| `/cw-endpoint` | Implement an internal route exactly as the contract defines it. | `cw-search-endpoint-builder` |
| `/cw-event` | Publish or consume an event through the outbox. | `cw-search-event-builder` |
| `/cw-persistence` | Implement a repository or a query. | `cw-search-persistence-builder` |
| `/cw-migrate` | Write an expand/contract migration. | `cw-search-migration-builder` |
| `/cw-tests` | Write unit, integration or contract tests. | `cw-search-test-writer` |
| `/cw-deploy` | Change the Dockerfile, deploy/compose.yaml or environment variables. | `cw-search-deploy-maintainer` |
| `/cw-arch-review` | Review layering, ownership and boundaries of the current change. | `cw-search-architecture-reviewer` |
| `/cw-contract-review` | Compare routes and events with cadenway-api-contracts. | `cw-search-contract-reviewer` |
| `/cw-security-review` | Audit tenant isolation, authorization and secrets. | `cw-search-security-auditor` |
| `/cw-observability-review` | Review logs, traces, metrics and health checks. | `cw-search-observability-reviewer` |
| `/cw-perf-review` | Review queries, indexes and pagination. | `cw-search-performance-reviewer` |
| `/cw-github` | Change workflows, templates or community files in .github/. | `cw-search-github-maintainer` |
| `/cw-quality` | Run the local quality gate, stopping at the first failure. | runs the commands itself |

## Rules

| File | Subject | Loads for |
| --- | --- | --- |
| `domain.md` | Domain layer | `src/modules/**/domain/**` |
| `application.md` | Application layer | `src/modules/**/application/**` |
| `infrastructure.md` | Infrastructure layer | `src/modules/**/infrastructure/**` |
| `api.md` | API layer | `src/modules/**/api/**`, `src/**/*.controller.ts` |
| `events.md` | Events | `src/**/*.events.ts`, `src/**/*.handler.ts`, `src/**/*.publisher.ts`, `src/**/events/**` |
| `migrations.md` | Migrations | `migrations/**`, `src/**/migrations/**` |
| `tests.md` | Tests | `**/*.spec.ts`, `test/**` |
| `deploy.md` | Deployment files | `Dockerfile`, `deploy/**`, `compose.dev.yaml`, `.env.example` |
| `module-docs.md` | MODULE.md | `src/modules/**/MODULE.md` |
| `language.md` | Language | always |
| `git-and-commits.md` | Git and commits | always |
| `comments.md` | Comments and docblocks | `src/**/*.ts` |
| `github.md` | GitHub files | `.github/**` |

## Skills

See [skills/](skills/) for the complete inventory, including the technology guides.

| Skill | Use |
| --- | --- |
| `cw-context` | What Cadenway is, where the mockup, the integration guide and the repository map live, the product vocabulary (spaces, lists, sprints, tasks, statuses, milestones) and the multi-repository ownership rules. |
| `cw-search-domain` | The data, rules, events and screens cadenway-search-service owns, taken from the mockup, the integration guide and the repositories document. |
| `cw-hexagonal-module-layout` | Where each kind of code goes in a module (domain, application, infrastructure, api), the naming of files and classes, and the dependency direction. |
| `cw-outbox-and-events` | How to publish and consume events reliably with @cadenway/nest-messaging: outbox in the use case transaction, idempotent handlers, retries, dead letters, versioned names. |
| `cw-contract-first` | The order in which a route or an event change travels: cadenway-api-contracts, then the producing service, then gateways and consumers, then the web app; and how to check the installed contract version. |
| `cw-expand-contract-migrations` | How to change a database schema without breaking the running version: expand, dual-write, backfill, contract in a later release, and how to roll back. |
| `cw-nest-testing` | How to write unit, integration and contract tests in a Cadenway NestJS service: Vitest, disposable PostgreSQL and NATS, mockup-based fixtures. |
| `cw-module-md` | The canonical sections of a module MODULE.md and the changes that make updating it mandatory in the same change. |

## Hooks

| Hook | When | What it refuses or does |
| --- | --- | --- |
| `guard.mjs` | before `Write`, `Edit` or `MultiEdit` | Sibling checkouts, generated trees, lockfiles, `.git/`, secrets and tokens, direct NATS clients, `export *` barrels and sibling-source imports, unpinned third-party actions and `pull_request_target` in workflows. |
| `guard-git.mjs` | before `Bash` or `PowerShell` | Pushes to `main`, tag pushes, force-pushes, rewrites of pushed commits, hook bypasses, destructive resets, registry publishing, branch names outside `<type>/<kebab>`. Adapted from the dentalstock guard. |
| `format.mjs` | after a successful `Write`, `Edit` or `MultiEdit` | Formats supported files with the repository's Prettier; a no-op until the formatter is installed. |
