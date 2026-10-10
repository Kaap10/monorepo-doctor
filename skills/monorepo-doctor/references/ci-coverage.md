# Check 4 — CI test coverage

Question: can a change land without the tests that cover it running in CI?
Inputs: `workspace.json` (`ciFiles`), `scan.json`. Output: `findings/ci-coverage.json`.

## Rules

| id | severity | detect |
|---|---|---|
| `ci-coverage/undeclared-workspace-dependency` | critical (medium when Nx is an orchestrator, since Nx infers edges from imports) | `scan.imports` entry with `declared: false` and `isTest: false`, importing package's `source` is `package.json`. Affected/filtered runs and `^` caching won't treat the importer as depending on the target, so changing the target skips the importer's tests. One finding per (from, target) pair. |
| `ci-coverage/missing-test-script` | high | package has `scan.packages[p].testFiles.length > 0` but `hasTestScript` is false and no test target exists (Nx: `nxTargets.test`, or an inferred test plugin in `nx.json#plugins` such as `@nx/vite/plugin`, `@nx/jest/plugin`, `@nx/vitest`). Its tests never run. |
| `ci-coverage/tests-not-run-in-ci` | high | no CI file matches `/\b(npm\|pnpm\|yarn\|bun\|npx\|nx\|turbo)\b[^\n]*\btest\b\|\b(vitest\|jest\|mocha)\b/`. If `ciFiles` is empty, report with `location.file: "(none)"` and evidence "no CI configuration found". |
| `ci-coverage/shallow-checkout-affected` | high | a GitHub Actions job runs `nx affected`, `turbo … --affected`, or `--filter=…[<ref>]`, uses `actions/checkout` and does **not** set `fetch-depth: 0` (default depth 1 makes the base ref unavailable → everything or nothing is "affected"). |
| `ci-coverage/nx-affected-base-missing` | high | `nx affected` in CI with no `--base`, no `nrwl/nx-set-shas` step, and no `NX_BASE` env. |
| `ci-coverage/nx-test-inputs-ignore-deps` | high | Nx `test` target (targetDefaults or project) is cacheable and its `inputs` have no `^`-prefixed entry — a change in a dependency replays a cached pass. |
| `ci-coverage/turbo-test-missing-dependson` | high | Turbo `test` (or `*:test`) task is cacheable and `dependsOn` has no `^` entry — dependency changes don't change the test hash, so a cached pass is replayed. |

## Steps

1. Read every file in `ciFiles`. For GitHub Actions, reason per job: a checkout step's `with.fetch-depth` applies to the steps after it in the same job.
2. Resolve Nx targets as in caching (targetDefaults merged with project config). Resolve Turbo tasks from `turbo.json` and package overrides.
3. Apply the rules; quote the CI step / config object as `evidence`.
4. Write `findings/ci-coverage.json`.

## Fix guidance

- undeclared-workspace-dependency: add `"<target>": "workspace:*"` (pnpm/yarn/bun) or `"*"` (npm) to the importer's dependencies, and import via the package name.
- shallow-checkout-affected: `with: { fetch-depth: 0 }` on `actions/checkout`.
- nx-affected-base-missing: add `- uses: nrwl/nx-set-shas@v4` before `nx affected`.
- nx-test-inputs-ignore-deps: `"test": { "inputs": ["default", "^production"] }`.
- turbo-test-missing-dependson: `"test": { "dependsOn": ["^build"] }` (or `["^test"]` when tests run on sources).
