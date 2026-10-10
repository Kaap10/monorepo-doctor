# monorepo-doctor — Design Spec

**Date:** 2026-10-10
**Status:** Approved (brainstorming)

## Problem

Teams running JS/TS monorepos repeatedly hit the same failures:

1. Code is not split into well-bounded packages/libs (oversized packages, deep imports past public APIs).
2. Circular dependencies get introduced between packages and files.
3. Task caching is misconfigured, so tasks re-run when they should hit cache.
4. Tests silently don't run on CI because of imports that bypass the package graph or bad cache inputs.
5. Test files, fixtures, or test-only dependencies ship to production artifacts.

## Prior art (research, 2026-10-10)

- `nrwl/nx-ai-agents-config` skills (`nx-workspace`, `nx-cloud-cache-investigator`, `nx-run-tasks`): exploration and single-incident cache diagnosis; no repo-wide audit.
- `vercel/turborepo` `skills/turborepo`: a pointer to Turborepo docs; no audit.
- Non-AI tools cover single concerns: `madge`, `dependency-cruiser` (cycles), `knip` (unused/undeclared deps), `publint` (package publishing), `@nx/enforce-module-boundaries`, `turbo boundaries`.

No skill audits all five problems across generic workspaces, Nx, and Turborepo. That is the gap this skill fills.

## Goals

- A single agent skill that audits a monorepo for the five problems and produces a prioritized report.
- Works on any JS/TS workspace (npm/yarn/pnpm/bun workspaces); adds deeper checks when Nx or Turborepo is detected.
- Read-only and CI-friendly.

## Non-goals

- Auto-fixing anything. Findings include fix hints only.
- Bundled scripts or a standalone CLI. The skill orchestrates existing CLIs via `npx`/`pnpm dlx`/`yarn dlx`/`bunx`, with agent-driven file analysis as the fallback.
- Non-JS monorepos (Bazel, Gradle, Cargo workspaces).
- SARIF output (possible later).

## Distribution

A standalone GitHub repo, `santoshyadavdev/monorepo-doctor`, installable via `npx skills add santoshyadavdev/monorepo-doctor` and usable by Claude Code, Copilot CLI, and other agents that support SKILL.md.

## Repository layout

```
monorepo-doctor/
  skills/monorepo-doctor/
    SKILL.md               # trigger description + 3-phase workflow
    references/
      detection.md         # workspace type, package manager, package inventory
      boundaries.md        # check 1
      circular-deps.md     # check 2
      caching.md           # check 3
      ci-coverage.md       # check 4
      prod-leakage.md      # check 5
      report-format.md     # MD + JSON schema, severity rubric
  fixtures/
    generic-pnpm/          # seeded with known issues
    nx/
    turborepo/
    expected/<fixture>.json  # expected finding ids per fixture
  README.md
  LICENSE (MIT)
```

`SKILL.md` stays short and holds the workflow. Each check's procedure lives in its own reference file, which the agent loads only when it runs that check.

## Workflow

1. **Detect** (`detection.md`)
   - Package manager from lockfile (`pnpm-lock.yaml`, `yarn.lock`, `package-lock.json`, `bun.lock[b]`).
   - Workspace globs from `pnpm-workspace.yaml` or root `package.json#workspaces`.
   - Orchestrator: `nx.json` means Nx; `turbo.json` means Turborepo; both is allowed; neither means generic.
   - Inventory: name, path, and `private` flag of every package, plus its declared deps on other workspace packages.
   - Pick the runner (`pnpm dlx` / `yarn dlx` / `bunx` / `npx`) to match the package manager.
2. **Run checks**
   - Default: all five. The user may scope the audit to a subset (e.g. "only circular deps").
   - For each check, read its reference file and follow it.
   - Run tool-specific steps only when that tool was detected.
3. **Report** (`report-format.md`)
   - Write `monorepo-doctor-report.md` and `monorepo-doctor-report.json` to the repo root, or to a user-specified path.
   - CI mode, when requested: after writing the reports, exit non-zero (via a final shell command) if any finding is at or above the chosen severity threshold (default `high`).

## Checks

