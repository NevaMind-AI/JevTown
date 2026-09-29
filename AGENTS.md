# JevTown · Agent Guide

## Branches and PRs

- `main` is the main branch. Unless told otherwise, branch from the latest `origin/main` and open
  PRs against `main`.
- `feat/agentic` is the development branch for agentic features. Agentic work branches from
  `feat/agentic` and its PRs target `feat/agentic`.
- Pass `--base` explicitly when creating a PR instead of relying on the repository default.
- Only integrate `feat/agentic` into `main` when the user asks for it.
- Preserve local changes unrelated to the task, and don't rewrite published history.

## CI

PRs into `main` run these checks:

- Format: `npm run fmt:check` (Prettier; `npm run fmt` fixes it)
- Lint: `npm run lint`
- Typecheck: `npx tsc --noEmit`
- Unit tests: `npm test`
- PR title validation (see below)

`npm install` sets `core.hooksPath` to `.githooks`. The pre-commit hook then runs Prettier on staged
files.

## Docs

- `docs/` is open for new and updated documents. Update design docs when the design they describe
  changes.
- Numbered design docs use `docs/NN-topic.md`. Commit subjects may cite the section they implement,
  e.g. `(docs/13 §2)`.
- Keep player-facing explanations separate from design and architecture docs.

## Commits and PRs

- Use the `<gitmoji> <type>: <subject>` style for commit subjects and PR titles, e.g.
  `📝 docs: restructure the README around the two modes`.
- Types: `feat`, `fix`, `docs`, `refactor`, `perf`, `dx`, `workflow`, `wip`, `test`, `types`, `ci`,
  `chore`, `deps`, `release`, `build`. An optional scope is allowed: `🐛 fix(engine): ...`.
- CI enforces this format on PR titles only (the gitmoji is optional there). Commit messages are not
  checked, but should follow the same style.
- Fill in `.github/pull_request_template.md` for PR descriptions; don't delete it.
- Stage only the files the task touched.
- Agent-assisted commits end with the agent's `Co-authored-by` trailer, separated from the body by a
  blank line. Before pushing, confirm it with `git log -1 --format=%B`.
