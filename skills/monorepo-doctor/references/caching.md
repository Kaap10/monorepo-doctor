# Check 3 — Task caching

Question: will a cache hit ever replay a wrong result, and are tasks re-running when they should hit?
Output: `findings/caching.json`. If no orchestrator is detected, only `caching/uncached-root-script` applies; set status `ok` with reason `no task orchestrator`.

## Facts the rules rely on

- **Turborepo**: a task with no `outputs` caches only logs — on a hit, `dist/` is NOT restored, so downstream tasks see stale or missing files. A package's hash covers its own files, its `package.json`, `turbo.json` and the lockfile; changes in workspace dependencies reach a task's hash **only** through `dependsOn` entries with `^` (e.g. `^build`). Env vars affect the hash only when listed in `env`, `globalEnv` (or `passThroughEnv` for runtime-only); framework prefixes such as `NEXT_PUBLIC_`, `VITE_` are auto-included.
- **Nx**: when `outputs` is omitted, Nx caches `{workspaceRoot}/dist/{projectRoot}`, `{projectRoot}/dist`, `{projectRoot}/build`, `{projectRoot}/public`. Env vars affect the hash only through an `{ "env": "NAME" }` entry in `inputs`. Without a `production` named input that excludes tests, editing a spec file invalidates the build cache.

## Rules

| id | severity | detect |
|---|---|---|
| `caching/missing-outputs` | high | **Turbo**: a cacheable task named `build`/`compile`/`bundle`/`*:build` (or whose package script runs `tsc`, `vite build`, `tsup`, `rollup`, `webpack`, `next build`, `esbuild`) has no `outputs`. Package-level `turbo.json` overrides count. **Nx**: cacheable build-like target without `outputs` whose real out dir (`outDir` in the build tsconfig, `outDir`/`--out-dir` flags, `build.outDir` in vite config) is not one of Nx's defaults — one finding per affected project, with `package`. Turbo findings are per task: `location.file: "turbo.json"`, no `package`. |
| `caching/build-inputs-include-tests` | medium | **Turbo**: build-like task has no `inputs`, or `inputs` that don't exclude test globs (`!**/*.test.*`, `!**/*.spec.*`, `!**/__tests__/**`). **Nx**: no `production` named input, or `build` inputs don't reference it, or `production` doesn't negate test globs. |
| `caching/undeclared-env` | medium | for each `scan.env` entry in a package with a cacheable build/test task: **Turbo**: name not matched by the task's `env`, `globalEnv` or `passThroughEnv` (`*` wildcards; `!` negation) and not framework-prefixed. **Nx**: no `{ "env": NAME }` in the target's inputs (resolve named inputs). Ignore `NODE_ENV`, `CI`, `PATH`, `HOME`, `TZ`, `PWD`. One finding per (package, name), listing up to 5 locations. |
| `caching/turbo-cache-disabled` | medium | Turbo task with `cache: false` that is not `persistent: true` and whose name isn't `dev`, `start`, `serve`, `watch`, `deploy`, `release`, `publish`, `clean`. |
| `caching/unstable-hash` | high | turbo installed: run `npx turbo run build --dry=json` twice; any task whose `hash` differs between runs. Report the task and the `inputs`/`environmentVariables` that differ. |
| `caching/volatile-input` | high | task `inputs` or `globalDependencies` include build artifacts or machine-local files: `dist`, `build`, `.turbo`, `.nx`, `*.tsbuildinfo`, `.env.local`, `**/*.log`, `node_modules`. |
| `caching/uncached-root-script` | low | a root `package.json` script that runs tasks across packages bypassing the orchestrator: `-r`/`--recursive`, `--workspaces`/`-ws`, `yarn workspaces foreach`, `lerna run`. In repos **without** an orchestrator, say "consider adding Nx or Turborepo" in `fix`. |

## Steps

1. Read `turbo.json` (and `<pkg>/turbo.json` overrides with `"extends": ["//"]`) and/or `nx.json` + every `project.json` / `package.json#nx`. For Nx, also read `targetDefaults` and `namedInputs`, and remember that Nx plugins (`plugins` in `nx.json`) can infer targets — if a target exists only via plugin inference, report rules that depend on its config as `partial` and say so.
2. Apply the rules above. Quote the exact JSON in `evidence` (task name + its config object). Config-level findings (Turbo tasks, Nx `targetDefaults`/`namedInputs`) omit `location.package`; only set `package` when the problem is specific to one package (e.g. its own `turbo.json`/`project.json`, or an env read in its source).
3. `unstable-hash` runs only when turbo is installed; otherwise mark the check `partial` with reason `turbo not installed; dry-run hash comparison skipped`. Never run real tasks — only `--dry=json`.
4. Write `findings/caching.json`.

## Fix guidance

- missing-outputs (Turbo): `"outputs": ["dist/**"]` (add `".next/**", "!.next/cache/**"` for Next.js).
- missing-outputs (Nx): `"outputs": ["{projectRoot}/lib"]` matching the real out dir.
- build-inputs-include-tests (Nx): `"namedInputs": { "production": ["default", "!{projectRoot}/**/*.spec.ts", "!{projectRoot}/**/*.test.ts"] }` and `"build": { "inputs": ["production", "^production"] }`.
- build-inputs-include-tests (Turbo): `"inputs": ["$TURBO_DEFAULT$", "!**/*.test.*", "!**/*.spec.*"]`.
- undeclared-env: Turbo `"env": ["API_URL"]`; Nx `"inputs": ["production", { "env": "API_URL" }]`.