| # | Check | Generic (always) | Nx extras | Turborepo extras |
|---|---|---|---|---|
| 1 | Boundaries / splitting | Oversized packages (thresholds: >500 source files or >50k LOC → `low`); cross-package imports into `src/` instead of the package entry or `exports` (`medium`); undeclared or unused deps via `knip` | `@nx/enforce-module-boundaries` missing from ESLint config, or projects without `tags` | `turbo boundaries` violations |
| 2 | Circular deps | Workspace package-graph cycles from `package.json` deps (`high`); file-level cycles via `madge --circular --extensions ts,tsx,js,jsx` per package (`medium`) | Cycles in `nx graph --file=<tmp>.json` | Cycles in the `turbo run build --dry=json` task graph |
| 3 | Caching | Root scripts that chain full builds with no caching layer (`low`) | Cacheable targets missing `outputs`; `production` namedInput missing or not excluding tests; env vars read in code but absent from `inputs` (`medium`/`high`) | Tasks missing `outputs`; `env`/`globalEnv` gaps; `cache: false` on deterministic tasks; two consecutive `--dry=json` runs with differing hashes, diffed to find the unstable input (`high`) |
| 4 | Missed tests in CI | Relative (`../../other-pkg`) or tsconfig-path imports that cross packages with no declared dep, so affected-only CI misses dependents (`critical`); packages with test files but no `test` script (`high`) | `affected` base/head setup in CI workflow files; `test` inputs not covering source files | `test` task missing `dependsOn`/`inputs`; `--filter=[<ref>]` usage in CI workflow files |
| 5 | Prod leakage | `publint` on each publishable (non-private) package; `npm pack --dry-run --json` contents containing `*.spec.*`, `*.test.*`, `__tests__`, `__mocks__`, fixtures (`critical`); build `tsconfig` including test files (`high`); test libraries in `dependencies` instead of `devDependencies` (`high`) | Build target inputs or outputs including test files | Build task inputs or outputs including test files |

The CI workflow files scanned are `.github/workflows/*`, `.gitlab-ci.yml`, `azure-pipelines.yml`, and `.circleci/config.yml`.

## Severity rubric

- **critical**: tests never run in CI, or test code ships to production.
- **high**: package-level circular deps, wrong cache outputs or unstable hashes, test libraries in prod `dependencies`.
- **medium**: imports that bypass a package's public API, file-level cycles, env vars missing from cache inputs.
- **low**: size and hygiene suggestions.

## Report format

JSON (`monorepo-doctor-report.json`):

```json
{
  "version": 1,
  "generatedAt": "ISO-8601",
  "workspace": { "packageManager": "pnpm", "orchestrators": ["nx"], "packageCount": 12 },
  "summary": { "critical": 0, "high": 0, "medium": 0, "low": 0 },
  "checks": [{ "id": "circular-deps", "status": "ran|skipped|partial", "reason": "string?" }],
  "findings": [{
    "id": "circular-deps/package-cycle",
    "check": "circular-deps",
    "severity": "high",
    "title": "string",
    "location": { "file": "path", "line": 1, "package": "name" },
    "evidence": "string (command output excerpt or snippet)",
    "fix": "string"
  }]
}
```

Each check's reference file defines its finding `id`s, so results are stable and comparable across runs.

Markdown (`monorepo-doctor-report.md`) contains a header with workspace facts, a summary table by severity, the status of each check, then findings grouped by check and sorted by severity.

## Error handling

- If a tool is unavailable or fails, the check is marked `skipped` or `partial` with the reason, and the audit continues. Where possible, a manual fallback is used (e.g. grep-based import scan instead of `madge`).
- The skill never runs `install`, `build`, `test`, or any command that writes outside the report files and the OS temp dir. `npm pack --dry-run` and `turbo --dry` are allowed because they write nothing.
- If no workspace is detected, the skill stops and reports that clearly.

## Testing

- Three fixture repos (`generic-pnpm`, `nx`, `turborepo`), each seeded with at least one issue per check, plus a clean control package.
- `fixtures/expected/<fixture>.json` lists the finding `id`s each fixture must produce.
- Verification: run the skill against each fixture with a subagent, then confirm that every expected `id` appears and the clean package has no findings.

## Open questions

None.

## Implementation notes (decided during planning)

1. External CLIs run via `npx --yes` (ships with Node; no global installs).
2. `npx nx` / `npx turbo` only run when `node_modules/.bin/nx|turbo` exists; otherwise static config analysis and the check is marked `partial`.
3. A shared source-scan phase (`references/scan.md`) produces imports, intra-package file edges, env reads, test files and size for all checks.
4. File-level cycles use the built-in scan (skips `import type`) instead of madge.
5. "Build inputs include tests" moved from prod-leakage to caching as `caching/build-inputs-include-tests`.
6. Added `prod-leakage/test-files-in-build-output`.
7. Added check status `not-run` for user-scoped audits.
8. Checks write `findings/<check>.json`; a render snippet produces both reports.
9. `ci-coverage/test-inputs-incomplete` renamed `ci-coverage/nx-test-inputs-ignore-deps`.
10. Config-level findings (Turbo tasks, Nx targetDefaults) carry no `location.package`.
