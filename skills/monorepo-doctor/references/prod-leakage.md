# Check 5 — Test code in production

Question: do test files, fixtures or test libraries end up in a published package or a deployable build?
Output: `findings/prod-leakage.json`.

Test files are `scan.packages[p].testFiles` (the scan classifies `*.spec.*`, `*.test.*`, and files under `__tests__/`, `__mocks__/`, `test/`, `tests/`, `e2e/`, or `cypress/`) plus fixture directories (`fixtures?/`) when checking package tarballs and build outputs.
Test libraries: `vitest`, `jest`, `@jest/*`, `mocha`, `chai`, `sinon`, `@testing-library/*`, `cypress`, `playwright`, `@playwright/test`, `msw`, `nock`, `supertest`, `ts-jest`, `@vitest/*`.

## Rules

| id | severity | detect |
|---|---|---|
| `prod-leakage/test-files-in-package` | critical | publishable package (`private !== true`) whose tarball contains test files. |
| `prod-leakage/test-files-in-build-output` | critical | a package's existing build output dir (`dist`, `build`, `lib`, or the tsconfig `outDir`) contains compiled test files (`*.spec.js`, `*.test.js`, `*.spec.d.ts`, …). Only check dirs that exist — never build. |
| `prod-leakage/build-tsconfig-includes-tests` | high | the build tsconfig `include`s the test files' location and its `exclude` doesn't match them. Build tsconfig = file passed via `-p`/`--project` in the `build` script, else `tsconfig.build.json`, else `tsconfig.lib.json`, else `tsconfig.json` when the build script is plain `tsc`. Skip packages with no build script. |
| `prod-leakage/test-lib-in-dependencies` | high (medium if `private`) | a test library appears in `dependencies` (not `devDependencies`). Consumers install it in production. |
| `prod-leakage/publint-issue` | error→high, warning→medium, suggestion→low | `publint` messages for publishable packages. |

## Steps

1. For each publishable package (non-private, `source: package.json`):
   ```bash
   W="$(node -p 'require("os").tmpdir()')/monorepo-doctor"
   (cd "<pkg-dir>" && npm pack --dry-run --json --ignore-scripts 2>/dev/null)
   ```
   Parse `[0].files[].path`; any match of the test pattern → `test-files-in-package` (list up to 10 in `evidence`).
   If `npm pack` fails (e.g. `workspace:` protocol under npm), fall back to reasoning: if the package has no `files` field and no `.npmignore`, every file not in `.gitignore` ships — compare against `scan.packages[p].testFiles`. If `files` is present, test files ship only if a `files` entry matches them. State in `evidence` that the fallback was used.
2. Check existing build output dirs for compiled test files.
3. Resolve each package's build tsconfig and check `include`/`exclude` against `scan.packages[p].testFiles`. Treat `include: ["src"]` as `src/**/*`. Follow `extends` one level for `include`/`exclude` when the file itself has none.
4. Check `dependencies` against the test-library list.
5. If `hasNodeModules`, for each publishable package that has its build output present:
   ```bash
   W="$(node -p 'require("os").tmpdir()')/monorepo-doctor"
   npx --yes publint "<pkg-dir>" 2>&1
   ```
   publint prints sections `Errors:`, `Warnings:`, `Suggestions:` followed by numbered messages. One finding per message. Skip unbuilt packages and set status `partial` with reason `publint skipped for unbuilt packages: …`.
6. Write `findings/prod-leakage.json`.

## Fix guidance

- test-files-in-package: add `"files": ["dist"]` to package.json (preferred over `.npmignore`).
- build-tsconfig-includes-tests: `"exclude": ["**/*.spec.ts", "**/*.test.ts", "**/__tests__/**"]`.
- test-lib-in-dependencies: move it to `devDependencies`.
